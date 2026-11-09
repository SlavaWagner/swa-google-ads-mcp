#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { input, password, confirm } from '@inquirer/prompts';
import { enforceAntigravityRuntime } from '../src/guard.js';
import {
  PROJECT_ROOT,
  CONFIG_PATH,
  getConfig,
  saveConfig,
  refreshAccessToken
} from '../src/config.js';
import { runOAuthFlow } from '../src/auth.js';
import { apiGet, mcpToolHandler } from '../src/googleAdsClient.js';
import { createSwaGoogleAdsMcpServer } from './mcp-server.js';

// Enforce Google Antigravity CLI execution context immediately (mirrors SlavaWagner/ai-ads-pipeline)
enforceAntigravityRuntime('cli');

function getAgyMcpConfigPath() {
  return path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
}

function maskSecret(val) {
  if (!val) return chalk.red('(not set)');
  if (val.length <= 8) return chalk.green('***' + val.slice(-2));
  return chalk.green(`${val.slice(0, 4)}...${val.slice(-4)}`);
}

function installIntoAntigravity({ dryRun = false } = {}) {
  const mcpConfigPath = getAgyMcpConfigPath();
  const serverEntryPath = path.resolve(PROJECT_ROOT, 'bin', 'mcp-server.js');

  let current = {};
  if (fs.existsSync(mcpConfigPath)) {
    const raw = fs.readFileSync(mcpConfigPath, 'utf8').trim();
    if (raw) {
      current = JSON.parse(raw);
    }
  }

  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers || {}),
      'swa-google-ads-mcp': {
        command: 'node',
        args: [serverEntryPath],
        env: {
          AGY_SESSION: '1',
          SWA_GOOGLE_ADS_CONFIG: CONFIG_PATH
        }
      }
    }
  };

  if (dryRun) {
    console.log(chalk.cyan(`\n[Dry Run] Would write ${mcpConfigPath}:`));
    console.log(JSON.stringify(next, null, 2));
    return mcpConfigPath;
  }

  const dir = path.dirname(mcpConfigPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(mcpConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return mcpConfigPath;
}

const program = new Command();

program
  .name('swa-google-ads-mcp')
  .description('Unofficial Google Ads MCP Server & Setup CLI (exclusively for Google Antigravity CLI)')
  .version('1.0.0')
  .option('--inside-agy', 'Flag confirming execution inside Google Antigravity CLI')
  .option('--force', 'Bypass Antigravity environment variable check');

program
  .command('setup')
  .description('Interactive setup for Google Ads credentials (OAuth2 + Developer Token) & Antigravity registration')
  .action(async () => {
    const current = getConfig();
    console.log(chalk.bold.cyan('\n=== SWA Google Ads MCP — Interactive Setup ==='));
    console.log(chalk.gray('Note: Uses the same config.json schema & OAuth2 flow (port 8085) as ai-ads-pipeline.\n'));

    const customerId = await input({
      message: 'Default Google Ads Customer ID (10 digits, hyphens OK):',
      default: current.customerId || ''
    });

    const loginCustomerId = await input({
      message: 'Manager MCC Login Customer ID (optional if direct account):',
      default: current.loginCustomerId || ''
    });

    const developerToken = await input({
      message: 'Google Ads Developer Token:',
      default: current.developerToken || ''
    });

    const clientId = await input({
      message: 'Google Cloud OAuth2 Client ID:',
      default: current.clientId || ''
    });

    const clientSecret = await password({
      message: current.clientSecret
        ? 'Google Cloud OAuth2 Client Secret (leave blank to keep existing):'
        : 'Google Cloud OAuth2 Client Secret:',
      mask: '*'
    });

    const googleAdsVersion = await input({
      message: 'Google Ads REST API Version:',
      default: current.googleAdsVersion || 'v24'
    });

    const updated = {
      ...current,
      customerId: customerId.replace(/-/g, '').trim(),
      loginCustomerId: loginCustomerId.replace(/-/g, '').trim(),
      developerToken: developerToken.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret ? clientSecret.trim() : current.clientSecret,
      googleAdsVersion: googleAdsVersion.trim() || 'v24'
    };

    if (!saveConfig(updated)) {
      console.error(chalk.red(`Failed to write ${CONFIG_PATH}`));
      process.exit(1);
    }
    console.log(chalk.green(`\n✔ Credentials saved to ${CONFIG_PATH}`));

    const runAuthNow = await confirm({
      message: 'Launch browser OAuth2 login flow now (http://localhost:8085) to obtain refresh token?',
      default: !updated.refreshToken
    });

    if (runAuthNow) {
      await runOAuthFlow();
    }

    const registerMcp = await confirm({
      message: `Register swa-google-ads-mcp in Antigravity (${getAgyMcpConfigPath()})?`,
      default: true
    });

    if (registerMcp) {
      const p = installIntoAntigravity();
      console.log(chalk.green(`✔ Registered in ${p}`));
      console.log(chalk.yellow('Restart your Antigravity session or run /mcp reload so the 56 Google Ads tools appear.'));
    }
  });

program
  .command('auth')
  .description('Run OAuth2 loopback authorization flow on port 8085 to obtain/renew Refresh & Access Tokens')
  .action(async () => {
    await runOAuthFlow();
  });

program
  .command('refresh-token')
  .description('Refresh OAuth2 Access Token non-interactively using stored refreshToken')
  .action(async () => {
    await refreshAccessToken();
    console.log(chalk.green('✔ OAuth2 access token refreshed and persisted to config.json.'));
  });

program
  .command('install-agy')
  .description('Register swa-google-ads-mcp inside ~/.gemini/config/mcp_config.json for Antigravity')
  .option('--dry-run', 'Preview mcp_config.json changes without writing')
  .action((opts) => {
    const outPath = installIntoAntigravity({ dryRun: Boolean(opts.dryRun) });
    if (!opts.dryRun) {
      console.log(chalk.green(`✔ Registered swa-google-ads-mcp in ${outPath}`));
      console.log(chalk.gray('Note: Start a new agy session to load the registered MCP tools.'));
    }
  });

program
  .command('uninstall-agy')
  .description('Remove swa-google-ads-mcp from ~/.gemini/config/mcp_config.json')
  .action(() => {
    const mcpConfigPath = getAgyMcpConfigPath();
    if (!fs.existsSync(mcpConfigPath)) {
      console.log(chalk.yellow('No mcp_config.json file found.'));
      return;
    }
    const raw = fs.readFileSync(mcpConfigPath, 'utf8').trim();
    const json = raw ? JSON.parse(raw) : {};
    if (json.mcpServers && json.mcpServers['swa-google-ads-mcp']) {
      delete json.mcpServers['swa-google-ads-mcp'];
      fs.writeFileSync(mcpConfigPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      console.log(chalk.green(`✔ Removed swa-google-ads-mcp from ${mcpConfigPath}`));
    } else {
      console.log(chalk.yellow('swa-google-ads-mcp is not currently registered in mcp_config.json.'));
    }
  });

program
  .command('status')
  .alias('doctor')
  .description('Check config.json, OAuth2 token expiry, Antigravity MCP registration, and optional live API check')
  .option('--live', 'Perform live customers:listAccessibleCustomers check against Google Ads API')
  .action(async (opts) => {
    const cfg = getConfig();
    const mcpConfigPath = getAgyMcpConfigPath();
    let isRegistered = false;
    try {
      if (fs.existsSync(mcpConfigPath)) {
        const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8') || '{}');
        isRegistered = Boolean(parsed?.mcpServers?.['swa-google-ads-mcp']);
      }
    } catch {
      isRegistered = false;
    }

    const tokenRemainingSec = cfg.tokenExpiry ? Math.round((cfg.tokenExpiry - Date.now()) / 1000) : 0;

    console.log(chalk.bold.cyan('\n=== SWA Google Ads MCP — Diagnostics ===\n'));
    console.log(`Config File:       ${CONFIG_PATH} ${fs.existsSync(CONFIG_PATH) ? chalk.green('(exists)') : chalk.yellow('(missing)')}`);
    console.log(`API Version:       ${chalk.white(cfg.googleAdsVersion || 'v24')}`);
    console.log(`Customer ID:       ${cfg.customerId ? chalk.green(cfg.customerId) : chalk.yellow('(not set)')}`);
    console.log(`Login Customer ID: ${cfg.loginCustomerId ? chalk.green(cfg.loginCustomerId) : chalk.gray('(none)')}`);
    console.log(`Developer Token:   ${maskSecret(cfg.developerToken)}`);
    console.log(`OAuth Client ID:   ${maskSecret(cfg.clientId)}`);
    console.log(`Refresh Token:     ${maskSecret(cfg.refreshToken)}`);
    console.log(
      `Access Token:      ${cfg.accessToken ? (tokenRemainingSec > 0 ? chalk.green(`valid (${tokenRemainingSec}s left)`) : chalk.yellow('expired (auto-refreshes)')) : chalk.gray('(none yet)')}`
    );
    console.log(`Antigravity MCP:   ${isRegistered ? chalk.green('Registered') : chalk.yellow('Not registered (run install-agy)')}`);

    if (opts.live) {
      console.log(chalk.cyan('\nTesting Google Ads API connectivity (customers:listAccessibleCustomers)...'));
      try {
        const res = await apiGet('customers:listAccessibleCustomers', {}, 'doctor');
        console.log(chalk.green(`✔ Connected! Accessible customers (${(res.resourceNames || []).length}):`));
        (res.resourceNames || []).forEach((rn) => console.log(`  - ${rn}`));
      } catch (err) {
        console.error(chalk.red(`✖ API test failed: ${err.message}`));
        process.exitCode = 1;
      }
    }
    console.log('');
  });

program
  .command('list-tools')
  .description('List all MCP tools registered by swa-google-ads-mcp')
  .action(() => {
    const server = createSwaGoogleAdsMcpServer();
    const tools = Object.entries(server._registeredTools || {});
    console.log(chalk.bold.cyan(`\n=== Registered MCP Tools (${tools.length}) ===\n`));
    for (const [name, def] of tools) {
      const mode = def.annotations?.readOnlyHint ? chalk.blue('[READ]  ') : chalk.magenta('[MUTATE]');
      console.log(`${mode} ${chalk.bold.white(name.padEnd(34))} ${chalk.gray(def.title || '')}`);
    }
    console.log('');
  });

// Suppress unused import warning while keeping mcpToolHandler reference clean
void mcpToolHandler;

program.parse(process.argv);
