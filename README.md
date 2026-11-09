# swa-google-ads-mcp

**A comprehensive, unofficial Google Ads Model Context Protocol (MCP) Server featuring full Reporting API Inventory AND full Mutate / Create / Update / Exclude API operations — designed exclusively for the Google Antigravity CLI (`agy`).**

---

## ⚠️ Important Disclaimers & Notices

> **1. Unofficial Community Project (NOT Official Google Ads MCP)**
>
> `swa-google-ads-mcp` is an **independent, unofficial open-source project** created by Slava Wagner. It is **NOT** affiliated with, endorsed by, or maintained by Google LLC, and it is **NOT** the official [`googleads/google-ads-mcp`](https://github.com/googleads/google-ads-mcp) repository.

> **2. Contains Active Google Ads Mutate (Write / Create / Modify) Functions**
>
> Unlike Google's official read-only Google Ads MCP server, **`swa-google-ads-mcp` explicitly implements full Mutate API capabilities** — including creating and modifying campaigns, budgets, ad groups, responsive search ads, Performance Max asset groups, audiences, keywords, negative keywords, placements, locations, Target CPA / Target ROAS bidding targets, conversion actions, offline click conversions, and applying recommendations.
>
> **Built-in Safety Guardrails:**
> - **Dry-Run Support (`validate_only: true`)** on all Mutate tools so agents can validate operations against Google Ads API before committing live changes.
> - **Staged Execution Defaults (`status: "PAUSED"`)** on newly created campaigns, ad groups, ads, PMax asset groups, and positive keywords so changes can be reviewed before going live.
> - Always test in a **Google Ads Test Manager Account** or with `validate_only: true` before authorizing autonomous production writes. You bear full responsibility for spend and account modifications triggered through this MCP server.

> **3. Antigravity CLI (`agy`) Exclusive Runtime**
>
> Consistent with [`SlavaWagner/ai-ads-pipeline`](https://github.com/SlavaWagner/ai-ads-pipeline), `swa-google-ads-mcp` checks the runtime environment on startup and **operates exclusively inside the Google Antigravity CLI (`agy`)** (or when invoked by Antigravity's MCP runtime). Running directly in a plain standalone terminal is blocked unless inside an active Antigravity session.

---

## Architecture & Highlights

- **56 Native MCP Tools** built with `@modelcontextprotocol/sdk` (`StdioServerTransport`) and strict `zod` schemas:
  - **5 Core & Discovery Tools**: Accessible accounts, MCC hierarchy, account metadata, arbitrary `googleAds:searchStream` GAQL execution, and `googleAdsFields:search` schema introspection.
  - **22 Reporting Inventory Tools**: Every core report (Campaign, Ad Group, Ad, Asset Group, Keyword, Search Term, Times/Hour/Day, Location, Impression Share, Change History) plus Audiences, Placements, Assets/Extensions, Demographics, Devices, Landing Pages, Conversion Actions, Recommendations, Budgets/Bidding Strategies, Shared Negative Lists, Shopping/PMax Search Term Insights, and Policy Diagnostics.
  - **5 Research & Planning Tools**: Keyword Planner Idea generation (`generateKeywordIdeas`), Historical Search Volume & CPC metrics (`generateKeywordHistoricalMetrics`), Campaign Forecasting (`generateKeywordForecastMetrics` across v22–v26), Geo Target Constant suggestions (`geoTargetConstants:suggest`), and Customer/Google Audience taxonomy lookup.
  - **24 Mutate / Create / Exclude Tools**: Atomic `googleAds:mutate` and resource-specific `:mutate` workflows for Campaign + Budget creation, Ad Group creation, RSA/Call/Display Ad creation (with pre-flight 30/90-char validation), PMax Asset Group + Signal creation, Custom & Remarketing Audiences, Keyword batches, 4-scope Negative Search Term exclusion, Display/YouTube Placement exclusion, Location & Proximity Radius targeting, auto-detecting Target CPA & Target ROAS adjustments, Asset uploads (image/text/sitelink/callout/snippet/call), Ad Schedules, Portfolio Bidding Strategies, Entity Status toggles, Ad Copy updates, Shared Sets, Labels, Conversion Actions, Offline Click Conversions (`GCLID`/`GBRAID`/`WBRAID`), and Recommendation Apply/Dismiss.
- **Drop-In Authentication Parity with `ai-ads-pipeline`**:
  - Uses the exact same `config.json` credential structure, Google OAuth2 localhost loopback flow on **port `8085`** (`http://localhost:8085`), automatic 300-second pre-expiry OAuth2 token refresh + 401 retry recovery, and environment variable overrides.
  - If you already authenticated [`SlavaWagner/ai-ads-pipeline`](https://github.com/SlavaWagner/ai-ads-pipeline), you can copy its `config.json` directly into this repository root (or point `SWA_GOOGLE_ADS_CONFIG` to it).

---

## Prerequisites

1. **Node.js `>= 18`** (ESM native, tested on Node 24)
2. **Google Antigravity CLI (`agy`)** installed and active
3. **Google Ads API Credentials** (same setup as `ai-ads-pipeline`):
   - **Google Ads Developer Token** (Standard or Explorer/Basic Access in Google Ads Manager → Tools → API Center)
   - **OAuth2 Desktop App Client ID & Client Secret** from Google Cloud Console (with Google Ads API enabled)
   - Redirect URI **`http://localhost:8085`** (OAuth2 loopback Desktop/Web client)

---

## Quick Start (Inside Google Antigravity CLI)

### 1. Clone & Install

```bash
git clone https://github.com/SlavaWagner/swa-google-ads-mcp.git
cd swa-google-ads-mcp
npm install
npm link   # optional: makes `swa-google-ads-mcp` globally available
```

### 2. Start Google Antigravity CLI & Run Setup

Because execution outside Antigravity is blocked, start `agy` first:

```bash
agy
```

Inside your Antigravity session, run the interactive setup wizard (identical credential flow to `ai-ads-pipeline`):

```bash
swa-google-ads-mcp setup
# or without npm link:
npm run setup
```

The wizard configures `config.json`:
1. Default Google Ads Customer ID (`1234567890`, hyphens stripped automatically)
2. Optional MCC Manager `loginCustomerId`
3. Google Ads `developerToken`
4. Google Cloud `clientId` & `clientSecret`
5. Target Google Ads REST API Version (default: `v24`)
6. Launches the browser OAuth2 loopback flow on `http://localhost:8085` (scope `https://www.googleapis.com/auth/adwords`) and saves your `refreshToken` & `accessToken`
7. Automatically registers `swa-google-ads-mcp` into `~/.gemini/config/mcp_config.json`

### 3. Manual / Existing `config.json` & Antigravity Registration

If you already have a `config.json` from `ai-ads-pipeline`, copy it to the project root (or set `SWA_GOOGLE_ADS_CONFIG`) and register the MCP server in Antigravity:

```bash
node bin/cli.js install-agy
```

Or add the following entry manually to **`~/.gemini/config/mcp_config.json`** (Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`):

```json
{
  "mcpServers": {
    "swa-google-ads-mcp": {
      "command": "node",
      "args": ["/ABS/PATH/TO/swa-google-ads-mcp/bin/mcp-server.js"],
      "env": {
        "AGY_SESSION": "1",
        "SWA_GOOGLE_ADS_CONFIG": "/ABS/PATH/TO/swa-google-ads-mcp/config.json"
      }
    }
  }
}
```

### 4. CLI Utilities & Diagnostics

```bash
swa-google-ads-mcp auth            # Run/renew browser OAuth2 login on port 8085
swa-google-ads-mcp refresh-token   # Non-interactive OAuth2 access token refresh
swa-google-ads-mcp status          # Inspect config & token status (masked secrets)
swa-google-ads-mcp status --live   # Verify live API connectivity via listAccessibleCustomers
swa-google-ads-mcp list-tools      # Print all 56 registered MCP tools ([READ] / [MUTATE])
swa-google-ads-mcp install-agy     # Register server inside ~/.gemini/config/mcp_config.json
swa-google-ads-mcp uninstall-agy   # Remove server from ~/.gemini/config/mcp_config.json
```

### Supported Environment Variables

All `config.json` values can also be supplied or overridden via environment variables:

- `SWA_GOOGLE_ADS_CONFIG` — custom path to `config.json`
- `GOOGLE_ADS_CUSTOMER_ID`
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_REFRESH_TOKEN`
- `GOOGLE_ADS_API_VERSION` (default: `v24`)

---

## Complete Tool Inventory (56 Tools)

### 1. Core, Account Hierarchy & Arbitrary GAQL (5 Tools)

| Tool Name | Access | Google Ads Endpoint / Resource | Description |
| :--- | :---: | :--- | :--- |
| `list_accessible_customers` | Read | `customers:listAccessibleCustomers` | Lists all customer IDs accessible by the authenticated user. |
| `get_account_hierarchy` | Read | `customer_client` (GAQL) | Returns MCC & client sub-account tree, currencies, timezones, test flags. |
| `get_customer_info` | Read | `customer` (GAQL) | Account settings, auto-tagging, tracking template, conversion ID, optimization score. |
| `run_gaql_query` | Read | `googleAds:searchStream` | Executes arbitrary custom GAQL `SELECT` queries across any resource. |
| `get_gaql_field_metadata` | Read | `googleAdsFields:search` | Inspects selectable, filterable, sortable fields, metrics, and segments. |

### 2. Reporting Inventory (22 Tools)

| Tool Name | Access | GAQL Resource(s) | Description |
| :--- | :---: | :--- | :--- |
| `report_campaigns` | Read | `campaign`, `campaign_budget` | Status, channel type, bidding strategy, budget, Target CPA/ROAS, full KPIs + derived ROAS/CPA/CTR. |
| `report_ad_groups` | Read | `ad_group` | Ad group status, type, bids, Target CPA/ROAS, conversions, value. |
| `report_ads` | Read | `ad_group_ad` | RSA headlines, descriptions, paths, final URLs, Ad Strength, policy approval, KPIs. |
| `report_asset_groups` | Read | `asset_group`, `asset_group_asset` | Performance Max asset groups, Ad Strength, primary status, linked asset counts & field types. |
| `report_keywords` | Read | `keyword_view`, `ad_group_criterion` | Keywords, match types, Quality Score breakdown (Creative/LP/CTR), first-page bids, KPIs. |
| `report_search_terms` | Read | `search_term_view` | Search terms, status (`ADDED`/`EXCLUDED`/`NONE`), impressions, clicks, cost, conversions. |
| `report_times` | Read | `campaign` (`segments.*`) | Performance segmented by Hour-of-Day, Day-of-Week, Date, Week, or Month for dayparting. |
| `report_locations` | Read | `geographic_view`, `user_location_view` | Geographic performance by matched vs user physical location, country, city/region criterion IDs, target criteria. |
| `report_impression_share` | Read | `campaign` / `ad_group` / `keyword_view` | Search & Display Impression Share, Absolute Top IS, Top IS, and Budget vs Rank Lost IS. |
| `report_change_history` | Read | `change_event` | Full Change History audit trail (last 30 days max, user email, client type, old/new fields) for Episodic Memory. |
| `report_audiences` | Read | `campaign_audience_view`, `ad_group_audience_view`, `user_list`, `custom_audience` | Audience segment performance + bid modifiers + account user lists & custom audiences inventory. |
| `report_placements` | Read | `group_placement_view`, `detail_placement_view`, `managed_placement_view` | Automatic & managed placements across Display, YouTube, and Apps for placement exclusions. |
| `report_assets` | Read | `asset`, `campaign_asset`, `asset_group_asset`, `ad_group_asset` | Assets (Sitelinks, Callouts, Snippets, Images, Videos, Calls, Lead Forms) & performance labels. |
| `report_demographics` | Read | `age_range_view`, `gender_view`, `income_range_view`, `parental_status_view` | Age, Gender, Household Income, and Parental Status performance breakdown. |
| `report_devices` | Read | `campaign` (`segments.device`) | Mobile, Desktop, Tablet, and Connected TV segmentation. |
| `report_landing_pages` | Read | `landing_page_view`, `expanded_landing_page_view` | Final URL performance + mobile-friendly & speed scores. |
| `report_conversion_actions` | Read | `conversion_action`, `campaign` (`segments.conversion_action`) | Conversion tracking configuration + conversions segmented per conversion action. |
| `report_recommendations` | Read | `recommendation` | Optimization recommendations with estimated impact and resourceNames. |
| `report_budgets_and_bidding` | Read | `campaign_budget`, `bidding_strategy` | Shared/unshared budgets (incl. AI Max / recommended budget) and Portfolio Bidding Strategies. |
| `report_shared_sets` | Read | `shared_set`, `campaign_shared_set`, `shared_criterion` | Negative keyword & placement shared sets, campaign links, and member criteria. |
| `report_shopping_and_pmax_insights` | Read | `shopping_performance_view`, `campaign_search_term_insight` | Shopping product SKU performance & PMax search term category insights. |
| `report_policy_diagnostics` | Read | `ad_group_ad`, `asset_group` | Audits disapproved/limited ads and PMax primary status policy alerts. |

### 3. Research & Keyword Planner (5 Tools)

| Tool Name | Access | Google Ads Endpoint / Resource | Description |
| :--- | :---: | :--- | :--- |
| `keyword_planner_generate_ideas` | Read | `customers/{cid}:generateKeywordIdeas` | Generates keyword ideas from seed keywords, URL, or both with volume & CPC ranges. |
| `keyword_planner_historical_metrics` | Read | `customers/{cid}:generateKeywordHistoricalMetrics` | Exact monthly search volume, competition, top-of-page low/high bids & avg CPC for candidate keywords. |
| `keyword_planner_forecast_metrics` | Read | `customers/{cid}:generateKeywordForecastMetrics` | Simulates future clicks, impressions, cost & conversions across bidding strategies (v22–v26 aware). |
| `suggest_geo_targets` | Read | `geoTargetConstants:suggest` | Resolves city, region, postal, or country names into canonical `geoTargetConstants/{id}`. |
| `search_audience_segments` | Read | `user_list`, `custom_audience`, `combined_audience`, `user_interest`, `life_event`, `detailed_demographic` | Discovers segment IDs before attaching targeting or PMax signals. |

### 4. Mutate / Create / Update / Exclude Functions (24 Tools)

| Tool Name | Access | Google Ads Mutate Endpoint(s) | Description |
| :--- | :---: | :--- | :--- |
| `create_campaign` | **Mutate** | `googleAds:mutate` (`campaignBudgetOperation` + `campaignOperation`) | Atomically creates Campaign Budget + Campaign (Search, PMax, Display, Demand Gen, Shopping, Video). Defaults to `PAUSED`. |
| `create_ad_group` | **Mutate** | `adGroups:mutate` | Creates Ad Groups with CPC/Target CPA/ROAS overrides and rotation settings. Defaults to `PAUSED`. |
| `create_ad` | **Mutate** | `adGroupAds:mutate` | Creates Responsive Search Ads (with pre-flight 30/90 char check), Call Ads, Responsive Display Ads, or raw Ad JSON. Defaults to `PAUSED`. |
| `create_asset_group` | **Mutate** | `googleAds:mutate` (`assetGroup` + `assetGroupAsset` + `assetGroupSignal`) | Atomically creates a Performance Max Asset Group with initial Assets, Search Themes & Audience Signals. Defaults to `PAUSED`. |
| `create_audience` | **Mutate** | `customAudiences:mutate`, `userLists:mutate` | Creates Custom Audiences (Search/URL/App), Customer Match CRM lists, or Flexible URL (`url__`) Remarketing lists. |
| `attach_audience_targeting` | **Mutate** | `campaignCriteria:mutate`, `adGroupCriteria:mutate`, `assetGroupSignals:mutate` | Attaches User Lists, Custom Audiences, In-Market/Affinity segments, or PMax Search Themes (positive, excluded, or with bid modifier). |
| `create_keywords` | **Mutate** | `adGroupCriteria:mutate` | Batch-creates Search Keywords (`EXACT`, `PHRASE`, `BROAD`) with optional CPC bids & final URLs. Defaults to `PAUSED`. |
| `exclude_negative_search_terms` | **Mutate** | `adGroupCriteria:mutate`, `campaignCriteria:mutate`, `sharedCriteria:mutate`, `customerNegativeCriteria:mutate` | Excludes negative keywords across all 4 scopes (Ad Group, Campaign, Shared Set, Account). |
| `exclude_placements` | **Mutate** | `customerNegativeCriteria:mutate`, `campaignCriteria:mutate`, `adGroupCriteria:mutate`, `sharedCriteria:mutate` | Excludes websites, mobile apps, app categories, and YouTube channels/videos at all 4 scopes. |
| `create_location_targeting` | **Mutate** | `campaignCriteria:mutate` | Adds positive/negative Geo Target Constants OR Proximity Radius targets (address/coordinates + km/miles) + bid modifiers. |
| `adjust_target_cpa` | **Mutate** | `campaigns:mutate`, `adGroups:mutate` | Updates Target CPA at Campaign level (auto-detecting `MAXIMIZE_CONVERSIONS` vs `TARGET_CPA`) or Ad Group level. |
| `adjust_target_roas` | **Mutate** | `campaigns:mutate`, `adGroups:mutate` | Updates Target ROAS ratio at Campaign level (auto-detecting `MAXIMIZE_CONVERSION_VALUE` vs `TARGET_ROAS`) or Ad Group level. |
| `create_budget_and_adjust_bidding` | **Mutate** | `campaignBudgets:mutate`, `campaigns:mutate`, `googleAds:mutate` | Creates budgets, adjusts daily budget amounts, assigns budgets to campaigns, or switches bidding strategies. |
| `create_and_upload_asset` | **Mutate** | `assets:mutate` | Uploads/creates Image (file path or base64), Text, YouTube Video, Sitelink, Callout, Structured Snippet, or Call assets. |
| `link_assets` | **Mutate** | `customerAssets:mutate`, `campaignAssets:mutate`, `adGroupAssets:mutate`, `assetGroupAssets:mutate` | Links or unlinks existing assets at Account, Campaign, Ad Group, or PMax Asset Group scope. |
| `manage_ad_schedule` | **Mutate** | `campaignCriteria:mutate` | Adds/removes day-of-week + hour/minute Ad Schedules and time-of-day bid modifiers. |
| `create_portfolio_bidding_strategy` | **Mutate** | `biddingStrategies:mutate` | Creates shared Portfolio Bidding Strategies with min/max CPC ceilings. |
| `update_entity_status` | **Mutate** | `campaigns`, `adGroups`, `adGroupAds`, `assetGroups`, `adGroupCriteria`, `campaignCriteria` | Batch toggles `ENABLED`, `PAUSED`, or `REMOVED` across core entities and criteria. |
| `update_ad` | **Mutate** | `ads:mutate` | Updates RSA headlines, descriptions, paths, final URLs, and tracking templates on existing Ads. |
| `manage_shared_sets` | **Mutate** | `sharedSets:mutate`, `campaignSharedSets:mutate`, `sharedCriteria:mutate` | Creates Negative Keyword/Placement Shared Sets, links/unlinks campaigns, or removes shared criteria. |
| `manage_labels` | **Mutate** | `labels:mutate`, `campaignLabels:mutate`, `adGroupLabels:mutate`, `adGroupAdLabels:mutate`, `adGroupCriterionLabels:mutate` | Creates Labels and assigns/detaches them on Campaigns, Ad Groups, Ads, or Keywords. |
| `create_conversion_action` | **Mutate** | `conversionActions:mutate` | Creates Web, Offline Click, or Call conversion actions with value & counting settings. |
| `upload_offline_click_conversions` | **Mutate** | `customers/{cid}:uploadClickConversions` | Uploads offline `GCLID`/`GBRAID`/`WBRAID` CRM conversions for Smart Bidding optimization. |
| `apply_or_dismiss_recommendation` | **Mutate** | `recommendations:apply`, `recommendations:dismiss` | Applies or dismisses Google Ads recommendations in batch (with local dry-run preview when `validate_only=true`). |

---

## Testing & Verification

Run the automated test suite (requires `--inside-agy` flag when running outside an active Antigravity session):

```bash
node test/verify.js --inside-agy
```

The test suite verifies:
1. Antigravity runtime guard **blocks** plain shell execution and **allows** Antigravity execution (`AGY_SESSION=1` / `--inside-agy`).
2. Config load/save & environment variable precedence round-trip in an isolated temp config (`SWA_GOOGLE_ADS_CONFIG`).
3. Live MCP JSON-RPC Stdio Protocol handshake (`initialize`, `tools/list` verifying all **56 tools** register with valid JSON Schemas, plus `tools/call` pre-flight validation & structured error responses).

---

## License

This project is licensed under the **MIT License** — see [LICENSE](./LICENSE) for details.
