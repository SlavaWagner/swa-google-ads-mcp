import fs from 'fs';
import { z } from 'zod';
import {
  apiPost,
  searchStream,
  mutateResource,
  mutateGoogleAds,
  resolveContext,
  requireCustomerId,
  toMicros,
  escapeGaqlString,
  mcpToolHandler
} from '../googleAdsClient.js';

function resName(cid, collection, idOrResource) {
  const str = String(idOrResource || '').trim();
  if (str.startsWith('customers/')) return str;
  return `customers/${cid}/${collection}/${str}`;
}

export function validateRsaFields({ headlines = [], descriptions = [], path1, path2 }) {
  const issues = [];
  if (headlines.length < 3 || headlines.length > 15) {
    issues.push(`RSA requires 3 to 15 headlines (received ${headlines.length}).`);
  }
  headlines.forEach((h, i) => {
    const text = typeof h === 'string' ? h : h.text;
    if (!text || text.length > 30) {
      issues.push(`Headline #${i + 1} "${text || ''}" exceeds 30 chars (${text?.length || 0}).`);
    }
  });
  if (descriptions.length < 2 || descriptions.length > 4) {
    issues.push(`RSA requires 2 to 4 descriptions (received ${descriptions.length}).`);
  }
  descriptions.forEach((d, i) => {
    const text = typeof d === 'string' ? d : d.text;
    if (!text || text.length > 90) {
      issues.push(`Description #${i + 1} "${text || ''}" exceeds 90 chars (${text?.length || 0}).`);
    }
  });
  if (path1 && path1.length > 15) issues.push(`path1 exceeds 15 chars (${path1.length}).`);
  if (path2 && path2.length > 15) issues.push(`path2 exceeds 15 chars (${path2.length}).`);
  if (issues.length) {
    throw new Error(`Ad copy validation failed: ${issues.join(' | ')}`);
  }
}

export function buildBiddingStrategyPatch({
  bidding_strategy_type,
  target_cpa,
  target_roas,
  cpc_bid_ceiling,
  enhanced_cpc_enabled,
  target_impression_share_location,
  target_impression_share_fraction,
  portfolio_bidding_strategy_resource_name
}) {
  if (portfolio_bidding_strategy_resource_name) {
    return {
      fieldKey: 'biddingStrategy',
      payload: { biddingStrategy: portfolio_bidding_strategy_resource_name },
      updateMask: 'biddingStrategy'
    };
  }

  switch (bidding_strategy_type) {
    case 'MANUAL_CPC': {
      const obj = { manualCpc: { enhancedCpcEnabled: Boolean(enhanced_cpc_enabled) } };
      return { fieldKey: 'manualCpc', payload: obj, updateMask: 'manualCpc' };
    }
    case 'MAXIMIZE_CLICKS': {
      const targetSpend = {};
      if (cpc_bid_ceiling !== undefined) targetSpend.cpcBidCeilingMicros = toMicros(cpc_bid_ceiling);
      return { fieldKey: 'targetSpend', payload: { targetSpend }, updateMask: 'targetSpend' };
    }
    case 'MAXIMIZE_CONVERSIONS': {
      const maximizeConversions = {};
      if (target_cpa !== undefined) maximizeConversions.targetCpaMicros = toMicros(target_cpa);
      return {
        fieldKey: 'maximizeConversions',
        payload: { maximizeConversions },
        updateMask: target_cpa !== undefined ? 'maximizeConversions.targetCpaMicros' : 'maximizeConversions'
      };
    }
    case 'MAXIMIZE_CONVERSION_VALUE': {
      const maximizeConversionValue = {};
      if (target_roas !== undefined) maximizeConversionValue.targetRoas = Number(target_roas);
      return {
        fieldKey: 'maximizeConversionValue',
        payload: { maximizeConversionValue },
        updateMask: target_roas !== undefined ? 'maximizeConversionValue.targetRoas' : 'maximizeConversionValue'
      };
    }
    case 'TARGET_CPA': {
      if (target_cpa === undefined) throw new Error('target_cpa is required for TARGET_CPA bidding.');
      const targetCpa = { targetCpaMicros: toMicros(target_cpa) };
      if (cpc_bid_ceiling !== undefined) targetCpa.cpcBidCeilingMicros = toMicros(cpc_bid_ceiling);
      return { fieldKey: 'targetCpa', payload: { targetCpa }, updateMask: 'targetCpa' };
    }
    case 'TARGET_ROAS': {
      if (target_roas === undefined) throw new Error('target_roas is required for TARGET_ROAS bidding.');
      const targetRoas = { targetRoas: Number(target_roas) };
      if (cpc_bid_ceiling !== undefined) targetRoas.cpcBidCeilingMicros = toMicros(cpc_bid_ceiling);
      return { fieldKey: 'targetRoas', payload: { targetRoas }, updateMask: 'targetRoas' };
    }
    case 'TARGET_IMPRESSION_SHARE': {
      const targetImpressionShare = {
        location: target_impression_share_location || 'TOP_OF_PAGE',
        locationFractionMicros: toMicros(target_impression_share_fraction ?? 0.65)
      };
      if (cpc_bid_ceiling !== undefined) targetImpressionShare.cpcBidCeilingMicros = toMicros(cpc_bid_ceiling);
      return {
        fieldKey: 'targetImpressionShare',
        payload: { targetImpressionShare },
        updateMask: 'targetImpressionShare'
      };
    }
    default:
      throw new Error(`Unsupported bidding_strategy_type: ${bidding_strategy_type}`);
  }
}

const commonMutateSchema = {
  customer_id: z.string().optional().describe('Target Google Ads customer ID (defaults to config.json).'),
  login_customer_id: z.string().optional().describe('Optional MCC login-customer-id override.'),
  validate_only: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, executes API dry-run validation without persisting changes.'),
  api_version: z.string().optional()
};

