'use strict';
// OAuth 2.0 + PKCE sign-in with a loopback redirect, for each supported provider.
// Both use the public client IDs of the vendors' own CLIs (Claude Code / Codex CLI).
// Each sign-in runs in a throw-away in-memory browser session so you can add as many
// different accounts as you like without logging out of anything.

const http = require('http');
const crypto = require('crypto');
const { BrowserWindow, shell } = require('electron');

const PROVIDERS = {
  claude: {
    name: 'Claude',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    // Read-only scope: just enough to look at plan/usage.
    scope: 'user:profile',
    callbackPath: '/callback',
    port: 0,
    extraParams: { code: 'true' },
    exchangeAs: 'json',
    refreshExtra: {},
  },
  openai: {
    name: 'ChatGPT',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    callbackPath: '/auth/callback',
    port: 1455, // the only loopback port registered for this client
    extraParams: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' },
    exchangeAs: 'form',
    refreshExtra: { scope: 'openid profile email' },
  },
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const b64url = (buf) => buf.toString('base64url');

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Pull what we can about the account out of an OpenAI id_token / access_token. */
function openaiProfile(tokens) {
  const id = jwtClaims(tokens.idToken);
  const at = jwtClaims(tokens.accessToken);
  const auth = id['https://api.openai.com/auth'] || at['https://api.openai.com/auth'] || {};
  const prof = at['https://api.openai.com/profile'] || {};
  return {
    email: id.email || prof.email || null,
    name: id.name || null,
    plan: auth.chatgpt_plan_type || null,
    accountId: auth.chatgpt_account_id || null,
  };
}

function successPage(ok, message) {
  const color = ok ? '#3dd6a0' : '#ff6358';
  return `<!doctype html><meta charset="utf-8"><title>Usage Rings</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#14151a;color:#ececf1;font:16px 'Segoe UI',system-ui,sans-serif">
<div style="text-align:center"><div style="width:64px;height:64px;border-radius:50%;border:6px solid ${color};margin:0 auto 20px"></div>
<h2 style="margin:0 0 8px">${message}</h2><p style="color:#8b8d98;margin:0">You can close this window.</p></div></body>`;
}

async function postToken(fetchImpl, provider, body, userAgent, as = 'json') {
  const p = PROVIDERS[provider];
  const res = await fetchImpl(p.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': as === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
    body: as === 'form' ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || !json?.access_token) {
    const code = json?.error === 'invalid_grant' || res.status === 400 || res.status === 401 ? 'invalid_grant' : 'http';
    throw new AuthError(`Token request failed (HTTP ${res.status}${json?.error ? `: ${json.error}` : ''})`, code);
  }
  const exp = Number(json.expires_in) ? Date.now() + Number(json.expires_in) * 1000 : (jwtClaims(json.access_token).exp || 0) * 1000;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    expiresAt: exp || Date.now() + 3600 * 1000,
  };
}

async function refresh(fetchImpl, provider, tokens, userAgent) {
  if (!tokens?.refreshToken) throw new AuthError('No refresh token', 'invalid_grant');
  const p = PROVIDERS[provider];
  const t = await postToken(
    fetchImpl,
    provider,
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: p.clientId, ...p.refreshExtra },
    userAgent,
    'json',
  );
  return { ...tokens, ...t, refreshToken: t.refreshToken || tokens.refreshToken, idToken: t.idToken || tokens.idToken };
}

/**
 * Runs the full browser sign-in. mode: 'window' (clean in-app window) | 'browser' (system browser).
 * Resolves with { tokens, profile } (profile is only filled for providers that give it in the token).
 */
function login(fetchImpl, { provider = 'claude', mode = 'window', userAgent, parent } = {}) {
  const p = PROVIDERS[provider];
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32)); // 43 chars, like the official CLIs (shorter values may be rejected)

  return new Promise((resolve, reject) => {
    let win = null;
    let done = false;
    let timer = null;
    let redirectUri = '';
    const servers = [];

    const handler = async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== p.callbackPath) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (err || !code || url.searchParams.get('state') !== state) {
        res.end(successPage(false, err ? `Sign-in failed: ${err}` : 'Sign-in failed'));
        finish(new AuthError(err || 'State mismatch or missing code', 'denied'));
        return;
      }
      try {
        const body = {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: p.clientId,
          code_verifier: verifier,
        };
        if (provider === 'claude') body.state = state;
        const tokens = await postToken(fetchImpl, provider, body, userAgent, p.exchangeAs);
        res.end(successPage(true, 'Account connected'));
        finish(null, { tokens, profile: provider === 'openai' ? openaiProfile(tokens) : {} });
      } catch (e) {
        res.end(successPage(false, 'Could not finish sign-in'));
        finish(e);
      }
    };

    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      servers.forEach((s) => s.close());
      if (win && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.close(), 600);
      if (err) reject(err);
      else resolve(value);
    }

    const primary = http.createServer(handler);
    servers.push(primary);
    primary.on('error', (e) =>
      finish(e.code === 'EADDRINUSE' ? new AuthError(`Port ${p.port} is busy (is another ${p.name} CLI sign-in running?)`, 'port') : e),
    );
    primary.listen(p.port, '127.0.0.1', () => {
      const port = primary.address().port;
      redirectUri = `http://localhost:${port}${p.callbackPath}`;
      if (p.port) {
        // "localhost" may resolve to ::1 – listen there too (best effort)
        const v6 = http.createServer(handler);
        v6.on('error', () => {});
        v6.listen(port, '::1');
        servers.push(v6);
      }

      const url = new URL(p.authorizeUrl);
      url.search = new URLSearchParams({
        ...p.extraParams,
        client_id: p.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: p.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();

      timer = setTimeout(() => finish(new AuthError('Sign-in timed out', 'timeout')), LOGIN_TIMEOUT_MS);

      if (mode === 'browser') {
        shell.openExternal(url.toString());
        return;
      }
      win = new BrowserWindow({
        width: 540,
        height: 780,
        title: `Sign in to ${p.name}`,
        autoHideMenuBar: true,
        parent,
        webPreferences: { partition: `login-${state}`, sandbox: true, contextIsolation: true },
      });
      win.webContents.setUserAgent(CHROME_UA);
      win.on('closed', () => finish(new AuthError('Sign-in window closed', 'cancelled')));
      win.loadURL(url.toString()).catch((e) => finish(e));
    });
  });
}

module.exports = { login, refresh, AuthError, PROVIDERS, openaiProfile };
