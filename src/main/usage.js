'use strict';
// Talks to Anthropic's (undocumented) OAuth usage endpoint and normalises the response.
//
// The same endpoint powers `/usage` in Claude Code. Its shape has changed over time, so
// parseUsage() understands both the flat legacy keys (five_hour / seven_day / seven_day_opus ...)
// and the newer structured `limits` array.

const API = 'https://api.anthropic.com';
const BETA = 'oauth-2025-04-20';
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

class ApiError extends Error {
  constructor(message, status, retryAfterMs) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function apiGet(fetchImpl, pathName, accessToken, userAgent) {
  const res = await fetchImpl(API + pathName, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': BETA,
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
  });
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ApiError(`HTTP ${res.status} from ${pathName}`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
  }
  return res.json();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ts = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // unix seconds or ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

function windowOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const pct = num(obj.utilization ?? obj.percent ?? obj.used_percentage ?? obj.percentage);
  if (pct == null) return null;
  return { pct: Math.min(100, Math.max(0, pct)), resetsAt: ts(obj.resets_at ?? obj.reset_at) };
}

const prettyScope = (s) =>
  String(s)
    .replace(/^seven_day_?/, '')
    .replace(/^claude[-_ ]/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/(\d) (\d)\b/g, '$1.$2') // "5 1" -> "5.1"
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

// The "scope" of a per-model limit can be a plain string or an object ({ display_name, model, id, ... }).
const LABEL_KEYS = ['display_name', 'displayName', 'label', 'title', 'name', 'model_name', 'model', 'scope', 'id', 'key', 'value'];
function scopeText(v, depth = 0) {
  if (v == null || depth > 2) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    for (const k of LABEL_KEYS) {
      const t = scopeText(v[k], depth + 1);
      if (t) return t;
    }
    for (const val of Object.values(v)) if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function parseUsage(raw) {
  const out = { fiveHour: null, sevenDay: null, scoped: [] };
  if (!raw || typeof raw !== 'object') return out;

  // Legacy / flat shape
  out.fiveHour = windowOf(raw.five_hour);
  out.sevenDay = windowOf(raw.seven_day);
  for (const [key, val] of Object.entries(raw)) {
    if (/^seven_day_.+/.test(key)) {
      const w = windowOf(val);
      if (w) out.scoped.push({ label: prettyScope(key), ...w });
    }
  }

  // Structured `limits` array (kind: session | weekly_all | weekly_scoped)
  if (Array.isArray(raw.limits)) {
    for (const l of raw.limits) {
      const w = windowOf(l);
      if (!w) continue;
      if (l.kind === 'session' && !out.fiveHour) out.fiveHour = w;
      else if (l.kind === 'weekly_all' && !out.sevenDay) out.sevenDay = w;
      else if (l.kind === 'weekly_scoped') {
        const label = prettyScope(scopeText(l.display_name ?? l.label ?? l.name) ?? scopeText(l.scope) ?? scopeText(l.model) ?? scopeText(l.id) ?? 'Model');
        if (!out.scoped.some((s) => s.label === label)) out.scoped.push({ label, ...w });
      }
    }
  }
  return out;
}

function parseProfile(raw) {
  const acct = raw?.account ?? {};
  const org = raw?.organization ?? {};
  const tier = String(org.rate_limit_tier ?? '');
  let plan = null;
  const m = tier.match(/max_(\d+)x/i);
  if (m) plan = `Max ${m[1]}x`;
  else if (acct.has_claude_max || /max/i.test(tier)) plan = 'Max';
  else if (acct.has_claude_pro || /pro/i.test(tier)) plan = 'Pro';
  else if (/team/i.test(String(org.organization_type ?? ''))) plan = 'Team';
  else if (/enterprise/i.test(String(org.organization_type ?? ''))) plan = 'Enterprise';
  return {
    email: acct.email ?? acct.email_address ?? null,
    name: acct.display_name ?? acct.full_name ?? null,
    plan,
  };
}

/** Fraction of a window that has already elapsed (0..1), or null when unknown. */
function elapsedFraction(resetsAt, windowMs, now = Date.now()) {
  if (resetsAt == null) return null;
  return Math.min(1, Math.max(0, 1 - (resetsAt - now) / windowMs));
}

module.exports = {
  scopeText,
  prettyScope,
  ApiError,
  FIVE_HOURS,
  SEVEN_DAYS,
  fetchUsage: (fetchImpl, token, ua) => apiGet(fetchImpl, '/api/oauth/usage', token, ua),
  fetchProfile: (fetchImpl, token, ua) => apiGet(fetchImpl, '/api/oauth/profile', token, ua),
  parseUsage,
  parseProfile,
  elapsedFraction,
};
