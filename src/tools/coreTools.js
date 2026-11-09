import { z } from 'zod';
import {
  apiGet,
  apiPost,
  searchStream,
  normalizeCustomerId,
  mcpToolHandler
} from '../googleAdsClient.js';

export function registerCoreTools(server) {
  server.registerTool(
    'list_accessible_customers',
    {
      title: 'List Accessible Google Ads Customers',
      description:
        'Lists all Google Ads customer IDs accessible by the authenticated OAuth2 user via customers:listAccessibleCustomers.',
      inputSchema: {
        api_version: z.string().optional().describe('Optional Google Ads API version override (e.g. v24).')
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async ({ api_version }) => {
      const data = await apiGet(
        'customers:listAccessibleCustomers',
        { apiVersion: api_version },
        'listAccessibleCustomers'
      );
      const resourceNames = data.resourceNames || [];
      return {
        resourceNames,
        customerIds: resourceNames.map((r) => r.split('/').pop())
      };
    })
  );

  server.registerTool(
    'get_account_hierarchy',
    {
      title: 'Get MCC & Client Account Hierarchy',
      description:
        'Queries customer_client for the configured or specified customer/MCC ID to inspect all sub-accounts, manager flags, currencies, and timezones.',
      inputSchema: {
        customer_id: z.string().optional().describe('Target Customer or MCC ID (10 digits).'),
        login_customer_id: z.string().optional().describe('Optional Manager MCC ID for login-customer-id header.'),
        include_hidden: z.boolean().optional().default(false).describe('Include hidden accounts.'),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async ({ customer_id, login_customer_id, include_hidden, api_version }) => {
      const hiddenFilter = include_hidden ? '' : 'WHERE customer_client.hidden = FALSE';
      const query = `
        SELECT
          customer_client.id,
          customer_client.descriptive_name,
          customer_client.manager,
          customer_client.test_account,
          customer_client.status,
          customer_client.level,
          customer_client.currency_code,
          customer_client.time_zone,
          customer_client.client_customer
        FROM customer_client
        ${hiddenFilter}
        ORDER BY customer_client.level ASC, customer_client.id ASC
      `;
      return await searchStream(query, {
        customerId: customer_id,
        loginCustomerId: login_customer_id,
        apiVersion: api_version
      });
    })
  );

  server.registerTool(
    'get_customer_info',
    {
      title: 'Get Customer Account Details',
      description:
        'Fetches account-level settings (name, currency, timezone, auto-tagging, conversion tracking ID, status) for a Google Ads customer.',
      inputSchema: {
        customer_id: z.string().optional().describe('Target Google Ads customer ID.'),
        login_customer_id: z.string().optional(),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async ({ customer_id, login_customer_id, api_version }) => {
      const query = `
        SELECT
          customer.id,
          customer.descriptive_name,
          customer.currency_code,
          customer.time_zone,
          customer.manager,
          customer.test_account,
          customer.status,
          customer.auto_tagging_enabled,
          customer.tracking_url_template,
          customer.final_url_suffix,
          customer.conversion_tracking_setting.conversion_tracking_id,
          customer.conversion_tracking_setting.cross_account_conversion_tracking_id,
          customer.optimization_score,
          customer.optimization_score_weight
        FROM customer
        LIMIT 1
      `;
      return await searchStream(query, {
        customerId: customer_id,
        loginCustomerId: login_customer_id,
        apiVersion: api_version
      });
    })
  );

  server.registerTool(
    'run_gaql_query',
    {
      title: 'Run Arbitrary GAQL Query (searchStream)',
      description:
        'Executes any custom Google Ads Query Language (GAQL) SELECT query using GoogleAdsService.searchStream. Ideal for ad-hoc deep diagnostics beyond preset reports.',
      inputSchema: {
        query: z.string().min(10).describe('Full GAQL SELECT query (e.g., "SELECT campaign.id, campaign.name FROM campaign LIMIT 50").'),
        customer_id: z.string().optional().describe('Target Google Ads customer ID.'),
        login_customer_id: z.string().optional().describe('Optional MCC login-customer-id override.'),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async ({ query, customer_id, login_customer_id, api_version }) => {
      return await searchStream(query, {
        customerId: normalizeCustomerId(customer_id),
        loginCustomerId: login_customer_id,
        apiVersion: api_version
      });
    })
  );

  server.registerTool(
    'get_gaql_field_metadata',
    {
      title: 'Inspect GAQL Resource & Field Metadata',
      description:
        'Queries googleAdsFields:search to discover valid selectable, filterable, sortable fields, segments, and metrics for any Google Ads API resource.',
      inputSchema: {
        resource_or_pattern: z
          .string()
          .min(2)
          .describe('Resource name or prefix pattern (e.g. "campaign", "asset_group", "change_event", "metrics.search_%").'),
        limit: z.number().int().min(1).max(500).optional().default(100),
        api_version: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    mcpToolHandler(async ({ resource_or_pattern, limit, api_version }) => {
      const clean = resource_or_pattern.replace(/\\/g, '').replace(/'/g, '');
      const isPrefix = !clean.includes('%');
      const whereExpr = isPrefix ? `name LIKE '${clean}%'` : `name LIKE '${clean}'`;
      const query = `
        SELECT
          name,
          category,
          data_type,
          selectable,
          filterable,
          sortable,
          is_repeated,
          selectable_with,
          metrics,
          segments
        WHERE ${whereExpr}
        LIMIT ${limit}
      `.replace(/\s+/g, ' ').trim();

      return await apiPost(
        'googleAdsFields:search',
        { query },
        { apiVersion: api_version },
        'googleAdsFields:search'
      );
    })
  );
}
