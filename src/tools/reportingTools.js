import { z } from 'zod';
import {
  searchStream,
  buildDateClause,
  fromMicros,
  escapeGaqlString,
  mcpToolHandler
} from '../googleAdsClient.js';

const commonReportParams = {
  customer_id: z.string().optional().describe('Target Google Ads customer ID (defaults to config.json).'),
  login_customer_id: z.string().optional().describe('Optional MCC login-customer-id override.'),
  date_range: z
    .enum([
      'TODAY',
      'YESTERDAY',
      'LAST_7_DAYS',
      'LAST_14_DAYS',
      'LAST_30_DAYS',
      'THIS_MONTH',
      'LAST_MONTH',
      'LAST_BUSINESS_WEEK',
      'THIS_WEEK_MON_TODAY',
      'LAST_WEEK_MON_SUN'
    ])
    .optional()
    .default('LAST_30_DAYS')
    .describe('Predefined GAQL date range macro (ignored if start_date and end_date are both provided).'),
  start_date: z.string().optional().describe('Explicit start date YYYY-MM-DD (requires end_date).'),
  end_date: z.string().optional().describe('Explicit end date YYYY-MM-DD (requires start_date).'),
  limit: z.number().int().min(1).max(10000).optional().default(200).describe('Maximum rows returned.'),
  api_version: z.string().optional()
};

function statusClause(field, statuses) {
  if (!statuses || !statuses.length) return '';
  const quoted = statuses.map((s) => `'${escapeGaqlString(s)}'`).join(', ');
  return `AND ${field} IN (${quoted})`;
}

