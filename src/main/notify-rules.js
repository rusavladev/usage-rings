'use strict';
// Pure notification logic (no Electron) so it can be unit-tested.
//
// A Tracker remembers, per account and per window, what we've already told you about,
// and turns each fresh usage sample into zero or more notifications.

const MIN = 60 * 1000;
const HISTORY_MS = 3 * 60 * MIN;
const WINDOW_LABEL = { fiveHour: '5-hour session', sevenDay: 'Weekly limit' };

const DEFAULT_NOTIFY = {
  enabled: true,
  thresholds: [75, 90, 100], // % USED that triggers an alert
  spike: { enabled: true, pct: 10, minutes: 10 },
  reset: { enabled: true },
  pace: { enabled: true, minutes: 30 },
  auth: { enabled: true },
};

/** Merge a (possibly partial / untrusted) patch into a full, validated settings object. */
function normalizeNotify(raw) {
  const d = DEFAULT_NOTIFY;
  const r = raw && typeof raw === 'object' ? raw : {};
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const int = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : def);
  const th = Array.isArray(r.thresholds) ? r.thresholds : d.thresholds;
  return {
    enabled: bool(r.enabled, d.enabled),
    thresholds: [...new Set(th.map((n) => int(n, null, 1, 100)).filter((n) => n != null))].sort((a, b) => a - b),
    spike: {
      enabled: bool(r.spike?.enabled, d.spike.enabled),
      pct: int(r.spike?.pct, d.spike.pct, 1, 100),
      minutes: int(r.spike?.minutes, d.spike.minutes, 1, 180),
    },
    reset: { enabled: bool(r.reset?.enabled, d.reset.enabled) },
    pace: { enabled: bool(r.pace?.enabled, d.pace.enabled), minutes: int(r.pace?.minutes, d.pace.minutes, 5, 240) },
    auth: { enabled: bool(r.auth?.enabled, d.auth.enabled) },
  };
}

const fmtDur = (ms) => {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
};

class Tracker {
  constructor() {
    this.acc = new Map(); // accountId -> { fiveHour: winState, sevenDay: winState, status }
  }

  forget(id) {
    this.acc.delete(id);
  }

  _win(id, key) {
    if (!this.acc.has(id)) this.acc.set(id, { status: null });
    const a = this.acc.get(id);
    if (!a[key]) a[key] = { history: [], fired: new Set(), lastPct: null, lastReset: null, lastSpike: -Infinity, first: true };
    return a[key];
  }

  /**
   * @param {{id:string,label:string,status:string,usage:object|null}} acc
   * @param {object} settings  normalised notify settings
   * @returns {Array<{kind:string,title:string,body:string}>}
   */
  evaluate(acc, settings, now = Date.now()) {
    const out = [];
    if (!settings.enabled) return out;

    // sign-in problems
    const a = this.acc.get(acc.id) || (this.acc.set(acc.id, { status: null }), this.acc.get(acc.id));
    if (acc.status !== a.status) {
      if (acc.status === 'needs-login' && settings.auth.enabled) {
        out.push({ kind: 'auth', title: `${acc.label}: sign-in expired`, body: 'Open Usage Rings and sign in again to keep tracking this account.' });
      }
      a.status = acc.status;
    }
    if (!acc.usage || acc.status !== 'ok') return out;

    for (const key of ['fiveHour', 'sevenDay']) {
      const w = acc.usage[key];
      if (!w) continue;
      const st = this._win(acc.id, key);
      const name = WINDOW_LABEL[key];
      const pct = w.pct;

      // ── window reset detected: usage dropped sharply, or the reset time jumped forward
      const dropped = st.lastPct != null && st.lastPct - pct >= 5;
      const jumped = st.lastReset != null && w.resetsAt != null && w.resetsAt - st.lastReset > 30 * MIN;
      if (dropped || jumped) {
        if (settings.reset.enabled && st.lastPct != null && st.lastPct >= 30) {
          out.push({ kind: 'reset', title: `${acc.label}: ${name} reset`, body: `Fresh window – you're at ${Math.round(pct)}% used (was ${Math.round(st.lastPct)}%).` });
        }
        st.fired.clear();
        st.history = [];
      }

      // ── thresholds (first sample after launch only seeds state – no startup spam)
      for (const t of settings.thresholds) {
        const k = `t${t}`;
        if (pct >= t - 1e-9) {
          if (!st.fired.has(k)) {
            st.fired.add(k);
            if (!st.first) {
              const left = Math.max(0, 100 - pct);
              out.push({
                kind: 'threshold',
                title: t >= 100 ? `${acc.label}: ${name} limit reached` : `${acc.label}: ${name} at ${Math.round(pct)}%`,
                body:
                  t >= 100
                    ? `You're out until it resets${w.resetsAt ? ` in ${fmtDur(w.resetsAt - now)}` : ''}.`
                    : `${Math.round(left)}% left${w.resetsAt ? ` · resets in ${fmtDur(w.resetsAt - now)}` : ''}.`,
              });
            }
          }
        } else {
          st.fired.delete(k);
        }
      }

      // ── usage spike: ≥ X% within the last Y minutes
      st.history.push({ t: now, pct });
      st.history = st.history.filter((s) => now - s.t <= HISTORY_MS);
      if (settings.spike.enabled && !st.first) {
        const spanMs = settings.spike.minutes * MIN;
        const inWindow = st.history.filter((s) => now - s.t <= spanMs + 30 * 1000 && s !== st.history[st.history.length - 1]);
        const base = inWindow[0] || st.history[st.history.length - 2];
        if (base) {
          const delta = pct - base.pct;
          if (delta >= settings.spike.pct && now - st.lastSpike > spanMs) {
            st.lastSpike = now;
            out.push({
              kind: 'spike',
              title: `${acc.label}: heavy usage`,
              body: `${name} jumped +${Math.round(delta)}% in the last ${Math.max(1, Math.round((now - base.t) / MIN))} min (now ${Math.round(pct)}%).`,
            });
          }
        }
      }

      // ── pace: at the current burn rate you'll run dry well before the reset
      if (settings.pace.enabled && w.resetsAt != null && pct >= 10 && pct < 100) {
        const windowMs = w.windowMs || (key === 'fiveHour' ? 5 * 60 * MIN : 7 * 24 * 60 * MIN);
        const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / windowMs));
        if (elapsed >= 0.1) {
          const hitIn = ((100 - pct) / pct) * elapsed * windowMs;
          const untilReset = w.resetsAt - now;
          const k = 'pace';
          if (hitIn < untilReset && hitIn <= settings.pace.minutes * MIN) {
            if (!st.fired.has(k)) {
              st.fired.add(k);
              if (!st.first) {
                out.push({
                  kind: 'pace',
                  title: `${acc.label}: slow down`,
                  body: `At this pace ${name.toLowerCase()} runs out in ~${fmtDur(hitIn)} – ${fmtDur(untilReset)} before it resets.`,
                });
              }
            }
          } else if (hitIn > settings.pace.minutes * MIN * 1.5 || hitIn >= untilReset) {
            st.fired.delete(k);
          }
        }
      }

      st.lastPct = pct;
      st.lastReset = w.resetsAt;
      st.first = false;
    }
    return out;
  }
}

module.exports = { Tracker, normalizeNotify, DEFAULT_NOTIFY };
