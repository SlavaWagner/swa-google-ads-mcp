import { z } from 'zod';
import {
  apiPost,
  searchStream,
  resolveContext,
  requireCustomerId,
  toMicros,
  fromMicros,
  escapeGaqlString,
  mcpToolHandler
} from '../googleAdsClient.js';

function normalizeGeoConstants(ids) {
  if (!ids || !ids.length) return undefined;
  return ids.map((id) => {
    const str = String(id).trim();
    return str.startsWith('geoTargetConstants/') ? str : `geoTargetConstants/${str}`;
  });
}

function normalizeLanguageConstant(languageId) {
  if (!languageId) return undefined;
  const str = String(languageId).trim();
  return str.startsWith('languageConstants/') ? str : `languageConstants/${str}`;
}

function parseApiMajorVersion(versionStr) {
  const m = String(versionStr || 'v24').match(/(\d+)/);
  return m ? Number(m[1]) : 24;
}

function formatKeywordIdeaMetrics(m = {}) {
  return {
    avgMonthlySearches: m.avgMonthlySearches !== undefined ? Number(m.avgMonthlySearches) : null,
    competition: m.competition || null,
    competitionIndex: m.competitionIndex !== undefined ? Number(m.competitionIndex) : null,
    lowTopOfPageBid: m.lowTopOfPageBidMicros ? fromMicros(m.lowTopOfPageBidMicros) : null,
    lowTopOfPageBidMicros: m.lowTopOfPageBidMicros || null,
    highTopOfPageBid: m.highTopOfPageBidMicros ? fromMicros(m.highTopOfPageBidMicros) : null,
    highTopOfPageBidMicros: m.highTopOfPageBidMicros || null,
    averageCpc: m.averageCpcMicros ? fromMicros(m.averageCpcMicros) : null,
    monthlySearchVolumes: m.monthlySearchVolumes || []
  };
}

