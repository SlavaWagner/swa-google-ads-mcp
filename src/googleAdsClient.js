import axios from 'axios';
import { getConfig, getAccessToken, refreshAccessToken } from './config.js';

export function normalizeCustomerId(rawId) {
  if (!rawId) return '';
  return String(rawId).replace(/-/g, '').trim();
}

export function toMicros(amount) {
  if (amount === undefined || amount === null) return undefined;
  return String(Math.round(Number(amount) * 1_000_000));
}

export function fromMicros(micros) {
  if (micros === undefined || micros === null) return 0;
  return Number(micros) / 1_000_000;
}

export function escapeGaqlString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Builds a GAQL WHERE clause fragment for dates.
 */
export function buildDateClause({ dateRange, startDate, endDate, field = 'segments.date' } = {}) {
  if (startDate && endDate) {
    return `${field} BETWEEN '${escapeGaqlString(startDate)}' AND '${escapeGaqlString(endDate)}'`;
  }
  const allowedMacros = new Set([
    'TODAY',
    'YESTERDAY',
    'LAST_7_DAYS',
    'LAST_BUSINESS_WEEK',
    'THIS_MONTH',
    'LAST_MONTH',
    'LAST_14_DAYS',
    'LAST_30_DAYS',
    'THIS_WEEK_SUN_TODAY',
    'THIS_WEEK_MON_TODAY',
    'LAST_WEEK_SUN_SAT',
    'LAST_WEEK_MON_SUN'
  ]);
  const dr = (dateRange || 'LAST_30_DAYS').toUpperCase();
  if (allowedMacros.has(dr)) {
    return `${field} DURING ${dr}`;
  }
  return `${field} DURING LAST_30_DAYS`;
}

/**
 * Extracts structured, human-readable Google Ads failure messages from REST errors.
 */
export function formatGoogleAdsError(error, contextLabel = 'Google Ads API') {
  if (!error.response) {
    return `${contextLabel} error: ${error.message}`;
  }
  const status = error.response.status;
  const data = error.response.data;
  const rootErr = data?.error || data;
  const messages = [];

  if (rootErr?.message) {
    messages.push(rootErr.message);
  }
  if (Array.isArray(rootErr?.details)) {
    for (const detail of rootErr.details) {
      if (Array.isArray(detail.errors)) {
        for (const errItem of detail.errors) {
          const code = errItem.errorCode ? JSON.stringify(errItem.errorCode) : '';
          const loc = errItem.location?.fieldPathElements
            ? errItem.location.fieldPathElements.map((e) => e.fieldName + (e.index !== undefined ? `[${e.index}]` : '')).join('.')
            : '';
          messages.push(`[${code}${loc ? ` @ ${loc}` : ''}] ${errItem.message || ''}`);
        }
      }
    }
  }
  const detailText = messages.length ? messages.join(' | ') : JSON.stringify(data);
  return `${contextLabel} HTTP ${status}: ${detailText}`;
}

/**
 * Resolves customer ID, headers, API version, and fresh OAuth2 access token.
 */
export async function resolveContext(overrides = {}) {
  const config = getConfig();
  const customerId = normalizeCustomerId(overrides.customerId || config.customerId);
  const loginCustomerId = normalizeCustomerId(
    overrides.loginCustomerId !== undefined ? overrides.loginCustomerId : config.loginCustomerId
  );
  const version = (overrides.apiVersion || config.googleAdsVersion || 'v24').trim();

  if (!config.developerToken) {
    throw new Error('Missing Google Ads developerToken in config.json or GOOGLE_ADS_DEVELOPER_TOKEN env var.');
  }

  const accessToken = await getAccessToken();

  return {
    config,
    customerId,
    loginCustomerId,
    version,
    accessToken
  };
}

export function requireCustomerId(ctx) {
  if (!ctx.customerId) {
    throw new Error('Missing customer_id (set default customerId in config.json or pass customer_id argument).');
  }
  return ctx.customerId;
}

function buildHeaders(ctx, accessToken) {
  const headers = {
    'Content-Type': 'application/json',
    'developer-token': ctx.config.developerToken,
    'Authorization': `Bearer ${accessToken}`
  };
  if (ctx.loginCustomerId) {
    headers['login-customer-id'] = ctx.loginCustomerId;
  }
  return headers;
}

