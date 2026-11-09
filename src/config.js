import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = process.env.SWA_GOOGLE_ADS_CONFIG
  ? path.resolve(process.env.SWA_GOOGLE_ADS_CONFIG)
  : path.resolve(PROJECT_ROOT, 'config.json');

export const DEFAULT_CONFIG = {
  customerId: '',
  developerToken: '',
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  googleAdsVersion: 'v24',
  loginCustomerId: '',
  accessToken: '',
  tokenExpiry: 0
};

/**
 * Loads configuration from config.json and merges environment variable overrides.
 * Modeled after SlavaWagner/ai-ads-pipeline for drop-in credential compatibility.
 */
export function getConfig() {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      fileConfig = JSON.parse(data);
    }
  } catch (error) {
    console.error(`[swa-google-ads-mcp] Error reading config.json (${CONFIG_PATH}):`, error.message);
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...fileConfig
  };

  if (process.env.GOOGLE_ADS_CUSTOMER_ID) merged.customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) merged.developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (process.env.GOOGLE_ADS_CLIENT_ID) merged.clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  if (process.env.GOOGLE_ADS_CLIENT_SECRET) merged.clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (process.env.GOOGLE_ADS_REFRESH_TOKEN) merged.refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) merged.loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (process.env.GOOGLE_ADS_API_VERSION) merged.googleAdsVersion = process.env.GOOGLE_ADS_API_VERSION;

  return merged;
}

export function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const clean = {
      customerId: config.customerId || '',
      developerToken: config.developerToken || '',
      clientId: config.clientId || '',
      clientSecret: config.clientSecret || '',
      refreshToken: config.refreshToken || '',
      googleAdsVersion: config.googleAdsVersion || 'v24',
      loginCustomerId: config.loginCustomerId || '',
      accessToken: config.accessToken || '',
      tokenExpiry: config.tokenExpiry || 0
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`[swa-google-ads-mcp] Error saving config.json:`, error.message);
    return false;
  }
}

export async function refreshAccessToken() {
  const config = getConfig();
  if (!config.refreshToken) {
    throw new Error('No OAuth2 refreshToken found. Run "swa-google-ads-mcp setup" or "swa-google-ads-mcp auth" inside Antigravity CLI.');
  }
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Missing clientId or clientSecret in config.json.');
  }

  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token'
    });

    const { access_token, expires_in } = response.data;
    const nextConfig = {
      ...config,
      accessToken: access_token,
      // Buffer by 5 minutes (300 seconds) matching ai-ads-pipeline
      tokenExpiry: Date.now() + ((expires_in || 3600) - 300) * 1000
    };

    saveConfig(nextConfig);
    return access_token;
  } catch (error) {
    const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`Failed to refresh Google Ads OAuth2 access token: ${errorDetails}`);
  }
}

export async function getAccessToken() {
  const config = getConfig();
  if (!config.accessToken || !config.tokenExpiry || Date.now() >= config.tokenExpiry) {
    return await refreshAccessToken();
  }
  return config.accessToken;
}
