import http from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import axios from 'axios';
import chalk from 'chalk';
import { getConfig, saveConfig } from './config.js';

/**
 * Starts local OAuth2 loopback redirect server on port 8085 to obtain
 * offline refresh_token & access_token with scope https://www.googleapis.com/auth/adwords.
 * Copied and adapted from SlavaWagner/ai-ads-pipeline/src/auth.js.
 */
export async function runOAuthFlow() {
  const config = getConfig();

  if (!config.clientId || !config.clientSecret) {
    throw new Error('clientId or clientSecret missing in config.json. Run "swa-google-ads-mcp setup" first.');
  }

  const port = 8085;
  const redirectUri = `http://localhost:${port}`;
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent`;

  console.log(chalk.bold.cyan('\n=== Google Ads OAuth2 Authentication (Port 8085) ===\n'));
  console.log(chalk.yellow(`Client ID:      ${config.clientId}`));
  console.log(chalk.yellow(`Customer ID:    ${config.customerId || '(set via setup or per tool call)'}`));
  console.log(chalk.yellow(`Redirect URI:   ${redirectUri}`));
  console.log(chalk.gray('--------------------------------------------------'));
  console.log(chalk.bold.green('\nOpen this authorization link in your browser:\n'));
  console.log(chalk.underline.blue(authUrl));
  console.log(chalk.gray(`\nListening on http://localhost:${port} ... (Timeout: 10 minutes)\n`));

  const openCmd =
    process.platform === 'win32'
      ? `start "" "${authUrl}"`
      : process.platform === 'darwin'
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;

  exec(openCmd, (err) => {
    if (!err) {
      console.log(chalk.cyan('Opened browser automatically.'));
    }
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://localhost:${port}`);

        if (reqUrl.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;">
            <h1 style="color:#e53e3e;">Authorization Failed or Cancelled</h1>
            <p>Google error: <code>${error}</code></p>
          </body></html>`);
          server.close();
          reject(new Error(`OAuth Error from Google: ${error}`));
          return;
        }

        if (code) {
          console.log(chalk.green('✔ Authorization code received. Exchanging for tokens...'));
          try {
            const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
              code,
              client_id: config.clientId,
              client_secret: config.clientSecret,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code'
            });

            const { access_token, refresh_token, expires_in } = tokenResponse.data;
            const updated = { ...config, accessToken: access_token };
            if (refresh_token) {
              updated.refreshToken = refresh_token;
              console.log(chalk.green('✔ New OAuth2 Refresh Token saved.'));
            } else {
              console.log(chalk.yellow('Notice: Google did not return a new refresh_token (existing token kept).'));
            }
            updated.tokenExpiry = Date.now() + ((expires_in || 3600) - 300) * 1000;
            saveConfig(updated);

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0fff4;">
              <h1 style="color:#2f855a;">Google Ads OAuth2 Connected!</h1>
              <p style="font-size:1.1em;color:#2d3748;">Access Token &amp; Refresh Token saved for swa-google-ads-mcp.</p>
              <p style="color:#718096;">You can close this tab and return to Antigravity CLI.</p>
            </body></html>`);

            console.log(chalk.bold.green('\n[OK] Google Ads authentication complete!'));
            server.close();
            resolve({ success: true, accessToken: access_token });
          } catch (tokenErr) {
            const errDetail = tokenErr.response ? JSON.stringify(tokenErr.response.data) : tokenErr.message;
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;">
              <h1 style="color:#e53e3e;">Token Exchange Failed</h1>
              <p>Error: <code>${errDetail}</code></p>
            </body></html>`);
            server.close();
            reject(new Error(`Token exchange failed: ${errDetail}`));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Invalid Request</h1><p>Missing authorization code.</p>');
        }
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.setTimeout(600000);
    server.on('timeout', () => {
      server.close();
      reject(new Error('OAuth authentication timed out after 10 minutes.'));
    });

    server.listen(port, (err) => {
      if (err) reject(err);
    });
  });
}