export function registerMutateTools(server) {
  // 1. Campaign Creation
  server.registerTool(
    'create_campaign',
    {
      title: 'Create Google Ads Campaign (+ Budget)',
      description:
        'Atomically creates a CampaignBudget (unless existing_budget_resource_name is supplied) and a new Campaign via googleAds:mutate across Search, Performance Max, Display, Demand Gen, Shopping, or Video. Defaults to status=PAUSED for safe staged rollout.',
      inputSchema: {
        ...commonMutateSchema,
        name: z.string().min(1).describe('Campaign name.'),
        advertising_channel_type: z
          .enum(['SEARCH', 'PERFORMANCE_MAX', 'DISPLAY', 'DEMAND_GEN', 'SHOPPING', 'VIDEO'])
          .default('SEARCH'),
        advertising_channel_sub_type: z.string().optional(),
        status: z.enum(['PAUSED', 'ENABLED']).optional().default('PAUSED'),
        daily_budget: z.number().positive().optional().describe('Daily budget amount in account currency (required unless existing_budget_resource_name is provided).'),
        existing_budget_resource_name: z.string().optional().describe('Optional existing budget resource name (customers/{cid}/campaignBudgets/{id}).'),
        budget_name: z.string().optional(),
        delivery_method: z.enum(['STANDARD', 'ACCELERATED']).optional().default('STANDARD'),
        bidding_strategy_type: z
          .enum([
            'MANUAL_CPC',
            'MAXIMIZE_CLICKS',
            'MAXIMIZE_CONVERSIONS',
            'MAXIMIZE_CONVERSION_VALUE',
            'TARGET_CPA',
            'TARGET_ROAS',
            'TARGET_IMPRESSION_SHARE'
          ])
          .optional()
          .default('MAXIMIZE_CONVERSIONS'),
        target_cpa: z.number().positive().optional().describe('Optional Target CPA in currency units.'),
        target_roas: z.number().positive().optional().describe('Optional Target ROAS ratio (e.g. 4.0 = 400%).'),
        cpc_bid_ceiling: z.number().positive().optional(),
        enhanced_cpc_enabled: z.boolean().optional().default(false),
        portfolio_bidding_strategy_resource_name: z.string().optional(),
        target_google_search: z.boolean().optional().default(true),
        target_search_network: z.boolean().optional().default(false),
        target_content_network: z.boolean().optional().default(false),
        url_expansion_opt_out: z.boolean().optional().describe('Performance Max Final URL expansion opt-out flag.'),
        start_date: z.string().optional().describe('Optional campaign start date YYYY-MM-DD.'),
        end_date: z.string().optional().describe('Optional campaign end date YYYY-MM-DD.'),
        positive_geo_target_type: z
          .enum(['PRESENCE_OR_INTEREST', 'PRESENCE', 'SEARCH_INTEREST'])
          .optional()
          .default('PRESENCE'),
        negative_geo_target_type: z.enum(['PRESENCE_OR_INTEREST', 'PRESENCE']).optional().default('PRESENCE'),
        contains_eu_political_advertising: z
          .enum(['DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', 'CONTAINS_EU_POLITICAL_ADVERTISING'])
          .optional()
          .default('DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING')
          .describe('Required EU Political Advertising declaration on Google Ads API v19+/v24.'),
        tracking_url_template: z.string().optional(),
        final_url_suffix: z.string().optional(),
        merchant_id: z.string().optional().describe('Optional Merchant Center ID for Shopping / PMax Retail.'),
        sales_country: z.string().optional().describe('2-letter ISO country code for Shopping settings (e.g. DE, US).')
      },
      annotations: { destructiveHint: false, idempotentHint: false }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (!args.existing_budget_resource_name && !args.daily_budget) {
        throw new Error('Provide either "daily_budget" or "existing_budget_resource_name".');
      }

      const mutateOperations = [];
      let budgetRef = args.existing_budget_resource_name;

      if (!budgetRef) {
        budgetRef = `customers/${cid}/campaignBudgets/-1`;
        mutateOperations.push({
          campaignBudgetOperation: {
            create: {
              resourceName: budgetRef,
              name: args.budget_name || `${args.name} Budget (${Date.now()})`,
              amountMicros: toMicros(args.daily_budget),
              deliveryMethod: args.delivery_method,
              explicitlyShared: false
            }
          }
        });
      }

      const biddingPatch = buildBiddingStrategyPatch(args);

      const campaignObj = {
        resourceName: `customers/${cid}/campaigns/-2`,
        name: args.name,
        status: args.status,
        advertisingChannelType: args.advertising_channel_type,
        campaignBudget: budgetRef,
        containsEuPoliticalAdvertising: args.contains_eu_political_advertising,
        geoTargetTypeSetting: {
          positiveGeoTargetType: args.positive_geo_target_type,
          negativeGeoTargetType: args.negative_geo_target_type
        },
        ...biddingPatch.payload
      };

      if (args.advertising_channel_sub_type) {
        campaignObj.advertisingChannelSubType = args.advertising_channel_sub_type;
      }

      if (args.advertising_channel_type === 'SEARCH') {
        campaignObj.networkSettings = {
          targetGoogleSearch: args.target_google_search,
          targetSearchNetwork: args.target_search_network,
          targetContentNetwork: args.target_content_network,
          targetPartnerSearchNetwork: false
        };
      }

      if (args.advertising_channel_type === 'PERFORMANCE_MAX' && args.url_expansion_opt_out !== undefined) {
        campaignObj.urlExpansionOptOut = Boolean(args.url_expansion_opt_out);
      }

      if (args.merchant_id) {
        campaignObj.shoppingSetting = {
          merchantId: String(args.merchant_id),
          ...(args.sales_country ? { salesCountry: args.sales_country.toUpperCase() } : {})
        };
      }

      if (args.start_date) campaignObj.startDate = args.start_date;
      if (args.end_date) campaignObj.endDate = args.end_date;
      if (args.tracking_url_template) campaignObj.trackingUrlTemplate = args.tracking_url_template;
      if (args.final_url_suffix) campaignObj.finalUrlSuffix = args.final_url_suffix;

      mutateOperations.push({
        campaignOperation: {
          create: campaignObj
        }
      });

      return await mutateGoogleAds(
        mutateOperations,
        {
          customerId: cid,
          loginCustomerId: args.login_customer_id,
          apiVersion: args.api_version
        },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 2. Ad Group Creation
  server.registerTool(
    'create_ad_group',
    {
      title: 'Create Ad Group',
      description:
        'Creates a new Ad Group inside a campaign via adGroups:mutate. Supports Search, Display, Shopping, Video, CPC bid micros, Target CPA overrides, and rotation settings. Defaults to status=PAUSED.',
      inputSchema: {
        ...commonMutateSchema,
        campaign_id: z.string().min(1).describe('Campaign ID or resource name.'),
        name: z.string().min(1),
        status: z.enum(['PAUSED', 'ENABLED']).optional().default('PAUSED'),
        type: z
          .enum([
            'SEARCH_STANDARD',
            'SEARCH_DYNAMIC_ADS',
            'DISPLAY_STANDARD',
            'SHOPPING_PRODUCT_ADS',
            'VIDEO_RESPONSIVE',
            'VIDEO_TRUE_VIEW_IN_STREAM'
          ])
          .optional()
          .default('SEARCH_STANDARD'),
        cpc_bid: z.number().positive().optional().describe('Default Max CPC bid in currency units.'),
        target_cpa: z.number().positive().optional().describe('Ad Group Target CPA override in currency units.'),
        target_roas: z.number().positive().optional(),
        ad_rotation_mode: z.enum(['OPTIMIZE', 'ROTATE_FOREVER']).optional().default('OPTIMIZE')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      const adGroup = {
        name: args.name,
        campaign: resName(cid, 'campaigns', args.campaign_id),
        status: args.status,
        type: args.type,
        adRotationMode: args.ad_rotation_mode
      };
      if (args.cpc_bid !== undefined) adGroup.cpcBidMicros = toMicros(args.cpc_bid);
      if (args.target_cpa !== undefined) adGroup.targetCpaMicros = toMicros(args.target_cpa);
      if (args.target_roas !== undefined) adGroup.targetRoas = Number(args.target_roas);

      return await mutateResource(
        'adGroups',
        [{ create: adGroup }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 3. Ad Creation (RSA, Call Ad, Responsive Display Ad, or Raw DemandGen/Video JSON)
  server.registerTool(
    'create_ad',
    {
      title: 'Create Ad (RSA, Call, Responsive Display, or Custom Ad JSON)',
      description:
        'Creates an Ad inside an Ad Group via adGroupAds:mutate. Validates Responsive Search Ad headline/description character limits (30/90) pre-flight and defaults to status=PAUSED.',
      inputSchema: {
        ...commonMutateSchema,
        ad_group_id: z.string().min(1).describe('Ad Group ID or resource name.'),
        ad_type: z
          .enum(['RESPONSIVE_SEARCH_AD', 'CALL_AD', 'RESPONSIVE_DISPLAY_AD', 'RAW_AD_OBJECT'])
          .default('RESPONSIVE_SEARCH_AD'),
        status: z.enum(['PAUSED', 'ENABLED']).optional().default('PAUSED'),
        final_urls: z.array(z.string().url()).optional().describe('Landing page URLs (required for RSA/RDA).'),
        headlines: z
          .array(
            z.union([
              z.string(),
              z.object({
                text: z.string(),
                pinned_field: z.enum(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3']).optional()
              })
            ])
          )
          .optional()
          .describe('RSA: 3-15 headlines (max 30 chars each).'),
        descriptions: z
          .array(
            z.union([
              z.string(),
              z.object({
                text: z.string(),
                pinned_field: z.enum(['DESCRIPTION_1', 'DESCRIPTION_2']).optional()
              })
            ])
          )
          .optional()
          .describe('RSA: 2-4 descriptions (max 90 chars each).'),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
        call_ad: z
          .object({
            country_code: z.string().length(2),
            phone_number: z.string().min(3),
            business_name: z.string().max(25),
            headline1: z.string().max(30),
            headline2: z.string().max(30).optional(),
            description1: z.string().max(90),
            description2: z.string().max(90),
            call_tracked: z.boolean().optional().default(true),
            verification_url: z.string().url().optional()
          })
          .optional(),
        responsive_display_ad: z
          .object({
            marketing_image_assets: z.array(z.string()).min(1).describe('Asset resourceNames.'),
            square_marketing_image_assets: z.array(z.string()).min(1),
            headlines: z.array(z.string().max(30)).min(1),
            long_headline: z.string().max(90),
            descriptions: z.array(z.string().max(90)).min(1),
            business_name: z.string().max(25),
            logo_image_assets: z.array(z.string()).optional()
          })
          .optional(),
        raw_ad_object: z.record(z.any()).optional().describe('Full REST Ad object escape hatch for Video/Demand Gen/App ads.'),
        tracking_url_template: z.string().optional(),
        final_url_suffix: z.string().optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      let adPayload;
      if (args.ad_type === 'RESPONSIVE_SEARCH_AD') {
        validateRsaFields({
          headlines: args.headlines || [],
          descriptions: args.descriptions || [],
          path1: args.path1,
          path2: args.path2
        });
        if (!args.final_urls || !args.final_urls.length) {
          throw new Error('final_urls is required for RESPONSIVE_SEARCH_AD.');
        }
        adPayload = {
          finalUrls: args.final_urls,
          responsiveSearchAd: {
            headlines: args.headlines.map((h) =>
              typeof h === 'string'
                ? { text: h }
                : { text: h.text, ...(h.pinned_field ? { pinnedField: h.pinned_field } : {}) }
            ),
            descriptions: args.descriptions.map((d) =>
              typeof d === 'string'
                ? { text: d }
                : { text: d.text, ...(d.pinned_field ? { pinnedField: d.pinned_field } : {}) }
            ),
            ...(args.path1 ? { path1: args.path1 } : {}),
            ...(args.path2 ? { path2: args.path2 } : {})
          }
        };
      } else if (args.ad_type === 'CALL_AD') {
        if (!args.call_ad) throw new Error('call_ad object is required.');
        adPayload = {
          ...(args.final_urls ? { finalUrls: args.final_urls } : {}),
          callAd: {
            countryCode: args.call_ad.country_code.toUpperCase(),
            phoneNumber: args.call_ad.phone_number,
            businessName: args.call_ad.business_name,
            headline1: args.call_ad.headline1,
            ...(args.call_ad.headline2 ? { headline2: args.call_ad.headline2 } : {}),
            description1: args.call_ad.description1,
            description2: args.call_ad.description2,
            callTracked: args.call_ad.call_tracked,
            ...(args.call_ad.verification_url ? { verificationUrl: args.call_ad.verification_url } : {})
          }
        };
      } else if (args.ad_type === 'RESPONSIVE_DISPLAY_AD') {
        if (!args.responsive_display_ad || !args.final_urls?.length) {
          throw new Error('responsive_display_ad and final_urls are required.');
        }
        const rda = args.responsive_display_ad;
        adPayload = {
          finalUrls: args.final_urls,
          responsiveDisplayAd: {
            marketingImages: rda.marketing_image_assets.map((a) => ({ asset: a })),
            squareMarketingImages: rda.square_marketing_image_assets.map((a) => ({ asset: a })),
            headlines: rda.headlines.map((text) => ({ text })),
            longHeadline: { text: rda.long_headline },
            descriptions: rda.descriptions.map((text) => ({ text })),
            businessName: rda.business_name,
            ...(rda.logo_image_assets ? { logoImages: rda.logo_image_assets.map((a) => ({ asset: a })) } : {})
          }
        };
      } else {
        if (!args.raw_ad_object) throw new Error('raw_ad_object is required for RAW_AD_OBJECT mode.');
        adPayload = {
          ...(args.final_urls ? { finalUrls: args.final_urls } : {}),
          ...args.raw_ad_object
        };
      }

      if (args.tracking_url_template) adPayload.trackingUrlTemplate = args.tracking_url_template;
      if (args.final_url_suffix) adPayload.finalUrlSuffix = args.final_url_suffix;

      return await mutateResource(
        'adGroupAds',
        [
          {
            create: {
              adGroup: resName(cid, 'adGroups', args.ad_group_id),
              status: args.status,
              ad: adPayload
            }
          }
        ],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 4. Asset Group Creation (Performance Max)
  server.registerTool(
    'create_asset_group',
    {
      title: 'Create Performance Max Asset Group (+ Optional Assets & Signals)',
      description:
        'Atomically creates a Performance Max Asset Group and optionally links existing Assets and Search Themes / Audience signals in one googleAds:mutate transaction. Defaults to status=PAUSED.',
      inputSchema: {
        ...commonMutateSchema,
        campaign_id: z.string().min(1).describe('Performance Max Campaign ID or resource name.'),
        name: z.string().min(1),
        final_urls: z.array(z.string().url()).min(1),
        final_mobile_urls: z.array(z.string().url()).optional(),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
        status: z.enum(['PAUSED', 'ENABLED']).optional().default('PAUSED'),
        asset_links: z
          .array(
            z.object({
              asset_resource_name: z.string(),
              field_type: z.enum([
                'HEADLINE',
                'LONG_HEADLINE',
                'DESCRIPTION',
                'BUSINESS_NAME',
                'MARKETING_IMAGE',
                'SQUARE_MARKETING_IMAGE',
                'PORTRAIT_MARKETING_IMAGE',
                'LOGO',
                'LANDSCAPE_LOGO',
                'YOUTUBE_VIDEO',
                'CALL_TO_ACTION_SELECTION'
              ])
            })
          )
          .optional()
          .describe('Existing asset resourceNames to link atomically.'),
        search_themes: z.array(z.string().min(1)).max(25).optional().describe('Up to 25 PMax Search Theme text signals.'),
        audience_resource_names: z
          .array(z.string())
          .optional()
          .describe('Optional Account Audience resourceNames (customers/{cid}/audiences/{id}) to attach as PMax audience signals.')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const tempAgRes = `customers/${cid}/assetGroups/-1`;

      const ops = [
        {
          assetGroupOperation: {
            create: {
              resourceName: tempAgRes,
              name: args.name,
              campaign: resName(cid, 'campaigns', args.campaign_id),
              finalUrls: args.final_urls,
              ...(args.final_mobile_urls ? { finalMobileUrls: args.final_mobile_urls } : {}),
              ...(args.path1 ? { path1: args.path1 } : {}),
              ...(args.path2 ? { path2: args.path2 } : {}),
              status: args.status
            }
          }
        }
      ];

      if (args.asset_links?.length) {
        for (const link of args.asset_links) {
          ops.push({
            assetGroupAssetOperation: {
              create: {
                assetGroup: tempAgRes,
                asset: resName(cid, 'assets', link.asset_resource_name),
                fieldType: link.field_type
              }
            }
          });
        }
      }

      if (args.search_themes?.length) {
        for (const themeText of args.search_themes) {
          ops.push({
            assetGroupSignalOperation: {
              create: {
                assetGroup: tempAgRes,
                searchTheme: { text: themeText }
              }
            }
          });
        }
      }

      if (args.audience_resource_names?.length) {
        for (const audRes of args.audience_resource_names) {
          ops.push({
            assetGroupSignalOperation: {
              create: {
                assetGroup: tempAgRes,
                audience: { audience: resName(cid, 'audiences', audRes) }
              }
            }
          });
        }
      }

      return await mutateGoogleAds(
        ops,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 5. Audience Creation (Custom Audience, CRM List, Website URL Remarketing)
  server.registerTool(
    'create_audience',
    {
      title: 'Create Audience (Custom Audience / Customer Match List / Website URL List)',
      description:
        'Creates Custom Audiences (Search Keywords, URLs, Apps via customAudiences:mutate), Customer Match User Lists (crmBasedUserList via userLists:mutate), or Flexible URL Remarketing User Lists (ruleBasedUserList with url__).',
      inputSchema: {
        ...commonMutateSchema,
        mode: z.enum(['CUSTOM_AUDIENCE', 'CRM_USER_LIST', 'RULE_BASED_URL_LIST']).default('CUSTOM_AUDIENCE'),
        name: z.string().min(1),
        description: z.string().optional(),
        custom_audience_type: z.enum(['AUTO', 'SEARCH', 'INTEREST', 'PURCHASE_INTENT', 'APP']).optional().default('SEARCH'),
        members: z
          .array(
            z.object({
              member_type: z.enum(['KEYWORD', 'URL', 'APP']),
              value: z.string().min(1)
            })
          )
          .optional()
          .describe('Used when mode=CUSTOM_AUDIENCE.'),
        membership_life_span_days: z.number().int().min(1).max(540).optional().default(90),
        upload_key_type: z.enum(['CONTACT_INFO', 'CRM_ID', 'MOBILE_ADVERTISING_ID']).optional().default('CONTACT_INFO'),
        url_rules: z
          .array(
            z.object({
              operator: z.enum(['CONTAINS', 'EQUALS', 'STARTS_WITH', 'ENDS_WITH']).default('CONTAINS'),
              value: z.string().min(1)
            })
          )
          .optional()
          .describe('URL match rules combined with OR when mode=RULE_BASED_URL_LIST.'),
        prepopulation_status: z.enum(['REQUESTED', 'FINISHED', 'FAILED']).optional().default('REQUESTED')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.mode === 'CUSTOM_AUDIENCE') {
        if (!args.members?.length) throw new Error('members array is required for CUSTOM_AUDIENCE.');
        const membersPayload = args.members.map((m) => {
          if (m.member_type === 'KEYWORD') return { memberType: 'KEYWORD', keyword: m.value };
          if (m.member_type === 'URL') return { memberType: 'URL', url: m.value };
          return { memberType: 'APP', app: m.value };
        });

        return await mutateResource(
          'customAudiences',
          [
            {
              create: {
                name: args.name,
                ...(args.description ? { description: args.description } : {}),
                type: args.custom_audience_type,
                status: 'ENABLED',
                members: membersPayload
              }
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (args.mode === 'CRM_USER_LIST') {
        return await mutateResource(
          'userLists',
          [
            {
              create: {
                name: args.name,
                ...(args.description ? { description: args.description } : {}),
                membershipStatus: 'OPEN',
                membershipLifeSpan: args.membership_life_span_days,
                crmBasedUserList: {
                  uploadKeyType: args.upload_key_type
                }
              }
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (!args.url_rules?.length) throw new Error('url_rules array is required for RULE_BASED_URL_LIST.');
      return await mutateResource(
        'userLists',
        [
          {
            create: {
              name: args.name,
              ...(args.description ? { description: args.description } : {}),
              membershipStatus: 'OPEN',
              membershipLifeSpan: args.membership_life_span_days,
              ruleBasedUserList: {
                prepopulationStatus: args.prepopulation_status,
                flexibleRuleUserList: {
                  inclusiveRuleOperator: 'OR',
                  inclusiveOperands: args.url_rules.map((r) => ({
                    rule: {
                      ruleType: 'OR_OF_ANDS',
                      ruleItemGroups: [
                        {
                          ruleItems: [
                            {
                              name: 'url__',
                              stringRuleItem: {
                                operator: r.operator,
                                value: r.value
                              }
                            }
                          ]
                        }
                      ]
                    },
                    lookbackWindowDays: args.membership_life_span_days
                  }))
                }
              }
            }
          }
        ],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 6. Attach Audience Targeting / Observation / Exclusions / PMax Signals
  server.registerTool(
    'attach_audience_targeting',
    {
      title: 'Attach Audience Targeting, Observation, Exclusions, or PMax Signals',
      description:
        'Links User Lists, Custom Audiences, In-Market/Affinity User Interests, Combined Audiences, or PMax Search Themes to Campaigns, Ad Groups, or Asset Groups via campaignCriteria/adGroupCriteria/assetGroupSignals.',
      inputSchema: {
        ...commonMutateSchema,
        target_level: z.enum(['CAMPAIGN', 'AD_GROUP', 'ASSET_GROUP_SEARCH_THEME', 'ASSET_GROUP_AUDIENCE']),
        parent_id: z.string().min(1).describe('Campaign ID, Ad Group ID, or Asset Group ID.'),
        audience_type: z
          .enum(['USER_LIST', 'CUSTOM_AUDIENCE', 'USER_INTEREST', 'COMBINED_AUDIENCE'])
          .optional()
          .describe('Required for CAMPAIGN / AD_GROUP.'),
        audience_id_or_resource: z
          .string()
          .optional()
          .describe('ID or resourceName for the User List, Custom Audience, User Interest, Combined Audience, or PMax Audience.'),
        search_themes: z.array(z.string().min(1)).optional().describe('Used when target_level=ASSET_GROUP_SEARCH_THEME.'),
        is_negative: z.boolean().optional().default(false).describe('True to exclude this audience (CAMPAIGN / AD_GROUP only).'),
        bid_modifier: z.number().min(0.1).max(10).optional().describe('Optional bid multiplier (e.g. 1.2 for +20%).')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.target_level === 'ASSET_GROUP_SEARCH_THEME') {
        if (!args.search_themes?.length) throw new Error('search_themes array is required.');
        const agRes = resName(cid, 'assetGroups', args.parent_id);
        return await mutateResource(
          'assetGroupSignals',
          args.search_themes.map((text) => ({ create: { assetGroup: agRes, searchTheme: { text } } })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (args.target_level === 'ASSET_GROUP_AUDIENCE') {
        if (!args.audience_id_or_resource) throw new Error('audience_id_or_resource is required.');
        return await mutateResource(
          'assetGroupSignals',
          [
            {
              create: {
                assetGroup: resName(cid, 'assetGroups', args.parent_id),
                audience: { audience: resName(cid, 'audiences', args.audience_id_or_resource) }
              }
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (!args.audience_type || !args.audience_id_or_resource) {
        throw new Error('audience_type and audience_id_or_resource are required for CAMPAIGN/AD_GROUP.');
      }

      const criterionBody = {};
      if (args.audience_type === 'USER_LIST') {
        criterionBody.userList = { userList: resName(cid, 'userLists', args.audience_id_or_resource) };
      } else if (args.audience_type === 'CUSTOM_AUDIENCE') {
        criterionBody.customAudience = { customAudience: resName(cid, 'customAudiences', args.audience_id_or_resource) };
      } else if (args.audience_type === 'USER_INTEREST') {
        criterionBody.userInterest = {
          userInterestCategory: resName(cid, 'userInterests', args.audience_id_or_resource)
        };
      } else {
        criterionBody.combinedAudience = {
          combinedAudience: resName(cid, 'combinedAudiences', args.audience_id_or_resource)
        };
      }

      if (args.is_negative) criterionBody.negative = true;
      if (args.bid_modifier !== undefined && !args.is_negative) criterionBody.bidModifier = args.bid_modifier;

      if (args.target_level === 'CAMPAIGN') {
        criterionBody.campaign = resName(cid, 'campaigns', args.parent_id);
        return await mutateResource(
          'campaignCriteria',
          [{ create: criterionBody }],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      criterionBody.adGroup = resName(cid, 'adGroups', args.parent_id);
      return await mutateResource(
        'adGroupCriteria',
        [{ create: criterionBody }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 7. Positive Keyword Creation (Batch)
  server.registerTool(
    'create_keywords',
    {
      title: 'Create Keywords in Ad Group (Batch)',
      description:
        'Batch-creates Search Keywords inside an Ad Group via adGroupCriteria:mutate with match types (EXACT, PHRASE, BROAD), optional CPC bid overrides, and final URLs. Defaults to status=PAUSED.',
      inputSchema: {
        ...commonMutateSchema,
        ad_group_id: z.string().min(1),
        keywords: z
          .array(
            z.object({
              text: z.string().min(1),
              match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('PHRASE'),
              cpc_bid: z.number().positive().optional(),
              final_urls: z.array(z.string().url()).optional(),
              status: z.enum(['PAUSED', 'ENABLED']).optional()
            })
          )
          .min(1),
        default_status: z.enum(['PAUSED', 'ENABLED']).optional().default('PAUSED')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const agRes = resName(cid, 'adGroups', args.ad_group_id);

      const operations = args.keywords.map((kw) => ({
        create: {
          adGroup: agRes,
          status: kw.status || args.default_status,
          keyword: {
            text: kw.text,
            matchType: kw.match_type
          },
          ...(kw.cpc_bid !== undefined ? { cpcBidMicros: toMicros(kw.cpc_bid) } : {}),
          ...(kw.final_urls ? { finalUrls: kw.final_urls } : {})
        }
      }));

      return await mutateResource(
        'adGroupCriteria',
        operations,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 8. Negative Search Term Exclusion (Ad Group, Campaign, Shared Set, Account)
  server.registerTool(
    'exclude_negative_search_terms',
    {
      title: 'Exclude Negative Search Terms / Keywords (4 Scopes)',
      description:
        'Adds negative keywords in batch at AD_GROUP, CAMPAIGN, SHARED_SET (Negative Keyword List), or ACCOUNT (customerNegativeCriteria) level.',
      inputSchema: {
        ...commonMutateSchema,
        scope: z.enum(['CAMPAIGN', 'AD_GROUP', 'SHARED_SET', 'ACCOUNT']).default('CAMPAIGN'),
        target_id: z
          .string()
          .optional()
          .describe('Campaign ID, Ad Group ID, or Shared Set ID (not required when scope=ACCOUNT).'),
        keywords: z
          .array(
            z.object({
              text: z.string().min(1),
              match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('EXACT')
            })
          )
          .min(1)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.scope !== 'ACCOUNT' && !args.target_id) {
        throw new Error(`target_id is required when scope=${args.scope}.`);
      }

      if (args.scope === 'CAMPAIGN') {
        const campRes = resName(cid, 'campaigns', args.target_id);
        return await mutateResource(
          'campaignCriteria',
          args.keywords.map((kw) => ({
            create: {
              campaign: campRes,
              negative: true,
              keyword: { text: kw.text, matchType: kw.match_type }
            }
          })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (args.scope === 'AD_GROUP') {
        const agRes = resName(cid, 'adGroups', args.target_id);
        return await mutateResource(
          'adGroupCriteria',
          args.keywords.map((kw) => ({
            create: {
              adGroup: agRes,
              negative: true,
              keyword: { text: kw.text, matchType: kw.match_type }
            }
          })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (args.scope === 'SHARED_SET') {
        const ssRes = resName(cid, 'sharedSets', args.target_id);
        return await mutateResource(
          'sharedCriteria',
          args.keywords.map((kw) => ({
            create: {
              sharedSet: ssRes,
              keyword: { text: kw.text, matchType: kw.match_type }
            }
          })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      return await mutateResource(
        'customerNegativeCriteria',
        args.keywords.map((kw) => ({
          create: {
            keyword: { text: kw.text, matchType: kw.match_type }
          }
        })),
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 9. Placement Exclusion (Websites, Mobile Apps, App Categories, YouTube Channels/Videos)
  server.registerTool(
    'exclude_placements',
    {
      title: 'Exclude Placements (URLs, Apps, YouTube Channels & Videos)',
      description:
        'Excludes Display, Video, and Performance Max placements in batch at ACCOUNT, CAMPAIGN, AD_GROUP, or SHARED_SET scope.',
      inputSchema: {
        ...commonMutateSchema,
        scope: z.enum(['ACCOUNT', 'CAMPAIGN', 'AD_GROUP', 'SHARED_SET']).default('ACCOUNT'),
        target_id: z.string().optional().describe('Campaign ID, Ad Group ID, or Shared Set ID (omit for ACCOUNT).'),
        placements: z
          .array(
            z.object({
              placement_type: z
                .enum(['PLACEMENT_URL', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'MOBILE_APPLICATION', 'MOBILE_APP_CATEGORY'])
                .default('PLACEMENT_URL'),
              value: z
                .string()
                .min(1)
                .describe('Domain/URL (e.g. "adsenseformobileapps.com"), YouTube channel/video ID, App ID ("2-com.example"), or MobileAppCategory ID.')
            })
          )
          .min(1)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      if (args.scope !== 'ACCOUNT' && !args.target_id) {
        throw new Error(`target_id is required for scope=${args.scope}.`);
      }

      const buildPlacementField = (p) => {
        switch (p.placement_type) {
          case 'PLACEMENT_URL':
            return { placement: { url: p.value } };
          case 'YOUTUBE_CHANNEL':
            return { youtubeChannel: { channelId: p.value } };
          case 'YOUTUBE_VIDEO':
            return { youtubeVideo: { videoId: p.value } };
          case 'MOBILE_APPLICATION':
            return { mobileApplication: { appId: p.value } };
          case 'MOBILE_APP_CATEGORY':
            return {
              mobileAppCategory: {
                mobileAppCategoryConstant: p.value.startsWith('mobileAppCategoryConstants/')
                  ? p.value
                  : `mobileAppCategoryConstants/${p.value}`
              }
            };
        }
      };

      if (args.scope === 'ACCOUNT') {
        return await mutateResource(
          'customerNegativeCriteria',
          args.placements.map((p) => ({ create: buildPlacementField(p) })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (args.scope === 'SHARED_SET') {
        const ssRes = resName(cid, 'sharedSets', args.target_id);
        return await mutateResource(
          'sharedCriteria',
          args.placements.map((p) => ({ create: { sharedSet: ssRes, ...buildPlacementField(p) } })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (args.scope === 'CAMPAIGN') {
        const campRes = resName(cid, 'campaigns', args.target_id);
        return await mutateResource(
          'campaignCriteria',
          args.placements.map((p) => ({ create: { campaign: campRes, negative: true, ...buildPlacementField(p) } })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      const agRes = resName(cid, 'adGroups', args.target_id);
      return await mutateResource(
        'adGroupCriteria',
        args.placements.map((p) => ({ create: { adGroup: agRes, negative: true, ...buildPlacementField(p) } })),
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 10. Location Creation & Radius Targeting
  server.registerTool(
    'create_location_targeting',
    {
      title: 'Create Location or Radius (Proximity) Targeting & Exclusions',
      description:
        'Adds positive or negative Geo Target Constants (geoTargetConstants/{id}) OR geographic Proximity Radius targets (street/city/coords + km/miles radius) to a Campaign, with optional bid modifiers.',
      inputSchema: {
        ...commonMutateSchema,
        campaign_id: z.string().min(1),
        geo_targets: z
          .array(
            z.object({
              geo_target_constant_id: z.string().min(1).describe('Numeric ID or geoTargetConstants/{id}.'),
              is_negative: z.boolean().optional().default(false),
              bid_modifier: z.number().min(0.1).max(10).optional()
            })
          )
          .optional(),
        proximity_targets: z
          .array(
            z.object({
              radius: z.number().positive(),
              radius_units: z.enum(['KILOMETERS', 'MILES']).default('KILOMETERS'),
              latitude_in_micro_degrees: z.number().int().optional(),
              longitude_in_micro_degrees: z.number().int().optional(),
              city_name: z.string().optional(),
              postal_code: z.string().optional(),
              street_address: z.string().optional(),
              country_code: z.string().length(2).optional(),
              bid_modifier: z.number().min(0.1).max(10).optional()
            })
          )
          .optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const campRes = resName(cid, 'campaigns', args.campaign_id);
      const operations = [];

      if (args.geo_targets?.length) {
        for (const gt of args.geo_targets) {
          const geoRes = gt.geo_target_constant_id.startsWith('geoTargetConstants/')
            ? gt.geo_target_constant_id
            : `geoTargetConstants/${gt.geo_target_constant_id}`;
          const crit = {
            campaign: campRes,
            negative: Boolean(gt.is_negative),
            location: { geoTargetConstant: geoRes }
          };
          if (gt.bid_modifier !== undefined && !gt.is_negative) crit.bidModifier = gt.bid_modifier;
          operations.push({ create: crit });
        }
      }

      if (args.proximity_targets?.length) {
        for (const px of args.proximity_targets) {
          const proximity = {
            radius: px.radius,
            radiusUnits: px.radius_units
          };
          if (px.latitude_in_micro_degrees !== undefined && px.longitude_in_micro_degrees !== undefined) {
            proximity.geoPoint = {
              latitudeInMicroDegrees: px.latitude_in_micro_degrees,
              longitudeInMicroDegrees: px.longitude_in_micro_degrees
            };
          }
          if (px.city_name || px.postal_code || px.street_address || px.country_code) {
            proximity.address = {
              ...(px.street_address ? { streetAddress: px.street_address } : {}),
              ...(px.city_name ? { cityName: px.city_name } : {}),
              ...(px.postal_code ? { postalCode: px.postal_code } : {}),
              ...(px.country_code ? { countryCode: px.country_code.toUpperCase() } : {})
            };
          }
          const crit = { campaign: campRes, proximity };
          if (px.bid_modifier !== undefined) crit.bidModifier = px.bid_modifier;
          operations.push({ create: crit });
        }
      }

      if (!operations.length) {
        throw new Error('Provide at least one entry in geo_targets or proximity_targets.');
      }

      return await mutateResource(
        'campaignCriteria',
        operations,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 11. Target CPA Adjustment
  server.registerTool(
    'adjust_target_cpa',
    {
      title: 'Adjust Target CPA (Campaign or Ad Group)',
      description:
        'Updates Target CPA on a Campaign (auto-detects MAXIMIZE_CONVERSIONS vs TARGET_CPA via GAQL when strategy_mode=AUTO) or an Ad Group override.',
      inputSchema: {
        ...commonMutateSchema,
        level: z.enum(['CAMPAIGN', 'AD_GROUP']).default('CAMPAIGN'),
        entity_id: z.string().min(1).describe('Campaign ID or Ad Group ID.'),
        target_cpa: z.number().positive().describe('New Target CPA in account currency.'),
        strategy_mode: z
          .enum(['AUTO', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA'])
          .optional()
          .default('AUTO')
          .describe('AUTO inspects current campaign bidding_strategy_type automatically.')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const micros = toMicros(args.target_cpa);

      if (args.level === 'AD_GROUP') {
        const agRes = resName(cid, 'adGroups', args.entity_id);
        return await mutateResource(
          'adGroups',
          [
            {
              update: { resourceName: agRes, targetCpaMicros: micros },
              updateMask: 'targetCpaMicros'
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      let mode = args.strategy_mode;
      if (mode === 'AUTO') {
        const cleanCampId = args.entity_id.split('/').pop();
        const check = await searchStream(
          `SELECT campaign.id, campaign.bidding_strategy_type FROM campaign WHERE campaign.id = ${escapeGaqlString(cleanCampId)} LIMIT 1`,
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version }
        );
        const bst = check.results?.[0]?.campaign?.biddingStrategyType;
        if (bst === 'TARGET_CPA') mode = 'TARGET_CPA';
        else mode = 'MAXIMIZE_CONVERSIONS';
      }

      const campRes = resName(cid, 'campaigns', args.entity_id);
      const updateObj =
        mode === 'TARGET_CPA'
          ? { resourceName: campRes, targetCpa: { targetCpaMicros: micros } }
          : { resourceName: campRes, maximizeConversions: { targetCpaMicros: micros } };
      const updateMask = mode === 'TARGET_CPA' ? 'targetCpa.targetCpaMicros' : 'maximizeConversions.targetCpaMicros';

      return await mutateResource(
        'campaigns',
        [{ update: updateObj, updateMask }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 12. Target ROAS Adjustment
  server.registerTool(
    'adjust_target_roas',
    {
      title: 'Adjust Target ROAS (Campaign or Ad Group)',
      description:
        'Updates Target ROAS ratio (e.g. 4.5 for 450% ROAS) on a Campaign (auto-detects MAXIMIZE_CONVERSION_VALUE vs TARGET_ROAS when strategy_mode=AUTO) or Ad Group.',
      inputSchema: {
        ...commonMutateSchema,
        level: z.enum(['CAMPAIGN', 'AD_GROUP']).default('CAMPAIGN'),
        entity_id: z.string().min(1),
        target_roas: z.number().positive().describe('Target ROAS ratio (e.g. 4.0 = 400%, 2.5 = 250%).'),
        strategy_mode: z.enum(['AUTO', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS']).optional().default('AUTO')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.level === 'AD_GROUP') {
        return await mutateResource(
          'adGroups',
          [
            {
              update: {
                resourceName: resName(cid, 'adGroups', args.entity_id),
                targetRoas: Number(args.target_roas)
              },
              updateMask: 'targetRoas'
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      let mode = args.strategy_mode;
      if (mode === 'AUTO') {
        const cleanCampId = args.entity_id.split('/').pop();
        const check = await searchStream(
          `SELECT campaign.id, campaign.bidding_strategy_type FROM campaign WHERE campaign.id = ${escapeGaqlString(cleanCampId)} LIMIT 1`,
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version }
        );
        const bst = check.results?.[0]?.campaign?.biddingStrategyType;
        mode = bst === 'TARGET_ROAS' ? 'TARGET_ROAS' : 'MAXIMIZE_CONVERSION_VALUE';
      }

      const campRes = resName(cid, 'campaigns', args.entity_id);
      const updateObj =
        mode === 'TARGET_ROAS'
          ? { resourceName: campRes, targetRoas: { targetRoas: Number(args.target_roas) } }
          : { resourceName: campRes, maximizeConversionValue: { targetRoas: Number(args.target_roas) } };
      const updateMask =
        mode === 'TARGET_ROAS' ? 'targetRoas.targetRoas' : 'maximizeConversionValue.targetRoas';

      return await mutateResource(
        'campaigns',
        [{ update: updateObj, updateMask }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 13. Budget Creation, Update & Bidding Strategy Adjustment
  server.registerTool(
    'create_budget_and_adjust_bidding',
    {
      title: 'Create/Update Campaign Budget & Switch Bidding Strategy',
      description:
        'Creates a new CampaignBudget, updates an existing budget daily amount, assigns a budget to a campaign, and/or switches a campaign bidding strategy in one workflow.',
      inputSchema: {
        ...commonMutateSchema,
        action: z
          .enum(['CREATE_BUDGET', 'UPDATE_BUDGET', 'UPDATE_CAMPAIGN_BIDDING', 'CREATE_BUDGET_AND_ASSIGN_TO_CAMPAIGN'])
          .default('UPDATE_BUDGET'),
        budget_id: z.string().optional().describe('Existing budget ID or resource name (for UPDATE_BUDGET).'),
        budget_name: z.string().optional(),
        daily_budget: z.number().positive().optional().describe('Daily budget amount in currency units.'),
        explicitly_shared: z.boolean().optional().default(false),
        delivery_method: z.enum(['STANDARD', 'ACCELERATED']).optional().default('STANDARD'),
        campaign_id: z.string().optional().describe('Target campaign ID (for bidding updates or budget assignment).'),
        bidding_strategy_type: z
          .enum([
            'MANUAL_CPC',
            'MAXIMIZE_CLICKS',
            'MAXIMIZE_CONVERSIONS',
            'MAXIMIZE_CONVERSION_VALUE',
            'TARGET_CPA',
            'TARGET_ROAS',
            'TARGET_IMPRESSION_SHARE'
          ])
          .optional(),
        target_cpa: z.number().positive().optional(),
        target_roas: z.number().positive().optional(),
        cpc_bid_ceiling: z.number().positive().optional(),
        enhanced_cpc_enabled: z.boolean().optional(),
        portfolio_bidding_strategy_resource_name: z.string().optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.action === 'CREATE_BUDGET') {
        if (!args.daily_budget) throw new Error('daily_budget is required.');
        return await mutateResource(
          'campaignBudgets',
          [
            {
              create: {
                name: args.budget_name || `Budget ${Date.now()}`,
                amountMicros: toMicros(args.daily_budget),
                deliveryMethod: args.delivery_method,
                explicitlyShared: Boolean(args.explicitly_shared)
              }
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (args.action === 'UPDATE_BUDGET') {
        if (!args.budget_id || !args.daily_budget) throw new Error('budget_id and daily_budget are required.');
        return await mutateResource(
          'campaignBudgets',
          [
            {
              update: {
                resourceName: resName(cid, 'campaignBudgets', args.budget_id),
                amountMicros: toMicros(args.daily_budget)
              },
              updateMask: 'amountMicros'
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (args.action === 'UPDATE_CAMPAIGN_BIDDING') {
        if (!args.campaign_id) throw new Error('campaign_id is required.');
        if (!args.bidding_strategy_type && !args.portfolio_bidding_strategy_resource_name) {
          throw new Error('Provide bidding_strategy_type or portfolio_bidding_strategy_resource_name.');
        }
        const patch = buildBiddingStrategyPatch(args);
        return await mutateResource(
          'campaigns',
          [
            {
              update: {
                resourceName: resName(cid, 'campaigns', args.campaign_id),
                ...patch.payload
              },
              updateMask: patch.updateMask
            }
          ],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (!args.campaign_id || !args.daily_budget) {
        throw new Error('campaign_id and daily_budget are required for CREATE_BUDGET_AND_ASSIGN_TO_CAMPAIGN.');
      }
      const tempBudget = `customers/${cid}/campaignBudgets/-1`;
      const ops = [
        {
          campaignBudgetOperation: {
            create: {
              resourceName: tempBudget,
              name: args.budget_name || `Budget for Campaign ${args.campaign_id} (${Date.now()})`,
              amountMicros: toMicros(args.daily_budget),
              deliveryMethod: args.delivery_method,
              explicitlyShared: Boolean(args.explicitly_shared)
            }
          }
        },
        {
          campaignOperation: {
            update: {
              resourceName: resName(cid, 'campaigns', args.campaign_id),
              campaignBudget: tempBudget
            },
            updateMask: 'campaignBudget'
          }
        }
      ];

      return await mutateGoogleAds(
        ops,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 14. Create & Upload Asset (Images, Text, YouTube Video, Sitelinks, Callouts, Snippets, Call)
  server.registerTool(
    'create_and_upload_asset',
    {
      title: 'Create & Upload Asset (Image, Text, Sitelink, Callout, Snippet, Call, Video)',
      description:
        'Creates account-level Google Ads Assets via assets:mutate: Image bytes (from local file path or base64), Text, YouTube Video ID, Sitelink, Callout, Structured Snippet ({ header, values }), Call extension, or raw JSON asset.',
      inputSchema: {
        ...commonMutateSchema,
        asset_type: z.enum([
          'TEXT',
          'IMAGE_FILE',
          'IMAGE_BASE64',
          'YOUTUBE_VIDEO',
          'SITELINK',
          'CALLOUT',
          'STRUCTURED_SNIPPET',
          'CALL',
          'RAW_ASSET'
        ]),
        name: z.string().optional(),
        text: z.string().optional(),
        image_file_path: z.string().optional(),
        image_base64: z.string().optional(),
        youtube_video_id: z.string().optional(),
        final_urls: z.array(z.string().url()).optional(),
        sitelink: z
          .object({
            link_text: z.string().max(25),
            description1: z.string().max(35).optional(),
            description2: z.string().max(35).optional()
          })
          .optional(),
        callout_text: z.string().max(25).optional(),
        structured_snippet: z
          .object({
            header: z.string().min(1).describe('e.g. "Services", "Types", "Brands", "Models", "Styles", "Destinations"'),
            values: z.array(z.string().min(1)).min(3).max(10)
          })
          .optional(),
        call_asset: z
          .object({
            country_code: z.string().length(2),
            phone_number: z.string().min(3),
            call_conversion_reporting_state: z
              .enum(['DISABLED', 'USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION', 'USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION'])
              .optional()
              .default('USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION')
          })
          .optional(),
        raw_asset: z.record(z.any()).optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      let asset = {};
      if (args.name) asset.name = args.name;
      if (args.final_urls?.length) asset.finalUrls = args.final_urls;

      switch (args.asset_type) {
        case 'TEXT':
          if (!args.text) throw new Error('text is required for TEXT asset.');
          asset.textAsset = { text: args.text };
          break;
        case 'IMAGE_FILE': {
          if (!args.image_file_path) throw new Error('image_file_path is required.');
          if (!fs.existsSync(args.image_file_path)) throw new Error(`File not found: ${args.image_file_path}`);
          const b64 = fs.readFileSync(args.image_file_path).toString('base64');
          asset.imageAsset = { data: b64 };
          break;
        }
        case 'IMAGE_BASE64':
          if (!args.image_base64) throw new Error('image_base64 is required.');
          asset.imageAsset = { data: args.image_base64.replace(/^data:image\/\w+;base64,/, '') };
          break;
        case 'YOUTUBE_VIDEO':
          if (!args.youtube_video_id) throw new Error('youtube_video_id is required.');
          asset.youtubeVideoAsset = { youtubeVideoId: args.youtube_video_id };
          break;
        case 'SITELINK':
          if (!args.sitelink || !args.final_urls?.length) {
            throw new Error('sitelink object and final_urls are required for SITELINK.');
          }
          asset.sitelinkAsset = {
            linkText: args.sitelink.link_text,
            ...(args.sitelink.description1 ? { description1: args.sitelink.description1 } : {}),
            ...(args.sitelink.description2 ? { description2: args.sitelink.description2 } : {})
          };
          break;
        case 'CALLOUT':
          if (!args.callout_text) throw new Error('callout_text is required for CALLOUT.');
          asset.calloutAsset = { calloutText: args.callout_text };
          break;
        case 'STRUCTURED_SNIPPET':
          if (!args.structured_snippet) throw new Error('structured_snippet is required.');
          asset.structuredSnippetAsset = {
            header: args.structured_snippet.header,
            values: args.structured_snippet.values
          };
          break;
        case 'CALL':
          if (!args.call_asset) throw new Error('call_asset is required.');
          asset.callAsset = {
            countryCode: args.call_asset.country_code.toUpperCase(),
            phoneNumber: args.call_asset.phone_number,
            callConversionReportingState: args.call_asset.call_conversion_reporting_state
          };
          break;
        case 'RAW_ASSET':
          if (!args.raw_asset) throw new Error('raw_asset is required.');
          asset = { ...args.raw_asset };
          break;
      }

      return await mutateResource(
        'assets',
        [{ create: asset }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 15. Link Assets to Customer, Campaign, Ad Group, or PMax Asset Group
  server.registerTool(
    'link_assets',
    {
      title: 'Link or Unlink Assets (Account, Campaign, Ad Group, or Asset Group)',
      description:
        'Attaches existing Assets (Sitelinks, Callouts, Snippets, Calls, Images, Headlines, Logos, Videos) to Account, Campaign, Ad Group, or PMax Asset Group.',
      inputSchema: {
        ...commonMutateSchema,
        operation: z.enum(['CREATE_LINK', 'REMOVE_LINK']).default('CREATE_LINK'),
        scope: z.enum(['CUSTOMER', 'CAMPAIGN', 'AD_GROUP', 'ASSET_GROUP']).default('CAMPAIGN'),
        parent_id: z.string().optional().describe('Campaign ID, Ad Group ID, or Asset Group ID (not needed for CUSTOMER).'),
        links: z
          .array(
            z.object({
              asset_resource_name: z.string().optional().describe('Required for CREATE_LINK.'),
              field_type: z
                .string()
                .optional()
                .describe('e.g. SITELINK, CALLOUT, STRUCTURED_SNIPPET, CALL, MARKETING_IMAGE, HEADLINE, DESCRIPTION, LOGO, YOUTUBE_VIDEO'),
              link_resource_name: z.string().optional().describe('Required for REMOVE_LINK (e.g. customers/{cid}/campaignAssets/{id}).')
            })
          )
          .min(1)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      const endpointMap = {
        CUSTOMER: 'customerAssets',
        CAMPAIGN: 'campaignAssets',
        AD_GROUP: 'adGroupAssets',
        ASSET_GROUP: 'assetGroupAssets'
      };
      const endpoint = endpointMap[args.scope];

      if (args.operation === 'REMOVE_LINK') {
        return await mutateResource(
          endpoint,
          args.links.map((l) => {
            if (!l.link_resource_name) throw new Error('link_resource_name is required for REMOVE_LINK.');
            return { remove: l.link_resource_name };
          }),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (args.scope !== 'CUSTOMER' && !args.parent_id) {
        throw new Error(`parent_id is required when scope=${args.scope}.`);
      }

      const operations = args.links.map((l) => {
        if (!l.asset_resource_name || !l.field_type) {
          throw new Error('asset_resource_name and field_type are required for CREATE_LINK.');
        }
        const obj = {
          asset: resName(cid, 'assets', l.asset_resource_name),
          fieldType: l.field_type
        };
        if (args.scope === 'CAMPAIGN') obj.campaign = resName(cid, 'campaigns', args.parent_id);
        if (args.scope === 'AD_GROUP') obj.adGroup = resName(cid, 'adGroups', args.parent_id);
        if (args.scope === 'ASSET_GROUP') obj.assetGroup = resName(cid, 'assetGroups', args.parent_id);
        return { create: obj };
      });

      return await mutateResource(
        endpoint,
        operations,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 16. Manage Ad Schedule (Dayparting + Bid Modifiers)
  server.registerTool(
    'manage_ad_schedule',
    {
      title: 'Manage Campaign Ad Schedule & Time-of-Day Bid Modifiers',
      description:
        'Creates or removes Ad Schedule criteria on a campaign (dayOfWeek + hour/minute windows) with optional bid modifiers (e.g. 0.8 or 1.25).',
      inputSchema: {
        ...commonMutateSchema,
        operation: z.enum(['CREATE', 'REMOVE']).default('CREATE'),
        campaign_id: z.string().min(1),
        schedules: z
          .array(
            z.object({
              day_of_week: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']).optional(),
              start_hour: z.number().int().min(0).max(23).optional(),
              start_minute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']).optional().default('ZERO'),
              end_hour: z.number().int().min(1).max(24).optional(),
              end_minute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']).optional().default('ZERO'),
              bid_modifier: z.number().min(0.1).max(10).optional(),
              criterion_resource_name: z.string().optional().describe('Required for operation=REMOVE.')
            })
          )
          .min(1)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const campRes = resName(cid, 'campaigns', args.campaign_id);

      const operations = args.schedules.map((s) => {
        if (args.operation === 'REMOVE') {
          if (!s.criterion_resource_name) throw new Error('criterion_resource_name is required for REMOVE.');
          return { remove: s.criterion_resource_name };
        }
        return {
          create: {
            campaign: campRes,
            ...(s.bid_modifier !== undefined ? { bidModifier: s.bid_modifier } : {}),
            adSchedule: {
              dayOfWeek: s.day_of_week || 'MONDAY',
              startHour: s.start_hour ?? 8,
              startMinute: s.start_minute || 'ZERO',
              endHour: s.end_hour ?? 20,
              endMinute: s.end_minute || 'ZERO'
            }
          }
        };
      });

      return await mutateResource(
        'campaignCriteria',
        operations,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 17. Create Portfolio Bidding Strategy
  server.registerTool(
    'create_portfolio_bidding_strategy',
    {
      title: 'Create Portfolio Bidding Strategy',
      description:
        'Creates a shared account-level Portfolio Bidding Strategy via biddingStrategies:mutate (TARGET_CPA, TARGET_ROAS, MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_IMPRESSION_SHARE, TARGET_SPEND).',
      inputSchema: {
        ...commonMutateSchema,
        name: z.string().min(1),
        type: z.enum([
          'TARGET_CPA',
          'TARGET_ROAS',
          'MAXIMIZE_CONVERSIONS',
          'MAXIMIZE_CONVERSION_VALUE',
          'TARGET_IMPRESSION_SHARE',
          'TARGET_SPEND'
        ]),
        target_cpa: z.number().positive().optional(),
        target_roas: z.number().positive().optional(),
        cpc_bid_ceiling: z.number().positive().optional(),
        cpc_bid_floor: z.number().positive().optional(),
        location: z.enum(['ANYWHERE_ON_PAGE', 'TOP_OF_PAGE', 'ABSOLUTE_TOP_OF_PAGE']).optional().default('TOP_OF_PAGE'),
        location_fraction: z.number().positive().max(1).optional().default(0.65)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const strategy = { name: args.name };

      if (args.type === 'TARGET_CPA') {
        if (!args.target_cpa) throw new Error('target_cpa required.');
        strategy.targetCpa = {
          targetCpaMicros: toMicros(args.target_cpa),
          ...(args.cpc_bid_ceiling ? { cpcBidCeilingMicros: toMicros(args.cpc_bid_ceiling) } : {}),
          ...(args.cpc_bid_floor ? { cpcBidFloorMicros: toMicros(args.cpc_bid_floor) } : {})
        };
      } else if (args.type === 'TARGET_ROAS') {
        if (!args.target_roas) throw new Error('target_roas required.');
        strategy.targetRoas = {
          targetRoas: Number(args.target_roas),
          ...(args.cpc_bid_ceiling ? { cpcBidCeilingMicros: toMicros(args.cpc_bid_ceiling) } : {}),
          ...(args.cpc_bid_floor ? { cpcBidFloorMicros: toMicros(args.cpc_bid_floor) } : {})
        };
      } else if (args.type === 'MAXIMIZE_CONVERSIONS') {
        strategy.maximizeConversions = {
          ...(args.target_cpa ? { targetCpaMicros: toMicros(args.target_cpa) } : {}),
          ...(args.cpc_bid_ceiling ? { cpcBidCeilingMicros: toMicros(args.cpc_bid_ceiling) } : {})
        };
      } else if (args.type === 'MAXIMIZE_CONVERSION_VALUE') {
        strategy.maximizeConversionValue = {
          ...(args.target_roas ? { targetRoas: Number(args.target_roas) } : {}),
          ...(args.cpc_bid_ceiling ? { cpcBidCeilingMicros: toMicros(args.cpc_bid_ceiling) } : {})
        };
      } else if (args.type === 'TARGET_IMPRESSION_SHARE') {
        strategy.targetImpressionShare = {
          location: args.location,
          locationFractionMicros: toMicros(args.location_fraction),
          ...(args.cpc_bid_ceiling ? { cpcBidCeilingMicros: toMicros(args.cpc_bid_ceiling) } : {})
        };
      } else {
        strategy.targetSpend = {
          ...(args.cpc_bid_ceiling ? { cpcBidCeilingMicros: toMicros(args.cpc_bid_ceiling) } : {})
        };
      }

      return await mutateResource(
        'biddingStrategies',
        [{ create: strategy }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 18. Universal Entity Status Updater (Enable / Pause / Remove)
  server.registerTool(
    'update_entity_status',
    {
      title: 'Enable, Pause, or Remove Campaigns, Ad Groups, Ads, Keywords, or Asset Groups',
      description:
        'Batch updates status (ENABLED, PAUSED) or removes (REMOVED / criterion remove) across campaigns, adGroups, adGroupAds, assetGroups, adGroupCriteria, or campaignCriteria.',
      inputSchema: {
        ...commonMutateSchema,
        entity_type: z.enum([
          'CAMPAIGN',
          'AD_GROUP',
          'AD_GROUP_AD',
          'ASSET_GROUP',
          'AD_GROUP_CRITERION',
          'CAMPAIGN_CRITERION'
        ]),
        status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']),
        resource_names_or_ids: z
          .array(z.string().min(1))
          .min(1)
          .describe('Full resource names (recommended for composite IDs like adGroupAds/{agId}~{adId}) or simple entity IDs.')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      const collectionMap = {
        CAMPAIGN: 'campaigns',
        AD_GROUP: 'adGroups',
        AD_GROUP_AD: 'adGroupAds',
        ASSET_GROUP: 'assetGroups',
        AD_GROUP_CRITERION: 'adGroupCriteria',
        CAMPAIGN_CRITERION: 'campaignCriteria'
      };
      const collection = collectionMap[args.entity_type];

      const operations = args.resource_names_or_ids.map((id) => {
        const rn = resName(cid, collection, id);
        if (
          args.status === 'REMOVED' &&
          (args.entity_type === 'AD_GROUP_CRITERION' || args.entity_type === 'CAMPAIGN_CRITERION')
        ) {
          return { remove: rn };
        }
        return {
          update: { resourceName: rn, status: args.status },
          updateMask: 'status'
        };
      });

      return await mutateResource(
        collection,
        operations,
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 19. Update Ad Copy / Final URLs (via ads:mutate)
  server.registerTool(
    'update_ad',
    {
      title: 'Update Existing Ad Copy / URLs (ads:mutate)',
      description:
        'Updates Responsive Search Ad headlines/descriptions/paths and/or final URLs & tracking templates on an existing Ad via customers/{cid}/ads:mutate.',
      inputSchema: {
        ...commonMutateSchema,
        ad_id: z.string().min(1).describe('Ad ID or resource name (customers/{cid}/ads/{adId}).'),
        final_urls: z.array(z.string().url()).optional(),
        headlines: z
          .array(
            z.union([
              z.string(),
              z.object({ text: z.string(), pinned_field: z.enum(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3']).optional() })
            ])
          )
          .optional(),
        descriptions: z
          .array(
            z.union([
              z.string(),
              z.object({ text: z.string(), pinned_field: z.enum(['DESCRIPTION_1', 'DESCRIPTION_2']).optional() })
            ])
          )
          .optional(),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
        tracking_url_template: z.string().optional(),
        final_url_suffix: z.string().optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const adRn = resName(cid, 'ads', args.ad_id);

      const updateObj = { resourceName: adRn };
      const masks = [];

      if (args.final_urls?.length) {
        updateObj.finalUrls = args.final_urls;
        masks.push('finalUrls');
      }
      if (args.tracking_url_template !== undefined) {
        updateObj.trackingUrlTemplate = args.tracking_url_template;
        masks.push('trackingUrlTemplate');
      }
      if (args.final_url_suffix !== undefined) {
        updateObj.finalUrlSuffix = args.final_url_suffix;
        masks.push('finalUrlSuffix');
      }

      if (args.headlines || args.descriptions || args.path1 !== undefined || args.path2 !== undefined) {
        if (args.headlines && args.descriptions) {
          validateRsaFields({
            headlines: args.headlines,
            descriptions: args.descriptions,
            path1: args.path1,
            path2: args.path2
          });
        }
        updateObj.responsiveSearchAd = {};
        if (args.headlines) {
          updateObj.responsiveSearchAd.headlines = args.headlines.map((h) =>
            typeof h === 'string'
              ? { text: h }
              : { text: h.text, ...(h.pinned_field ? { pinnedField: h.pinned_field } : {}) }
          );
          masks.push('responsiveSearchAd.headlines');
        }
        if (args.descriptions) {
          updateObj.responsiveSearchAd.descriptions = args.descriptions.map((d) =>
            typeof d === 'string'
              ? { text: d }
              : { text: d.text, ...(d.pinned_field ? { pinnedField: d.pinned_field } : {}) }
          );
          masks.push('responsiveSearchAd.descriptions');
        }
        if (args.path1 !== undefined) {
          updateObj.responsiveSearchAd.path1 = args.path1;
          masks.push('responsiveSearchAd.path1');
        }
        if (args.path2 !== undefined) {
          updateObj.responsiveSearchAd.path2 = args.path2;
          masks.push('responsiveSearchAd.path2');
        }
      }

      if (!masks.length) throw new Error('Specify at least one field to update on the ad.');

      return await mutateResource(
        'ads',
        [{ update: updateObj, updateMask: masks.join(',') }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 20. Manage Shared Sets (Create Lists & Link/Unlink to Campaigns)
  server.registerTool(
    'manage_shared_sets',
    {
      title: 'Create Negative Keyword / Placement Shared Sets & Link to Campaigns',
      description:
        'Creates Shared Sets (NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS), links them to campaigns (campaignSharedSets:mutate), or unlinks them.',
      inputSchema: {
        ...commonMutateSchema,
        action: z.enum(['CREATE_SHARED_SET', 'LINK_TO_CAMPAIGNS', 'UNLINK_FROM_CAMPAIGNS', 'REMOVE_SHARED_CRITERIA']),
        name: z.string().optional(),
        type: z.enum(['NEGATIVE_KEYWORDS', 'NEGATIVE_PLACEMENTS']).optional().default('NEGATIVE_KEYWORDS'),
        shared_set_id: z.string().optional(),
        campaign_ids: z.array(z.string()).optional(),
        link_or_criterion_resource_names: z.array(z.string()).optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.action === 'CREATE_SHARED_SET') {
        if (!args.name) throw new Error('name is required.');
        return await mutateResource(
          'sharedSets',
          [{ create: { name: args.name, type: args.type } }],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      if (args.action === 'LINK_TO_CAMPAIGNS') {
        if (!args.shared_set_id || !args.campaign_ids?.length) {
          throw new Error('shared_set_id and campaign_ids are required.');
        }
        const ssRes = resName(cid, 'sharedSets', args.shared_set_id);
        return await mutateResource(
          'campaignSharedSets',
          args.campaign_ids.map((id) => ({
            create: { campaign: resName(cid, 'campaigns', id), sharedSet: ssRes }
          })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (!args.link_or_criterion_resource_names?.length) {
        throw new Error('link_or_criterion_resource_names is required.');
      }

      const endpoint = args.action === 'UNLINK_FROM_CAMPAIGNS' ? 'campaignSharedSets' : 'sharedCriteria';
      return await mutateResource(
        endpoint,
        args.link_or_criterion_resource_names.map((rn) => ({ remove: rn })),
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 21. Manage Labels (Create & Attach/Detach)
  server.registerTool(
    'manage_labels',
    {
      title: 'Create Labels & Assign to Campaigns, Ad Groups, Ads, or Keywords',
      description:
        'Creates account labels with colors/descriptions and attaches or removes label assignments across campaigns, ad groups, ads, or keywords.',
      inputSchema: {
        ...commonMutateSchema,
        action: z.enum(['CREATE_LABEL', 'ATTACH_LABEL', 'REMOVE_LABEL_LINK']),
        name: z.string().optional(),
        description: z.string().optional(),
        background_color: z.string().optional().describe('Hex color e.g. "#0086F4".'),
        target_type: z.enum(['CAMPAIGN', 'AD_GROUP', 'AD_GROUP_AD', 'AD_GROUP_CRITERION']).optional().default('CAMPAIGN'),
        label_id: z.string().optional(),
        target_resource_names_or_ids: z.array(z.string()).optional()
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      if (args.action === 'CREATE_LABEL') {
        if (!args.name) throw new Error('name is required for CREATE_LABEL.');
        const label = { name: args.name };
        if (args.description || args.background_color) {
          label.textLabel = {
            ...(args.description ? { description: args.description } : {}),
            ...(args.background_color ? { backgroundColor: args.background_color } : {})
          };
        }
        return await mutateResource(
          'labels',
          [{ create: label }],
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only }
        );
      }

      const endpointMap = {
        CAMPAIGN: 'campaignLabels',
        AD_GROUP: 'adGroupLabels',
        AD_GROUP_AD: 'adGroupAdLabels',
        AD_GROUP_CRITERION: 'adGroupCriterionLabels'
      };
      const parentEndpointMap = {
        CAMPAIGN: 'campaigns',
        AD_GROUP: 'adGroups',
        AD_GROUP_AD: 'adGroupAds',
        AD_GROUP_CRITERION: 'adGroupCriteria'
      };
      const parentFieldMap = {
        CAMPAIGN: 'campaign',
        AD_GROUP: 'adGroup',
        AD_GROUP_AD: 'adGroupAd',
        AD_GROUP_CRITERION: 'adGroupCriterion'
      };

      const ep = endpointMap[args.target_type];
      if (!args.target_resource_names_or_ids?.length) {
        throw new Error('target_resource_names_or_ids is required.');
      }

      if (args.action === 'REMOVE_LABEL_LINK') {
        return await mutateResource(
          ep,
          args.target_resource_names_or_ids.map((rn) => ({ remove: rn })),
          { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
          { validateOnly: args.validate_only, partialFailure: true }
        );
      }

      if (!args.label_id) throw new Error('label_id is required for ATTACH_LABEL.');
      const labelRn = resName(cid, 'labels', args.label_id);
      const pField = parentFieldMap[args.target_type];
      const pColl = parentEndpointMap[args.target_type];

      return await mutateResource(
        ep,
        args.target_resource_names_or_ids.map((id) => ({
          create: {
            [pField]: resName(cid, pColl, id),
            label: labelRn
          }
        })),
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only, partialFailure: true }
      );
    })
  );

  // 22. Create Conversion Action
  server.registerTool(
    'create_conversion_action',
    {
      title: 'Create Conversion Action',
      description:
        'Creates a new Conversion Action via conversionActions:mutate (WEBPAGE, UPLOAD_CLICKS, UPLOAD_CALLS, PHONE_CALL_LEADS) with category, value settings, counting type, and primary goal flag.',
      inputSchema: {
        ...commonMutateSchema,
        name: z.string().min(1),
        type: z.enum(['WEBPAGE', 'UPLOAD_CLICKS', 'UPLOAD_CALLS', 'PHONE_CALL_LEADS']).default('UPLOAD_CLICKS'),
        category: z
          .enum([
            'DEFAULT',
            'PURCHASE',
            'SIGNUP',
            'LEAD',
            'SUBMIT_LEAD_FORM',
            'BOOK_APPOINTMENT',
            'REQUEST_QUOTE',
            'PHONE_CALL_LEAD',
            'QUALIFIED_LEAD',
            'CONVERTED_LEAD'
          ])
          .default('QUALIFIED_LEAD'),
        status: z.enum(['ENABLED', 'PAUSED']).optional().default('ENABLED'),
        counting_type: z.enum(['ONE_PER_CLICK', 'MANY_PER_CLICK']).optional().default('ONE_PER_CLICK'),
        default_value: z.number().nonnegative().optional().default(0),
        default_currency_code: z.string().length(3).optional().default('EUR'),
        always_use_default_value: z.boolean().optional().default(false),
        click_through_lookback_window_days: z.number().int().min(1).max(90).optional().default(90),
        primary_for_goal: z.boolean().optional().default(true)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);

      const actionObj = {
        name: args.name,
        type: args.type,
        category: args.category,
        status: args.status,
        countingType: args.counting_type,
        clickThroughLookbackWindowDays: args.click_through_lookback_window_days,
        primaryForGoal: args.primary_for_goal,
        valueSettings: {
          defaultValue: args.default_value,
          defaultCurrencyCode: args.default_currency_code.toUpperCase(),
          alwaysUseDefaultValue: args.always_use_default_value
        }
      };

      return await mutateResource(
        'conversionActions',
        [{ create: actionObj }],
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        { validateOnly: args.validate_only }
      );
    })
  );

  // 23. Upload Offline Click Conversions (GCLID / GBRAID / WBRAID)
  server.registerTool(
    'upload_offline_click_conversions',
    {
      title: 'Upload Offline Click Conversions (GCLID / GBRAID / WBRAID)',
      description:
        'Calls customers/{cid}:uploadClickConversions to send qualified CRM leads or revenue values back into Google Ads Smart Bidding.',
      inputSchema: {
        ...commonMutateSchema,
        conversion_action_id: z.string().min(1).describe('Conversion Action ID or full resourceName.'),
        conversions: z
          .array(
            z.object({
              gclid: z.string().optional(),
              gbraid: z.string().optional(),
              wbraid: z.string().optional(),
              conversion_date_time: z
                .string()
                .min(10)
                .describe('Timestamp in format "yyyy-mm-dd hh:mm:ss+|-hh:mm", e.g. "2026-11-09 14:30:00+01:00".'),
              conversion_value: z.number().nonnegative().optional(),
              currency_code: z.string().length(3).optional(),
              order_id: z.string().optional()
            })
          )
          .min(1)
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const actionRn = resName(cid, 'conversionActions', args.conversion_action_id);

      const formatted = args.conversions.map((c) => {
        if (!c.gclid && !c.gbraid && !c.wbraid) {
          throw new Error('Each conversion must include at least one identifier (gclid, gbraid, or wbraid).');
        }
        return {
          conversionAction: actionRn,
          ...(c.gclid ? { gclid: c.gclid } : {}),
          ...(c.gbraid ? { gbraid: c.gbraid } : {}),
          ...(c.wbraid ? { wbraid: c.wbraid } : {}),
          conversionDateTime: c.conversion_date_time,
          ...(c.conversion_value !== undefined ? { conversionValue: c.conversion_value } : {}),
          ...(c.currency_code ? { currencyCode: c.currency_code.toUpperCase() } : {}),
          ...(c.order_id ? { orderId: c.order_id } : {})
        };
      });

      return await apiPost(
        `customers/${cid}:uploadClickConversions`,
        {
          conversions: formatted,
          partialFailure: true,
          validateOnly: Boolean(args.validate_only)
        },
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        'uploadClickConversions'
      );
    })
  );

  // 24. Apply or Dismiss Recommendations
  server.registerTool(
    'apply_or_dismiss_recommendation',
    {
      title: 'Apply or Dismiss Google Ads Recommendations',
      description:
        'Calls recommendations:apply or recommendations:dismiss in batch for recommendation resourceNames returned by report_recommendations. When validate_only=true, returns a local dry-run preview without modifying the account.',
      inputSchema: {
        ...commonMutateSchema,
        action: z.enum(['APPLY', 'DISMISS']),
        recommendation_resource_names: z
          .array(z.string().min(1))
          .min(1)
          .describe('Recommendation IDs or resourceNames (customers/{cid}/recommendations/{id}).')
      }
    },
    mcpToolHandler(async (args) => {
      const ctx = await resolveContext({
        customerId: args.customer_id,
        loginCustomerId: args.login_customer_id,
        apiVersion: args.api_version
      });
      const cid = requireCustomerId(ctx);
      const ops = args.recommendation_resource_names.map((id) => ({
        resourceName: resName(cid, 'recommendations', id)
      }));

      if (args.validate_only) {
        return {
          dryRunPreview: true,
          action: args.action,
          customerId: cid,
          operations: ops,
          note: 'Google Ads RecommendationService:apply/dismiss does not accept validateOnly natively; preview returned locally.'
        };
      }

      const method = args.action === 'APPLY' ? 'recommendations:apply' : 'recommendations:dismiss';
      return await apiPost(
        `customers/${cid}/${method}`,
        { operations: ops, partialFailure: true },
        { customerId: cid, loginCustomerId: args.login_customer_id, apiVersion: args.api_version },
        method
      );
    })
  );
}
