'use strict';
// ChatGPT / Codex usage: the same numbers `codex` shows with /status.
// GET https://chatgpt.com/backend-api/wham/usage  ->  rate_limit.{primary,secondary}_window
// OpenAI assigns "primary"/"secondary" differently per plan, so windows are classified by
// their length (≈5 h → session ring, ≈7 d → weekly ring), not by slot.

const { ApiError } = require('./usage');

const URL_USAGE = 'https://chatgpt.com/backend-api/wham/usage';
const HOUR = 3600 * 1000;

async function fetchUsage(fetchImpl, tokens, userAgent) {
  const headers = { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json', 'User-Agent': userAgent };
  if (tokens.accountId) headers['chatgpt-account-id'] = tokens.accountId;
  const res = await fetchImpl(URL_USAGE, { headers });
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ApiError(`HTTP ${res.status} from usage`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0);
  }
  return res.json();
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function windowOf(w, now) {
  if (!w || typeof w !== 'object') return null;
  const pct = num(w.used_percent ?? w.utilization);
  if (pct == null) return null;
  const windowMs = num(w.limit_window_seconds) ? w.limit_window_seconds * 1000 : null;
  let resetsAt = null;
  if (num(w.reset_at)) resetsAt = w.reset_at < 1e12 ? w.reset_at * 1000 : w.reset_at;
  else if (num(w.reset_after_seconds)) resetsAt = now + w.reset_after_seconds * 1000;
  return { pct: Math.min(100, Math.max(0, pct)), resetsAt, windowMs };
}

function parseUsage(raw, now = Date.now()) {
  const out = { fiveHour: null, sevenDay: null, scoped: [] };
  if (!raw || typeof raw !== 'object') return out;
  const rl = raw.rate_limit ?? raw.rate_limits ?? {};
  const wins = [windowOf(rl.primary_window, now), windowOf(rl.secondary_window, now)].filter(Boolean);
  for (const w of wins) {
    const isWeek = w.windowMs ? w.windowMs > 24 * HOUR : false;
    if (isWeek && !out.sevenDay) out.sevenDay = w;
    else if (!isWeek && !out.fiveHour) out.fiveHour = w;
  }
  // Fallback when lengths are unknown: primary = session, secondary = weekly.
  if (!out.fiveHour && !out.sevenDay && wins.length) {
    out.fiveHour = wins[0];
    out.sevenDay = wins[1] ?? null;
  }
  if (Array.isArray(raw.additional_rate_limits)) {
    for (const e of raw.additional_rate_limits) {
      const w = windowOf(e?.rate_limit?.secondary_window ?? e?.rate_limit?.primary_window ?? e?.primary_window, now);
      const label = e?.limit_name ?? e?.metered_feature ?? e?.name;
      if (w && label) out.scoped.push({ label: String(label), ...w });
    }
  }
  return out;
}

module.exports = { fetchUsage, parseUsage };
