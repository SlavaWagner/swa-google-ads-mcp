import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toMicros, fromMicros, buildDateClause, normalizeCustomerId } from '../src/googleAdsClient.js';
import { validateRsaFields, buildBiddingStrategyPatch } from '../src/tools/mutateTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function runProcess(command, args, { env = {}, input = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });

    if (input !== null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function testHelpers() {
  assert.equal(normalizeCustomerId('123-456-7890'), '1234567890');
  assert.equal(toMicros(26.25), '26250000');
  assert.equal(fromMicros('26250000'), 26.25);
  assert.equal(buildDateClause({ dateRange: 'LAST_7_DAYS' }), 'segments.date DURING LAST_7_DAYS');
  assert.equal(
    buildDateClause({ startDate: '2026-10-01', endDate: '2026-10-31', field: 'change_event.change_date_time' }),
    "change_event.change_date_time BETWEEN '2026-10-01' AND '2026-10-31'"
  );

  // RSA pre-flight validation
  assert.throws(
    () => validateRsaFields({ headlines: ['One', 'Two'], descriptions: ['Desc 1', 'Desc 2'] }),
    /3 to 15 headlines/
  );
  assert.throws(
    () =>
      validateRsaFields({
        headlines: ['H1', 'H2', 'This Headline Is Definitely Longer Than Thirty Characters'],
        descriptions: ['D1', 'D2']
      }),
    /exceeds 30 chars/
  );
  validateRsaFields({
    headlines: ['Headline One', 'Headline Two', 'Headline Three'],
    descriptions: ['First clean description under 90 chars', 'Second clean description under 90 chars']
  });

  // Bidding strategy builder
  const tcpaPatch = buildBiddingStrategyPatch({ bidding_strategy_type: 'MAXIMIZE_CONVERSIONS', target_cpa: 26.25 });
  assert.equal(tcpaPatch.payload.maximizeConversions.targetCpaMicros, '26250000');
  assert.equal(tcpaPatch.updateMask, 'maximizeConversions.targetCpaMicros');

  console.log('✔ Unit helper & validation tests passed.');
}

async function testAntigravityGuard() {
  // Strip any ANTIGRAVITY_*, AGY_* env vars so we simulate plain shell
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('ANTIGRAVITY_') && !k.startsWith('AGY_') && k !== 'AGY') {
      cleanEnv[k] = v;
    }
  }

  const cliBlocked = await runProcess(process.execPath, ['bin/cli.js', 'list-tools'], { env: cleanEnv });
  assert.ok(
    cliBlocked.stdout.includes('PREREQUISITE REQUIRED: GOOGLE ANTIGRAVITY CLI'),
    'CLI should show Antigravity prerequisite warning when launched outside agy.'
  );

  const mcpBlocked = await runProcess(process.execPath, ['bin/mcp-server.js'], { env: cleanEnv });
  assert.equal(mcpBlocked.code, 1, 'MCP server must exit 1 outside Antigravity.');
  assert.ok(
    mcpBlocked.stderr.includes('PREREQUISITE REQUIRED: GOOGLE ANTIGRAVITY CLI'),
    'MCP server must write guard warning to stderr outside Antigravity.'
  );

  console.log('✔ Antigravity-only guard tests (CLI + MCP block outside agy) passed.');
}

async function testLiveMcpStdioProtocol() {
  const tempCfgPath = path.join(os.tmpdir(), `swa-gads-test-${Date.now()}.json`);
  fs.writeFileSync(
    tempCfgPath,
    JSON.stringify({
      customerId: '1234567890',
      developerToken: 'TEST_DEV_TOKEN',
      clientId: 'TEST_CLIENT_ID',
      clientSecret: 'TEST_CLIENT_SECRET',
      accessToken: 'TEST_ACCESS_TOKEN',
      tokenExpiry: Date.now() + 3600 * 1000,
      googleAdsVersion: 'v24'
    })
  );

  try {
    const child = spawn(process.execPath, ['bin/mcp-server.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        AGY_SESSION: '1',
        SWA_GOOGLE_ADS_CONFIG: tempCfgPath
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const responses = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
    });

    const sendRpc = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

    sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verify-test', version: '1.0.0' }
      }
    });

    sendRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    // Call #1: dry-run preview inside apply_or_dismiss_recommendation
    sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'apply_or_dismiss_recommendation',
        arguments: {
          customer_id: '123-456-7890',
          action: 'DISMISS',
          recommendation_resource_names: ['999888777'],
          validate_only: true
        }
      }
    });

    // Call #2: pre-flight validation inside create_ad over live MCP stdio
    sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'create_ad',
        arguments: {
          ad_group_id: '11223344',
          ad_type: 'RESPONSIVE_SEARCH_AD',
          final_urls: ['https://example.com'],
          headlines: ['Short 1', 'Short 2', 'This Headline Exceeds Google Ads 30 Char Limit'],
          descriptions: ['Valid description one under ninety chars.', 'Valid description two under ninety chars.']
        }
      }
    });

    // Wait until all 4 responses arrive (max 6s)
    const start = Date.now();
    while (responses.length < 4 && Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();

    const initResp = responses.find((r) => r.id === 1);
    const listResp = responses.find((r) => r.id === 2);
    const callResp = responses.find((r) => r.id === 3);
    const adValidationResp = responses.find((r) => r.id === 4);

    assert.ok(initResp?.result?.serverInfo?.name === 'swa-google-ads-mcp', 'MCP initialize handshake failed.');
    assert.ok(Array.isArray(listResp?.result?.tools), 'tools/list did not return tools array.');
    assert.equal(listResp.result.tools.length, 56, `Expected 56 MCP tools, got ${listResp.result.tools.length}`);

    for (const t of listResp.result.tools) {
      assert.equal(t.inputSchema?.type, 'object', `Tool ${t.name} must expose JSON Schema object inputSchema.`);
    }

    const callPayload = JSON.parse(callResp.result.content[0].text);
    assert.equal(callPayload.dryRunPreview, true);
    assert.equal(callPayload.customerId, '1234567890');
    assert.equal(callPayload.operations[0].resourceName, 'customers/1234567890/recommendations/999888777');

    assert.equal(adValidationResp.result.isError, true, 'Invalid RSA headline length should return structured MCP isError.');
    const adErrPayload = JSON.parse(adValidationResp.result.content[0].text);
    assert.match(adErrPayload.message, /exceeds 30 chars/);

    console.log(`✔ Live MCP JSON-RPC Stdio test passed (${listResp.result.tools.length} tools + schemas + tools/call verified end-to-end).`);
  } finally {
    if (fs.existsSync(tempCfgPath)) fs.unlinkSync(tempCfgPath);
  }
}

async function run() {
  console.log('\nRunning swa-google-ads-mcp verification suite...\n');
  await testHelpers();
  await testAntigravityGuard();
  await testLiveMcpStdioProtocol();
  console.log('\nAll verification checks PASSED.\n');
}

run().catch((err) => {
  console.error('\n✖ Verification failed:', err);
  process.exit(1);
});