export function registerReportingTools(server) {
  // 1. Campaign Report
  server.registerTool(
    'report_campaigns',
    {
      title: 'Campaign Report',
      description:
        'Fetches comprehensive campaign performance & configuration report (channel type, status, bidding strategy, budget, Target CPA/ROAS, clicks, impressions, cost, conversions, conversion value, ROAS).',
      inputSchema: {
        ...commonReportParams,
        statuses: z.array(z.enum(['ENABLED', 'PAUSED', 'REMOVED'])).optional().default(['ENABLED', 'PAUSED']),
        channel_type: z
          .enum(['SEARCH', 'PERFORMANCE_MAX', 'DEMAND_GEN', 'DISPLAY', 'SHOPPING', 'VIDEO', 'ALL'])
          .optional()
          .default('ALL')
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const channelWhere =
        args.channel_type && args.channel_type !== 'ALL'
          ? `AND campaign.advertising_channel_type = '${args.channel_type}'`
          : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.serving_status,
          campaign.primary_status,
          campaign.advertising_channel_type,
          campaign.advertising_channel_sub_type,
          campaign.bidding_strategy_type,
          campaign.campaign_budget,
          campaign_budget.amount_micros,
          campaign.maximize_conversions.target_cpa_micros,
          campaign.target_cpa.target_cpa_micros,
          campaign.maximize_conversion_value.target_roas,
          campaign.target_roas.target_roas,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.all_conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM campaign
        WHERE ${dateWhere}
          ${statusClause('campaign.status', args.statuses)}
          ${channelWhere}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      const res = await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      res.results = res.results.map((r) => ({
        ...r,
        computed: {
          cost: fromMicros(r.metrics?.costMicros),
          budgetDaily: fromMicros(r.campaignBudget?.amountMicros),
          avgCpc: fromMicros(r.metrics?.averageCpc),
          cpa: fromMicros(r.metrics?.costPerConversion),
          roas:
            fromMicros(r.metrics?.costMicros) > 0
              ? Number(((r.metrics?.conversionsValue || 0) / fromMicros(r.metrics?.costMicros)).toFixed(2))
              : 0
        }
      }));
      return res;
    })
  );

  // 2. Ad Group Report
  server.registerTool(
    'report_ad_groups',
    {
      title: 'Ad Group Report',
      description:
        'Fetches ad group performance & bid settings report (CPC bid, Target CPA/ROAS, status, optimized targeting, impressions, clicks, cost, conversions).',
      inputSchema: {
        ...commonReportParams,
        campaign_id: z.string().optional().describe('Filter by specific campaign ID.'),
        statuses: z.array(z.enum(['ENABLED', 'PAUSED', 'REMOVED'])).optional().default(['ENABLED', 'PAUSED'])
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          campaign.advertising_channel_type,
          ad_group.id,
          ad_group.name,
          ad_group.type,
          ad_group.status,
          ad_group.cpc_bid_micros,
          ad_group.target_cpa_micros,
          ad_group.effective_target_cpa_micros,
          ad_group.target_roas,
          ad_group.effective_target_roas,
          ad_group.optimized_targeting_enabled,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.all_conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM ad_group
        WHERE ${dateWhere}
          ${statusClause('ad_group.status', args.statuses)}
          ${campFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 3. Ad Report
  server.registerTool(
    'report_ads',
    {
      title: 'Ad Report',
      description:
        'Fetches detailed ad report from ad_group_ad including headlines, descriptions, final URLs, ad strength, policy approval status, and performance metrics across RSA, RDA, Demand Gen, and Call Ads.',
      inputSchema: {
        ...commonReportParams,
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        ad_type: z
          .enum([
            'ALL',
            'RESPONSIVE_SEARCH_AD',
            'RESPONSIVE_DISPLAY_AD',
            'DEMAND_GEN_MULTI_ASSET_AD',
            'DEMAND_GEN_VIDEO_RESPONSIVE_AD',
            'CALL_AD'
          ])
          .optional()
          .default('ALL'),
        statuses: z.array(z.enum(['ENABLED', 'PAUSED', 'REMOVED'])).optional().default(['ENABLED', 'PAUSED'])
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const agFilter = args.ad_group_id ? `AND ad_group.id = ${escapeGaqlString(args.ad_group_id)}` : '';
      const typeFilter = args.ad_type && args.ad_type !== 'ALL' ? `AND ad_group_ad.ad.type = '${args.ad_type}'` : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group_ad.ad.id,
          ad_group_ad.ad.name,
          ad_group_ad.ad.type,
          ad_group_ad.status,
          ad_group_ad.ad_strength,
          ad_group_ad.policy_summary.approval_status,
          ad_group_ad.policy_summary.review_status,
          ad_group_ad.ad.final_urls,
          ad_group_ad.ad.responsive_search_ad.headlines,
          ad_group_ad.ad.responsive_search_ad.descriptions,
          ad_group_ad.ad.responsive_search_ad.path1,
          ad_group_ad.ad.responsive_search_ad.path2,
          ad_group_ad.ad.responsive_display_ad.headlines,
          ad_group_ad.ad.responsive_display_ad.long_headline,
          ad_group_ad.ad.responsive_display_ad.descriptions,
          ad_group_ad.ad.responsive_display_ad.business_name,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.all_conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM ad_group_ad
        WHERE ${dateWhere}
          ${statusClause('ad_group_ad.status', args.statuses)}
          ${campFilter}
          ${agFilter}
          ${typeFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 4. Asset Group Report (Performance Max)
  server.registerTool(
    'report_asset_groups',
    {
      title: 'Asset Group Report (Performance Max)',
      description:
        'Fetches Performance Max Asset Groups including ad strength, status, final URLs, metrics, and optionally linked assets (headlines, long headlines, descriptions, images, videos) + signals.',
      inputSchema: {
        ...commonReportParams,
        campaign_id: z.string().optional(),
        include_assets: z.boolean().optional().default(true).describe('Also fetch linked asset_group_asset items.'),
        include_signals: z.boolean().optional().default(true).describe('Also fetch asset_group_signal search themes & audiences.')
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const groupQuery = `
        SELECT
          campaign.id,
          campaign.name,
          asset_group.id,
          asset_group.name,
          asset_group.resource_name,
          asset_group.status,
          asset_group.primary_status,
          asset_group.ad_strength,
          asset_group.final_urls,
          asset_group.path1,
          asset_group.path2,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM asset_group
        WHERE ${dateWhere}
          AND asset_group.status IN ('ENABLED', 'PAUSED')
          ${campFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      const groups = await searchStream(groupQuery, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });

      if (args.include_assets) {
        const assetQuery = `
          SELECT
            asset_group.id,
            asset_group_asset.field_type,
            asset_group_asset.status,
            asset_group_asset.performance_label,
            asset.id,
            asset.name,
            asset.type,
            asset.text_asset.text,
            asset.youtube_video_asset.youtube_video_id,
            asset.image_asset.full_size.url
          FROM asset_group_asset
          WHERE asset_group_asset.status IN ('ENABLED', 'PAUSED')
            ${campFilter}
          LIMIT 2000
        `;
        const assets = await searchStream(assetQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        });
        groups.linkedAssets = assets.results;
      }

      if (args.include_signals) {
        const signalQuery = `
          SELECT
            asset_group.id,
            asset_group_signal.resource_name,
            asset_group_signal.audience.audience,
            asset_group_signal.search_theme.text
          FROM asset_group_signal
          ${campFilter ? `WHERE ${campFilter.replace(/^AND /, '')}` : ''}
          LIMIT 1000
        `;
        const signals = await searchStream(signalQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        });
        groups.signals = signals.results;
      }

      return groups;
    })
  );

  // 5. Keyword Report
  server.registerTool(
    'report_keywords',
    {
      title: 'Keyword Report',
      description:
        'Fetches keyword performance, Quality Score (creative, landing page, expected CTR), CPC estimates (first page, top of page, first position), match types, and conversions.',
      inputSchema: {
        ...commonReportParams,
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        match_type: z.enum(['ALL', 'BROAD', 'PHRASE', 'EXACT']).optional().default('ALL'),
        statuses: z.array(z.enum(['ENABLED', 'PAUSED', 'REMOVED'])).optional().default(['ENABLED', 'PAUSED'])
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const agFilter = args.ad_group_id ? `AND ad_group.id = ${escapeGaqlString(args.ad_group_id)}` : '';
      const mtFilter =
        args.match_type && args.match_type !== 'ALL'
          ? `AND ad_group_criterion.keyword.match_type = '${args.match_type}'`
          : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group_criterion.criterion_id,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          ad_group_criterion.approval_status,
          ad_group_criterion.effective_cpc_bid_micros,
          ad_group_criterion.quality_info.quality_score,
          ad_group_criterion.quality_info.creative_quality_score,
          ad_group_criterion.quality_info.post_click_quality_score,
          ad_group_criterion.quality_info.search_predicted_ctr,
          ad_group_criterion.position_estimates.first_page_cpc_micros,
          ad_group_criterion.position_estimates.top_of_page_cpc_micros,
          ad_group_criterion.position_estimates.first_position_cpc_micros,
          ad_group_criterion.final_urls,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM keyword_view
        WHERE ${dateWhere}
          AND ad_group_criterion.negative = FALSE
          ${statusClause('ad_group_criterion.status', args.statuses)}
          ${campFilter}
          ${agFilter}
          ${mtFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 6. Search Term Report
  server.registerTool(
    'report_search_terms',
    {
      title: 'Search Term Report',
      description:
        'Fetches actual user search terms from search_term_view including ADDED/EXCLUDED/NONE status, impressions, clicks, cost, conversions, and CPA — ideal for mining new keywords or negative exclusions.',
      inputSchema: {
        ...commonReportParams,
        campaign_id: z.string().optional(),
        ad_group_id: z.string().optional(),
        search_term_status: z.enum(['ALL', 'ADDED', 'EXCLUDED', 'NONE', 'ADDED_EXCLUDED']).optional().default('ALL'),
        min_impressions: z.number().int().min(0).optional().default(0)
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const agFilter = args.ad_group_id ? `AND ad_group.id = ${escapeGaqlString(args.ad_group_id)}` : '';
      const stStatus =
        args.search_term_status && args.search_term_status !== 'ALL'
          ? `AND search_term_view.status = '${args.search_term_status}'`
          : '';
      const minImp = args.min_impressions > 0 ? `AND metrics.impressions >= ${args.min_impressions}` : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          search_term_view.search_term,
          search_term_view.status,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM search_term_view
        WHERE ${dateWhere}
          ${campFilter}
          ${agFilter}
          ${stStatus}
          ${minImp}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 7. Times Report
  server.registerTool(
    'report_times',
    {
      title: 'Times & Dayparting Report',
      description:
        'Breaks down performance by time dimensions: HOUR (0-23), DAY_OF_WEEK, HOUR_AND_DAY_OF_WEEK, DATE (daily time series), WEEK, or MONTH.',
      inputSchema: {
        ...commonReportParams,
        granularity: z
          .enum(['HOUR', 'DAY_OF_WEEK', 'HOUR_AND_DAY_OF_WEEK', 'DATE', 'WEEK', 'MONTH'])
          .optional()
          .default('DAY_OF_WEEK'),
        campaign_id: z.string().optional(),
        limit: z.number().int().min(1).max(10000).optional().default(500)
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const segmentMap = {
        HOUR: 'segments.hour',
        DAY_OF_WEEK: 'segments.day_of_week',
        HOUR_AND_DAY_OF_WEEK: 'segments.day_of_week, segments.hour',
        DATE: 'segments.date',
        WEEK: 'segments.week',
        MONTH: 'segments.month'
      };
      const segFields = segmentMap[args.granularity] || 'segments.day_of_week';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ${segFields},
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM campaign
        WHERE ${dateWhere}
          AND campaign.status IN ('ENABLED', 'PAUSED')
          ${campFilter}
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 8. Location Report
  server.registerTool(
    'report_locations',
    {
      title: 'Location & Geo Performance Report',
      description:
        'Fetches geographic performance breakdown via geographic_view (targeted regions & geo constants) or user_location_view (physical user presence) or distance_view.',
      inputSchema: {
        ...commonReportParams,
        view_type: z
          .enum(['GEOGRAPHIC_VIEW', 'USER_LOCATION_VIEW', 'DISTANCE_VIEW'])
          .optional()
          .default('GEOGRAPHIC_VIEW'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      let query;
      if (args.view_type === 'USER_LOCATION_VIEW') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            user_location_view.country_criterion_id,
            user_location_view.targeting_location,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.cost_per_conversion
          FROM user_location_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${args.limit}
        `;
      } else if (args.view_type === 'DISTANCE_VIEW') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            distance_view.distance_bucket,
            distance_view.metric_system,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions
          FROM distance_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${args.limit}
        `;
      } else {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            geographic_view.country_criterion_id,
            geographic_view.location_type,
            geographic_view.resource_name,
            segments.geo_target_region,
            segments.geo_target_city,
            metrics.impressions,
            metrics.clicks,
            metrics.ctr,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value,
            metrics.cost_per_conversion
          FROM geographic_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${args.limit}
        `;
      }
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 9. Impression Share Report
  server.registerTool(
    'report_impression_share',
    {
      title: 'Impression Share & Auction Loss Report',
      description:
        'Reports Search & Content Impression Share, Top / Absolute Top Impression Share, Budget Lost IS, Rank Lost IS, and Exact Match IS at Campaign, Ad Group, or Keyword level.',
      inputSchema: {
        ...commonReportParams,
        level: z.enum(['CAMPAIGN', 'AD_GROUP', 'KEYWORD']).optional().default('CAMPAIGN'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const isMetrics = `
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.search_impression_share,
        metrics.search_top_impression_share,
        metrics.search_absolute_top_impression_share,
        metrics.search_budget_lost_impression_share,
        metrics.search_budget_lost_top_impression_share,
        metrics.search_budget_lost_absolute_top_impression_share,
        metrics.search_rank_lost_impression_share,
        metrics.search_rank_lost_top_impression_share,
        metrics.search_rank_lost_absolute_top_impression_share,
        metrics.search_exact_match_impression_share
      `;

      let query;
      if (args.level === 'KEYWORD') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ${isMetrics}
          FROM keyword_view
          WHERE ${dateWhere}
            AND ad_group_criterion.status = 'ENABLED'
            ${campFilter}
          ORDER BY metrics.impressions DESC
          LIMIT ${args.limit}
        `;
      } else if (args.level === 'AD_GROUP') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            ${isMetrics}
          FROM ad_group
          WHERE ${dateWhere}
            AND ad_group.status IN ('ENABLED', 'PAUSED')
            ${campFilter}
          ORDER BY metrics.impressions DESC
          LIMIT ${args.limit}
        `;
      } else {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.advertising_channel_type,
            metrics.content_impression_share,
            metrics.content_budget_lost_impression_share,
            metrics.content_rank_lost_impression_share,
            ${isMetrics}
          FROM campaign
          WHERE ${dateWhere}
            AND campaign.status IN ('ENABLED', 'PAUSED')
            ${campFilter}
          ORDER BY metrics.impressions DESC
          LIMIT ${args.limit}
        `;
      }
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 10. Change History Report (Episodic Memory Backbone!)
  server.registerTool(
    'report_change_history',
    {
      title: 'Change History Report (change_event & change_status)',
      description:
        'Fetches full Google Ads Change History audit logs via change_event (user email, client type, changed fields, old/new resource diffs — supports up to 30 days) or lightweight change_status.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        mode: z.enum(['CHANGE_EVENT', 'CHANGE_STATUS']).optional().default('CHANGE_EVENT'),
        days_back: z.number().int().min(1).max(29).optional().default(14).describe('Lookback days for change_event (max 29-30 days per Google Ads API limit).'),
        resource_type: z
          .enum([
            'ALL',
            'AD',
            'AD_GROUP',
            'AD_GROUP_AD',
            'AD_GROUP_CRITERION',
            'ASSET',
            'ASSET_GROUP',
            'CAMPAIGN',
            'CAMPAIGN_BUDGET',
            'CAMPAIGN_CRITERION'
          ])
          .optional()
          .default('ALL'),
        limit: z.number().int().min(1).max(10000).optional().default(200),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      if (args.mode === 'CHANGE_STATUS') {
        const resTypeFilter =
          args.resource_type && args.resource_type !== 'ALL'
            ? `WHERE change_status.resource_type = '${args.resource_type}'`
            : '';
        const query = `
          SELECT
            change_status.resource_name,
            change_status.last_change_date_time,
            change_status.resource_type,
            change_status.resource_status,
            change_status.campaign,
            change_status.ad_group,
            change_status.ad_group_ad,
            change_status.ad_group_criterion,
            change_status.campaign_criterion,
            change_status.campaign_budget,
            change_status.asset
          FROM change_status
          ${resTypeFilter}
          ORDER BY change_status.last_change_date_time DESC
          LIMIT ${args.limit}
        `;
        return await searchStream(query, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        });
      }

      // Google Ads change_event requires change_date_time bounds within ~30 days and explicit LIMIT <= 10000
      const now = new Date();
      const since = new Date(now.getTime() - args.days_back * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
      const resFilter =
        args.resource_type && args.resource_type !== 'ALL'
          ? `AND change_event.change_resource_type = '${args.resource_type}'`
          : '';
      const query = `
        SELECT
          change_event.change_date_time,
          change_event.change_resource_type,
          change_event.change_resource_name,
          change_event.resource_change_operation,
          change_event.user_email,
          change_event.client_type,
          change_event.changed_fields,
          change_event.old_resource,
          change_event.new_resource,
          change_event.campaign,
          change_event.ad_group
        FROM change_event
        WHERE change_event.change_date_time >= '${fmt(since)}'
          AND change_event.change_date_time <= '${fmt(now)}'
          ${resFilter}
        ORDER BY change_event.change_date_time DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 11. Audiences & User Lists Report
  server.registerTool(
    'report_audiences',
    {
      title: 'Audience & User List Report',
      description:
        'Reports campaign/ad-group audience targeting performance (campaign_audience_view / ad_group_audience_view) and UserList remarketing/customer match inventory.',
      inputSchema: {
        ...commonReportParams,
        scope: z.enum(['CAMPAIGN_AUDIENCE', 'AD_GROUP_AUDIENCE', 'USER_LISTS']).optional().default('CAMPAIGN_AUDIENCE'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      let query;
      if (args.scope === 'USER_LISTS') {
        query = `
          SELECT
            user_list.id,
            user_list.name,
            user_list.resource_name,
            user_list.type,
            user_list.membership_status,
            user_list.membership_life_span,
            user_list.size_for_search,
            user_list.size_for_display,
            user_list.size_range_for_search,
            user_list.size_range_for_display,
            user_list.eligible_for_search,
            user_list.eligible_for_display
          FROM user_list
          LIMIT ${args.limit}
        `;
      } else if (args.scope === 'AD_GROUP_AUDIENCE') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            ad_group_criterion.criterion_id,
            ad_group_criterion.display_name,
            ad_group_criterion.bid_modifier,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions
          FROM ad_group_audience_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${args.limit}
        `;
      } else {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign_criterion.criterion_id,
            campaign_criterion.display_name,
            campaign_criterion.bid_modifier,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions
          FROM campaign_audience_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${args.limit}
        `;
      }
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 12. Placements Report
  server.registerTool(
    'report_placements',
    {
      title: 'Placement Performance Report',
      description:
        'Reports Display/Video/Demand Gen placement URLs, mobile apps, and YouTube channels with spend & conversions — use directly to discover placements to exclude.',
      inputSchema: {
        ...commonReportParams,
        view: z.enum(['DETAIL_PLACEMENT_VIEW', 'GROUP_PLACEMENT_VIEW']).optional().default('DETAIL_PLACEMENT_VIEW'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const resName = args.view === 'GROUP_PLACEMENT_VIEW' ? 'group_placement_view' : 'detail_placement_view';
      const extraField =
        args.view === 'DETAIL_PLACEMENT_VIEW'
          ? 'detail_placement_view.group_placement_target_url,'
          : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ${resName}.placement,
          ${resName}.display_name,
          ${resName}.placement_type,
          ${resName}.target_url,
          ${extraField}
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM ${resName}
        WHERE ${dateWhere}
          ${campFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 13. Assets & Asset-Level Performance Report
  server.registerTool(
    'report_assets',
    {
      title: 'Asset Inventory & Performance Report',
      description:
        'Reports reusable Assets, RSA ad_group_ad_asset_view (HEADLINE/DESCRIPTION performance_label: BEST, GOOD, LOW, LEARNING), Campaign Assets (Sitelinks, Callouts, Images), or PMax AssetGroupAssets.',
      inputSchema: {
        ...commonReportParams,
        view: z
          .enum(['ASSET_CATALOG', 'AD_ASSET_PERFORMANCE', 'CAMPAIGN_ASSETS', 'ASSET_GROUP_ASSETS'])
          .optional()
          .default('ASSET_CATALOG'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      let query;
      if (args.view === 'AD_ASSET_PERFORMANCE') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group_ad.ad.id,
            ad_group_ad_asset_view.field_type,
            ad_group_ad_asset_view.performance_label,
            ad_group_ad_asset_view.enabled,
            asset.id,
            asset.text_asset.text,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions
          FROM ad_group_ad_asset_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.impressions DESC
          LIMIT ${args.limit}
        `;
      } else if (args.view === 'CAMPAIGN_ASSETS') {
        query = `
          SELECT
            campaign.id,
            campaign.name,
            campaign_asset.field_type,
            campaign_asset.status,
            asset.id,
            asset.type,
            asset.text_asset.text,
            asset.sitelink_asset.link_text,
            asset.callout_asset.callout_text,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions
          FROM campaign_asset
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.impressions DESC
          LIMIT ${args.limit}
        `;
      } else if (args.view === 'ASSET_GROUP_ASSETS') {
        query = `
          SELECT
            campaign.id,
            asset_group.id,
            asset_group.name,
            asset_group_asset.field_type,
            asset_group_asset.performance_label,
            asset_group_asset.status,
            asset.id,
            asset.type,
            asset.text_asset.text,
            asset.image_asset.full_size.url,
            asset.youtube_video_asset.youtube_video_id
          FROM asset_group_asset
          WHERE asset_group_asset.status IN ('ENABLED', 'PAUSED')
            ${campFilter}
          LIMIT ${args.limit}
        `;
      } else {
        query = `
          SELECT
            asset.id,
            asset.name,
            asset.resource_name,
            asset.type,
            asset.text_asset.text,
            asset.sitelink_asset.link_text,
            asset.callout_asset.callout_text,
            asset.image_asset.full_size.url,
            asset.youtube_video_asset.youtube_video_id,
            asset.final_urls
          FROM asset
          LIMIT ${args.limit}
        `;
      }
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 14. Demographics Report
  server.registerTool(
    'report_demographics',
    {
      title: 'Demographics Report (Age, Gender, Income, Parental)',
      description:
        'Breaks down performance across demographic segments: AGE_RANGE, GENDER, PARENTAL_STATUS, or INCOME_RANGE.',
      inputSchema: {
        ...commonReportParams,
        dimension: z.enum(['AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE']).optional().default('AGE_RANGE'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const map = {
        AGE_RANGE: { view: 'age_range_view', col: 'ad_group_criterion.age_range.type' },
        GENDER: { view: 'gender_view', col: 'ad_group_criterion.gender.type' },
        PARENTAL_STATUS: { view: 'parental_status_view', col: 'ad_group_criterion.parental_status.type' },
        INCOME_RANGE: { view: 'income_range_view', col: 'ad_group_criterion.income_range.type' }
      };
      const cfg = map[args.dimension];
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ${cfg.col},
          ad_group_criterion.bid_modifier,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.cost_micros,
          metrics.conversions,
          metrics.cost_per_conversion
        FROM ${cfg.view}
        WHERE ${dateWhere}
          ${campFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 15. Devices Report
  server.registerTool(
    'report_devices',
    {
      title: 'Device Breakdown Report',
      description: 'Reports campaign performance segmented by device (DESKTOP, MOBILE, TABLET, CONNECTED_TV).',
      inputSchema: {
        ...commonReportParams,
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          segments.device,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM campaign
        WHERE ${dateWhere}
          AND campaign.status IN ('ENABLED', 'PAUSED')
          ${campFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 16. Landing Pages Report
  server.registerTool(
    'report_landing_pages',
    {
      title: 'Landing Pages & Speed Report',
      description:
        'Reports landing_page_view or expanded_landing_page_view including mobile_friendly_click_rate, speed_score, clicks, cost, conversions, and ROAS.',
      inputSchema: {
        ...commonReportParams,
        expanded: z.boolean().optional().default(false).describe('Use expanded_landing_page_view instead of landing_page_view.'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      const viewName = args.expanded ? 'expanded_landing_page_view' : 'landing_page_view';
      const urlField = args.expanded
        ? 'expanded_landing_page_view.expanded_final_url'
        : 'landing_page_view.unexpanded_final_url, metrics.mobile_friendly_clicks_percentage, metrics.speed_score';
      const query = `
        SELECT
          campaign.id,
          campaign.name,
          ${urlField},
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.cost_per_conversion
        FROM ${viewName}
        WHERE ${dateWhere}
          ${campFilter}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 17. Conversion Actions & Breakdown Report
  server.registerTool(
    'report_conversion_actions',
    {
      title: 'Conversion Actions & Attribution Report',
      description:
        'Lists all Conversion Actions (category, type, primary_for_goal, counting_type, attribution model, lookback windows) and optionally breaks down campaign conversions by action name.',
      inputSchema: {
        ...commonReportParams,
        include_campaign_breakdown: z.boolean().optional().default(true)
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const actionsQuery = `
        SELECT
          conversion_action.id,
          conversion_action.name,
          conversion_action.resource_name,
          conversion_action.status,
          conversion_action.type,
          conversion_action.category,
          conversion_action.primary_for_goal,
          conversion_action.counting_type,
          conversion_action.click_through_lookback_window_days,
          conversion_action.attribution_model_settings.attribution_model,
          conversion_action.value_settings.default_value,
          conversion_action.value_settings.always_use_default_value
        FROM conversion_action
        LIMIT ${args.limit}
      `;
      const actionsRes = await searchStream(actionsQuery, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });

      if (args.include_campaign_breakdown) {
        const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
        const breakdownQuery = `
          SELECT
            campaign.id,
            campaign.name,
            segments.conversion_action_name,
            segments.conversion_action_category,
            metrics.all_conversions,
            metrics.conversions,
            metrics.conversions_value
          FROM campaign
          WHERE ${dateWhere}
            AND campaign.status IN ('ENABLED', 'PAUSED')
          ORDER BY metrics.all_conversions DESC
          LIMIT ${args.limit}
        `;
        const brRes = await searchStream(breakdownQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        });
        actionsRes.campaignConversionBreakdown = brRes.results;
      }
      return actionsRes;
    })
  );

  // 18. Recommendations Report
  server.registerTool(
    'report_recommendations',
    {
      title: 'Recommendations & Optimization Score Report',
      description:
        'Fetches active Google Ads Recommendations (keywords, budgets, RSAs, bidding, PMax) with impact metrics and resource names for apply/dismiss.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().default(100),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const query = `
        SELECT
          recommendation.resource_name,
          recommendation.type,
          recommendation.impact,
          recommendation.campaign,
          recommendation.ad_group,
          recommendation.dismissed,
          campaign.id,
          campaign.name
        FROM recommendation
        WHERE recommendation.dismissed = FALSE
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 19. Budgets & Bidding Strategies Report
  server.registerTool(
    'report_budgets_and_bidding',
    {
      title: 'Budgets & Portfolio Bidding Strategies Report',
      description:
        'Lists all CampaignBudgets (daily amount, delivery method, shared count) and Portfolio BiddingStrategies.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().default(200),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const budgetsQuery = `
        SELECT
          campaign_budget.id,
          campaign_budget.name,
          campaign_budget.resource_name,
          campaign_budget.amount_micros,
          campaign_budget.delivery_method,
          campaign_budget.explicitly_shared,
          campaign_budget.reference_count,
          campaign_budget.status,
          campaign_budget.has_recommended_budget,
          campaign_budget.recommended_budget_amount_micros
        FROM campaign_budget
        LIMIT ${args.limit}
      `;
      const strategiesQuery = `
        SELECT
          bidding_strategy.id,
          bidding_strategy.name,
          bidding_strategy.resource_name,
          bidding_strategy.type,
          bidding_strategy.status,
          bidding_strategy.target_cpa.target_cpa_micros,
          bidding_strategy.target_roas.target_roas,
          bidding_strategy.campaign_count
        FROM bidding_strategy
        LIMIT ${args.limit}
      `;
      const [budgets, biddingStrategies] = await Promise.all([
        searchStream(budgetsQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        }),
        searchStream(strategiesQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        })
      ]);
      return {
        customerId: budgets.customerId,
        campaignBudgets: budgets.results,
        portfolioBiddingStrategies: biddingStrategies.results
      };
    })
  );

  // 20. Shared Sets (Negative Keyword & Placement Lists) Report
  server.registerTool(
    'report_shared_sets',
    {
      title: 'Shared Negative Lists & Placements Report',
      description:
        'Lists all Shared Sets (NEGATIVE_KEYWORDS, NEGATIVE_PLACEMENTS), their member criteria, and campaign attachments.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        shared_set_id: z.string().optional().describe('Optional SharedSet ID to inspect items inside.'),
        limit: z.number().int().min(1).max(2000).optional().default(200),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const setsRes = await searchStream(
        `
        SELECT
          shared_set.id,
          shared_set.name,
          shared_set.resource_name,
          shared_set.type,
          shared_set.status,
          shared_set.member_count,
          shared_set.reference_count
        FROM shared_set
        LIMIT ${args.limit}
      `,
        {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        }
      );

      const linksRes = await searchStream(
        `
        SELECT
          campaign_shared_set.resource_name,
          campaign_shared_set.campaign,
          campaign_shared_set.shared_set,
          campaign_shared_set.status,
          campaign.id,
          campaign.name,
          shared_set.name,
          shared_set.type
        FROM campaign_shared_set
        LIMIT ${args.limit}
      `,
        {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        }
      );

      let criteria = [];
      if (args.shared_set_id) {
        const critRes = await searchStream(
          `
          SELECT
            shared_criterion.resource_name,
            shared_criterion.type,
            shared_criterion.keyword.text,
            shared_criterion.keyword.match_type,
            shared_criterion.placement.url,
            shared_criterion.youtube_channel.channel_id,
            shared_criterion.youtube_video.video_id,
            shared_criterion.mobile_application.app_id
          FROM shared_criterion
          WHERE shared_set.id = ${escapeGaqlString(args.shared_set_id)}
          LIMIT ${args.limit}
        `,
          {
            customerId: args.customer_id,
            loginCustomerId: args.login_customer_id,
            apiVersion: args.api_version
          }
        );
        criteria = critRes.results;
      }

      return {
        customerId: setsRes.customerId,
        sharedSets: setsRes.results,
        campaignLinks: linksRes.results,
        criteria
      };
    })
  );

  // 21. Shopping & PMax Search Insights Report
  server.registerTool(
    'report_shopping_and_pmax_insights',
    {
      title: 'Shopping Products & PMax Search Insights Report',
      description:
        'Reports Shopping/PMax product item performance (shopping_performance_view) AND/OR PMax Search Term Categories (campaign_search_term_insight).',
      inputSchema: {
        ...commonReportParams,
        mode: z.enum(['SHOPPING_PRODUCTS', 'PMAX_SEARCH_INSIGHTS']).optional().default('PMAX_SEARCH_INSIGHTS'),
        campaign_id: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const dateWhere = buildDateClause({ dateRange: args.date_range, startDate: args.start_date, endDate: args.end_date });
      const campFilter = args.campaign_id ? `AND campaign.id = ${escapeGaqlString(args.campaign_id)}` : '';
      if (args.mode === 'SHOPPING_PRODUCTS') {
        const query = `
          SELECT
            campaign.id,
            campaign.name,
            segments.product_item_id,
            segments.product_title,
            segments.product_brand,
            segments.product_channel,
            metrics.impressions,
            metrics.clicks,
            metrics.cost_micros,
            metrics.conversions,
            metrics.conversions_value
          FROM shopping_performance_view
          WHERE ${dateWhere}
            ${campFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${args.limit}
        `;
        return await searchStream(query, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        });
      }

      const insightCamp = args.campaign_id ? `AND campaign_search_term_insight.campaign_id = ${escapeGaqlString(args.campaign_id)}` : '';
      const query = `
        SELECT
          campaign_search_term_insight.campaign_id,
          campaign_search_term_insight.category_label,
          campaign_search_term_insight.id,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.conversions_value
        FROM campaign_search_term_insight
        WHERE ${dateWhere}
          ${insightCamp}
        ORDER BY metrics.clicks DESC
        LIMIT ${args.limit}
      `;
      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );

  // 22. Policy & Disapproval Diagnostics Report
  server.registerTool(
    'report_policy_diagnostics',
    {
      title: 'Policy & Disapproval Diagnostics Report',
      description:
        'Audits ads, keywords, and PMax asset groups with DISAPPROVED, APPROVED_LIMITED, or primary status alerts so policy issues are spotted immediately.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional().default(200),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const adsQuery = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group_ad.ad.id,
          ad_group_ad.status,
          ad_group_ad.policy_summary.approval_status,
          ad_group_ad.policy_summary.review_status,
          ad_group_ad.policy_summary.policy_topic_entries
        FROM ad_group_ad
        WHERE ad_group_ad.status IN ('ENABLED', 'PAUSED')
          AND ad_group_ad.policy_summary.approval_status != 'APPROVED'
        LIMIT ${args.limit}
      `;
      const agQuery = `
        SELECT
          campaign.id,
          campaign.name,
          asset_group.id,
          asset_group.name,
          asset_group.status,
          asset_group.primary_status,
          asset_group.primary_status_reasons
        FROM asset_group
        WHERE asset_group.status IN ('ENABLED', 'PAUSED')
        LIMIT ${args.limit}
      `;
      const [disapprovedAds, assetGroups] = await Promise.all([
        searchStream(adsQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        }),
        searchStream(agQuery, {
          customerId: args.customer_id,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        })
      ]);
      return {
        customerId: disapprovedAds.customerId,
        disapprovedOrLimitedAds: disapprovedAds.results,
        assetGroupStatuses: assetGroups.results
      };
    })
  );
}