async function requestWithAuthRetry(fn, ctx, contextLabel) {
  try {
    return await fn(ctx.accessToken);
  } catch (error) {
    if (error.response && error.response.status === 401) {
      const freshToken = await refreshAccessToken();
      return await fn(freshToken);
    }
    throw new Error(formatGoogleAdsError(error, contextLabel));
  }
}

/**
 * Executes a GET request against https://googleads.googleapis.com/{version}/{path}
 */
export async function apiGet(relativePath, overrides = {}, contextLabel = 'Google Ads GET') {
  const ctx = await resolveContext(overrides);
  const cleanPath = relativePath.replace(/^\/+/, '');
  const url = `https://googleads.googleapis.com/${ctx.version}/${cleanPath}`;
  return requestWithAuthRetry(async (token) => {
    const res = await axios.get(url, { headers: buildHeaders(ctx, token) });
    return res.data;
  }, ctx, contextLabel);
}

/**
 * Executes a POST request against https://googleads.googleapis.com/{version}/{path}
 */
export async function apiPost(relativePath, body = {}, overrides = {}, contextLabel = 'Google Ads POST') {
  const ctx = await resolveContext(overrides);
  const cleanPath = relativePath.replace(/^\/+/, '');
  const url = `https://googleads.googleapis.com/${ctx.version}/${cleanPath}`;
  return requestWithAuthRetry(async (token) => {
    const res = await axios.post(url, body, { headers: buildHeaders(ctx, token) });
    return res.data;
  }, ctx, contextLabel);
}

/**
 * Runs GAQL via googleAds:searchStream and flattens streamed chunks into an array of result rows.
 */
export async function searchStream(gaqlQuery, overrides = {}) {
  const ctx = await resolveContext(overrides);
  const cid = requireCustomerId(ctx);
  const cleanQuery = gaqlQuery.replace(/\s+/g, ' ').trim();
  const data = await requestWithAuthRetry(async (token) => {
    const url = `https://googleads.googleapis.com/${ctx.version}/customers/${cid}/googleAds:searchStream`;
    const res = await axios.post(url, { query: cleanQuery }, { headers: buildHeaders(ctx, token) });
    return res.data;
  }, ctx, 'Google Ads searchStream');

  const results = [];
  if (Array.isArray(data)) {
    for (const chunk of data) {
      if (chunk && Array.isArray(chunk.results)) {
        results.push(...chunk.results);
      }
    }
  } else if (data && Array.isArray(data.results)) {
    results.push(...data.results);
  }
  return {
    customerId: cid,
    apiVersion: ctx.version,
    query: cleanQuery,
    count: results.length,
    results
  };
}

/**
 * Executes resource-specific :mutate calls (e.g. "campaigns", "adGroups", "adGroupAds", "adGroupCriteria").
 */
export async function mutateResource(resourcePlural, operations, overrides = {}, { validateOnly = false, partialFailure = false } = {}) {
  const ctx = await resolveContext(overrides);
  const cid = requireCustomerId(ctx);
  const payload = {
    operations,
    partialFailure: Boolean(partialFailure),
    validateOnly: Boolean(validateOnly)
  };
  return await apiPost(`customers/${cid}/${resourcePlural}:mutate`, payload, overrides, `Google Ads ${resourcePlural}:mutate`);
}

/**
 * Executes atomic multi-resource googleAds:mutate calls supporting temporary resource IDs (-1, -2, ...).
 */
export async function mutateGoogleAds(mutateOperations, overrides = {}, { validateOnly = false, partialFailure = false } = {}) {
  const ctx = await resolveContext(overrides);
  const cid = requireCustomerId(ctx);
  const payload = {
    mutateOperations,
    partialFailure: Boolean(partialFailure),
    validateOnly: Boolean(validateOnly)
  };
  return await apiPost(`customers/${cid}/googleAds:mutate`, payload, overrides, 'Google Ads googleAds:mutate');
}

/**
 * Helper to format tool responses consistently as JSON text for MCP clients.
 */
export function mcpJsonResult(obj, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(obj, null, 2)
      }
    ],
    ...(isError ? { isError: true } : {})
  };
}

export function mcpToolHandler(fn) {
  return async (args) => {
    try {
      const data = await fn(args || {});
      return mcpJsonResult(data, false);
    } catch (error) {
      return mcpJsonResult(
        {
          error: true,
          message: error.message
        },
        true
      );
    }
  };
}