export function registerResearchTools(server) {
  // 1. Keyword Planner: Generate Ideas
  server.registerTool(
    'keyword_planner_generate_ideas',
    {
      title: 'Keyword Planner: Generate Keyword Ideas',
      description:
        'Calls KeywordPlanIdeaService.generateKeywordIdeas using seed keywords, a landing page/domain URL, or both to discover new keyword ideas with search volume, competition index, and CPC bid ranges.',
      inputSchema: {
        customer_id: z.string().optional().describe('Target Google Ads customer ID.'),
        login_customer_id: z.string().optional(),
        seed_keywords: z.array(z.string().min(1)).max(20).optional().describe('Up to 20 seed keywords.'),
        url: z.string().optional().describe('Landing page URL or domain URL (when combined with seed_keywords uses keywordAndUrlSeed).'),
        site_only: z.boolean().optional().default(false).describe('When only url is given, true uses siteSeed (entire domain), false uses urlSeed (exact page).'),
        geo_target_ids: z.array(z.string()).optional().describe('Geo target constant IDs (e.g. ["2276"] Germany, ["2840"] US). Use suggest_geo_targets to look up IDs.'),
        language_id: z.string().optional().describe('Language constant ID (e.g. "1001" German, "1000" English).'),
        keyword_plan_network: z.enum(['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS']).optional().default('GOOGLE_SEARCH'),
        include_adult_keywords: z.boolean().optional().default(false),
        include_average_cpc: z.boolean().optional().default(true),
        page_size: z.number().int().min(1).max(1000).optional().default(100),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      const hasKeywords = Array.isArray(args.seed_keywords) && args.seed_keywords.length > 0;
      const hasUrl = Boolean(args.url && args.url.trim());
      if (!hasKeywords && !hasUrl) {
        throw new Error('Provide at least one seed via "seed_keywords" or "url".');
      }

      const body = {
        keywordPlanNetwork: args.keyword_plan_network,
        includeAdultKeywords: Boolean(args.include_adult_keywords),
        pageSize: args.page_size,
        historicalMetricsOptions: {
          includeAverageCpc: Boolean(args.include_average_cpc)
        }
      };

      const geoConstants = normalizeGeoConstants(args.geo_target_ids);
      if (geoConstants) body.geoTargetConstants = geoConstants;

      const langConst = normalizeLanguageConstant(args.language_id);
      if (langConst) body.language = langConst;

      if (hasKeywords && hasUrl) {
        body.keywordAndUrlSeed = { keywords: args.seed_keywords, url: args.url.trim() };
      } else if (hasKeywords) {
        body.keywordSeed = { keywords: args.seed_keywords };
      } else if (args.site_only) {
        body.siteSeed = { site: args.url.trim() };
      } else {
        body.urlSeed = { url: args.url.trim() };
      }

      const data = await apiPost(
        `customers/${cid}:generateKeywordIdeas`,
        body,
        {
          customerId: cid,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        },
        'generateKeywordIdeas'
      );

      const ideas = (data.results || []).map((item) => ({
        text: item.text,
        metrics: formatKeywordIdeaMetrics(item.keywordIdeaMetrics),
        closeVariants: item.closeVariants || [],
        keywordAnnotations: item.keywordAnnotations || null
      }));

      return {
        customerId: cid,
        totalSize: data.totalSize ? Number(data.totalSize) : ideas.length,
        count: ideas.length,
        ideas
      };
    })
  );

  // 2. Keyword Planner: Historical Metrics
  server.registerTool(
    'keyword_planner_historical_metrics',
    {
      title: 'Keyword Planner: Historical Search Volume & CPC Metrics',
      description:
        'Calls KeywordPlanIdeaService.generateKeywordHistoricalMetrics for exact lists of candidate keywords to retrieve monthly search volume, competition, low/high top-of-page CPC bids, and average CPC.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        keywords: z.array(z.string().min(1)).min(1).max(10000).describe('Keywords to look up historical metrics for.'),
        geo_target_ids: z.array(z.string()).optional().describe('Geo target constant IDs (e.g. ["2276"] Germany).'),
        language_id: z.string().optional().describe('Language constant ID (e.g. "1001" German, "1000" English).'),
        keyword_plan_network: z.enum(['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS']).optional().default('GOOGLE_SEARCH'),
        include_average_cpc: z.boolean().optional().default(true),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      const body = {
        keywords: args.keywords,
        keywordPlanNetwork: args.keyword_plan_network,
        historicalMetricsOptions: {
          includeAverageCpc: Boolean(args.include_average_cpc)
        }
      };

      const geoConstants = normalizeGeoConstants(args.geo_target_ids);
      if (geoConstants) body.geoTargetConstants = geoConstants;

      const langConst = normalizeLanguageConstant(args.language_id);
      if (langConst) body.language = langConst;

      const data = await apiPost(
        `customers/${cid}:generateKeywordHistoricalMetrics`,
        body,
        {
          customerId: cid,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        },
        'generateKeywordHistoricalMetrics'
      );

      const results = (data.results || []).map((item) => ({
        text: item.text,
        closeVariants: item.closeVariants || [],
        metrics: formatKeywordIdeaMetrics(item.keywordMetrics)
      }));

      return {
        customerId: cid,
        count: results.length,
        aggregateMetricResults: data.aggregateMetricResults || null,
        results
      };
    })
  );

  // 3. Keyword Planner: Forecast Metrics
  server.registerTool(
    'keyword_planner_forecast_metrics',
    {
      title: 'Keyword Planner: Forecast Clicks, Impressions, Cost & Conversions',
      description:
        'Calls KeywordPlanIdeaService.generateKeywordForecastMetrics with an inline campaign configuration (bidding strategy, match types, geo & language targets, and forecast date window) to estimate future performance.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        keywords: z
          .array(
            z.object({
              text: z.string().min(1),
              match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('PHRASE'),
              max_cpc_bid: z.number().positive().optional().describe('Only used on API v23 or lower with MANUAL_CPC.')
            })
          )
          .min(1)
          .describe('Candidate keywords with match_type.'),
        bidding_strategy: z
          .enum(['MANUAL_CPC', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS'])
          .optional()
          .default('MANUAL_CPC'),
        max_cpc_bid: z.number().positive().optional().describe('Required/recommended for MANUAL_CPC and optional cap for MAXIMIZE_CLICKS (currency units).'),
        daily_target_spend: z.number().positive().optional().describe('Daily budget target for MAXIMIZE_CLICKS or MAXIMIZE_CONVERSIONS (currency units).'),
        conversion_rate: z.number().positive().max(1).optional().describe('Optional assumed conversion rate (0..1, e.g. 0.05 for 5%).'),
        geo_target_ids: z.array(z.string()).optional().describe('Geo target constant IDs (e.g. ["2276"]).'),
        language_id: z.string().optional().default('1000').describe('Language constant ID (e.g. "1001" German, "1000" English).'),
        keyword_plan_network: z.enum(['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS']).optional().default('GOOGLE_SEARCH'),
        forecast_start_date: z.string().optional().describe('Future YYYY-MM-DD start date (within 1 year). Defaults to API default next week if omitted.'),
        forecast_end_date: z.string().optional().describe('Future YYYY-MM-DD end date.'),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const majorVer = parseApiMajorVersion(ctx.version);

      let biddingStrategyObj;
      if (args.bidding_strategy === 'MANUAL_CPC') {
        biddingStrategyObj = {
          manualCpcBiddingStrategy: {
            maxCpcBidMicros: toMicros(args.max_cpc_bid || 2.0)
          }
        };
      } else if (args.bidding_strategy === 'MAXIMIZE_CLICKS') {
        biddingStrategyObj = {
          maximizeClicksBiddingStrategy: {
            dailyTargetSpendMicros: toMicros(args.daily_target_spend || 50),
            ...(args.max_cpc_bid ? { maxCpcBidCeilingMicros: toMicros(args.max_cpc_bid) } : {})
          }
        };
      } else {
        biddingStrategyObj = {
          maximizeConversionsBiddingStrategy: {
            dailyTargetSpendMicros: toMicros(args.daily_target_spend || 50)
          }
        };
      }

      const geoConstants = normalizeGeoConstants(args.geo_target_ids) || ['geoTargetConstants/2840'];
      const langConst = normalizeLanguageConstant(args.language_id || '1000');

      const campaign = {
        keywordPlanNetwork: args.keyword_plan_network,
        biddingStrategy: biddingStrategyObj,
        languageConstants: [langConst]
      };
      if (args.conversion_rate !== undefined) {
        campaign.conversionRate = args.conversion_rate;
      }

      if (majorVer >= 24) {
        campaign.geoTargetConstants = geoConstants;
        campaign.adGroups = [
          {
            keywords: args.keywords.map((k) => ({
              text: k.text,
              matchType: k.match_type
            }))
          }
        ];
      } else {
        campaign.geoModifiers = geoConstants.map((g) => ({ geoTargetConstant: g }));
        campaign.adGroups = [
          {
            biddableKeywords: args.keywords.map((k) => ({
              keyword: { text: k.text, matchType: k.match_type },
              ...(k.max_cpc_bid ? { maxCpcBidMicros: toMicros(k.max_cpc_bid) } : {})
            }))
          }
        ];
      }

      const body = { campaign };
      if (args.forecast_start_date && args.forecast_end_date) {
        body.forecastPeriod = {
          startDate: args.forecast_start_date,
          endDate: args.forecast_end_date
        };
      }

      const data = await apiPost(
        `customers/${cid}:generateKeywordForecastMetrics`,
        body,
        {
          customerId: cid,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        },
        'generateKeywordForecastMetrics'
      );

      const cm = data.campaignForecastMetrics || {};
      return {
        customerId: cid,
        apiVersion: ctx.version,
        campaignForecastMetrics: {
          impressions: cm.impressions ?? null,
          clicks: cm.clicks ?? null,
          cost: cm.costMicros ? fromMicros(cm.costMicros) : null,
          costMicros: cm.costMicros || null,
          averageCpc: cm.averageCpcMicros ? fromMicros(cm.averageCpcMicros) : null,
          ctr: cm.ctr ?? null,
          conversions: cm.conversions ?? null
        },
        rawResponse: data
      };
    })
  );

  // 4. Geo Target Constant Lookup
  server.registerTool(
    'suggest_geo_targets',
    {
      title: 'Suggest Geo Target Constants (Cities, Regions, Postal Codes, Countries)',
      description:
        'Calls geoTargetConstants:suggest to resolve human location names (e.g. "Berlin", "Munich", "Zurich", "Germany") or resource names into canonical geoTargetConstants/{id} resources.',
      inputSchema: {
        location_names: z.array(z.string().min(1)).optional().describe('Location names to search (e.g. ["München", "Hamburg"]).'),
        geo_target_constants: z.array(z.string()).optional().describe('Specific resource names to resolve (e.g. ["geoTargetConstants/2276"]).'),
        country_code: z.string().length(2).optional().describe('Optional 2-letter ISO country code filter (e.g. "DE", "AT", "CH", "US").'),
        locale: z.string().optional().default('en').describe('Result display locale (e.g. "de", "en").'),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const hasNames = Array.isArray(args.location_names) && args.location_names.length > 0;
      const hasConsts = Array.isArray(args.geo_target_constants) && args.geo_target_constants.length > 0;
      if (!hasNames && !hasConsts) {
        throw new Error('Provide either "location_names" or "geo_target_constants".');
      }

      const body = { locale: args.locale };
      if (args.country_code) body.countryCode = args.country_code.toUpperCase();
      if (hasNames) body.locationNames = { names: args.location_names };
      if (hasConsts) body.geoTargets = { geoTargetConstants: normalizeGeoConstants(args.geo_target_constants) };

      const data = await apiPost(
        'geoTargetConstants:suggest',
        body,
        { apiVersion: args.api_version },
        'geoTargetConstants:suggest'
      );

      return {
        count: (data.geoTargetConstantSuggestions || []).length,
        suggestions: data.geoTargetConstantSuggestions || []
      };
    })
  );

  // 5. Audience Segment & Interest Taxonomy Lookup
  server.registerTool(
    'search_audience_segments',
    {
      title: 'Search Existing Audiences & Google Audience Taxonomy',
      description:
        'Searches customer User Lists (remarketing/Customer Match), Custom Audiences, Combined Audiences, and Google In-Market/Affinity user_interest taxonomies so agents obtain exact IDs before creating targeting or PMax signals.',
      inputSchema: {
        customer_id: z.string().optional(),
        login_customer_id: z.string().optional(),
        source: z
          .enum(['USER_LIST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'USER_INTEREST', 'LIFE_EVENT', 'DETAILED_DEMOGRAPHIC'])
          .optional()
          .default('USER_LIST'),
        search_term: z.string().optional().describe('Optional case-sensitive/insensitive substring filter on segment name.'),
        limit: z.number().int().min(1).max(1000).optional().default(100),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async (args) => {
      const nameFilter = args.search_term ? escapeGaqlString(args.search_term.trim()) : '';
      let query;

      switch (args.source) {
        case 'USER_LIST':
          query = `
            SELECT
              user_list.resource_name,
              user_list.id,
              user_list.name,
              user_list.type,
              user_list.membership_status,
              user_list.size_for_search,
              user_list.size_for_display
            FROM user_list
            ${nameFilter ? `WHERE user_list.name LIKE '%${nameFilter}%'` : ''}
            LIMIT ${args.limit}
          `;
          break;
        case 'CUSTOM_AUDIENCE':
          query = `
            SELECT
              custom_audience.resource_name,
              custom_audience.id,
              custom_audience.name,
              custom_audience.type,
              custom_audience.status,
              custom_audience.description
            FROM custom_audience
            ${nameFilter ? `WHERE custom_audience.name LIKE '%${nameFilter}%'` : ''}
            LIMIT ${args.limit}
          `;
          break;
        case 'COMBINED_AUDIENCE':
          query = `
            SELECT
              combined_audience.resource_name,
              combined_audience.id,
              combined_audience.name,
              combined_audience.status,
              combined_audience.description
            FROM combined_audience
            ${nameFilter ? `WHERE combined_audience.name LIKE '%${nameFilter}%'` : ''}
            LIMIT ${args.limit}
          `;
          break;
        case 'USER_INTEREST':
          query = `
            SELECT
              user_interest.resource_name,
              user_interest.user_interest_id,
              user_interest.name,
              user_interest.taxonomy_type,
              user_interest.user_interest_parent
            FROM user_interest
            ${nameFilter ? `WHERE user_interest.name LIKE '%${nameFilter}%'` : ''}
            LIMIT ${args.limit}
          `;
          break;
        case 'LIFE_EVENT':
          query = `
            SELECT
              life_event.resource_name,
              life_event.id,
              life_event.name,
              life_event.parent
            FROM life_event
            ${nameFilter ? `WHERE life_event.name LIKE '%${nameFilter}%'` : ''}
            LIMIT ${args.limit}
          `;
          break;
        case 'DETAILED_DEMOGRAPHIC':
          query = `
            SELECT
              detailed_demographic.resource_name,
              detailed_demographic.id,
              detailed_demographic.name,
              detailed_demographic.parent
            FROM detailed_demographic
            ${nameFilter ? `WHERE detailed_demographic.name LIKE '%${nameFilter}%'` : ''}
            LIMIT ${args.limit}
          `;
          break;
      }

      return await searchStream(query, {
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
    })
  );
}
