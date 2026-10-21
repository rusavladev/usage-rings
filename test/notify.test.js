'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker, normalizeNotify, DEFAULT_NOTIFY } = require('../src/main/notify-rules');

const MIN = 60 * 1000;
const H = 60 * MIN;
const settings = normalizeNotify({});
const mk = (pct, resetsAt, extra = {}) => ({
  id: 'a1',
  label: 'Work',
  status: 'ok',
  usage: { fiveHour: { pct, resetsAt }, sevenDay: null, ...extra },
});

test('normalizeNotify fills defaults and clamps garbage', () => {
  assert.deepEqual(normalizeNotify(undefined), DEFAULT_NOTIFY);
  const n = normalizeNotify({ thresholds: [90, 50, 'x', 500, 50], spike: { pct: -4, minutes: 9999 }, enabled: 'yes' });
  assert.deepEqual(n.thresholds, [50, 90, 100]);
  assert.equal(n.spike.pct, 1);
  assert.equal(n.spike.minutes, 180);
  assert.equal(n.enabled, true);
});

test('does not notify for thresholds already crossed at startup', () => {
  const t = new Tracker();
  assert.equal(t.evaluate(mk(80, 1e12), settings, 0).length, 0);
});

test('notifies once when a threshold is crossed, then again only after a reset', () => {
  const t = new Tracker();
  const reset = 100 * H;
  t.evaluate(mk(60, reset), { ...settings, pace: { enabled: false }, spike: { enabled: false } }, 0);
  const s = { ...settings, pace: { enabled: false, minutes: 30 }, spike: { enabled: false, pct: 10, minutes: 10 } };
  const hit = t.evaluate(mk(76, reset), s, 5 * MIN);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'threshold');
  assert.match(hit[0].title, /76%/);
  assert.equal(t.evaluate(mk(78, reset), s, 10 * MIN).length, 0); // no repeat
  const rst = t.evaluate(mk(2, reset + 5 * H), s, 15 * MIN);
  assert.equal(rst[0].kind, 'reset');
  assert.equal(t.evaluate(mk(80, reset + 5 * H), s, 20 * MIN)[0].kind, 'threshold'); // fires again next cycle
});

test('detects a usage spike inside the configured window', () => {
  const t = new Tracker();
  const s = { ...settings, thresholds: [], pace: { enabled: false, minutes: 30 } };
  const reset = 100 * H;
  t.evaluate(mk(20, reset), s, 0);
  t.evaluate(mk(22, reset), s, 5 * MIN);
  const out = t.evaluate(mk(35, reset), s, 10 * MIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'spike');
  assert.match(out[0].body, /\+15%/);
  assert.equal(t.evaluate(mk(48, reset), s, 12 * MIN).length, 0); // cooldown
});

test('warns when the current pace will exhaust the window early', () => {
  const t = new Tracker();
  const s = { ...settings, thresholds: [], spike: { enabled: false, pct: 10, minutes: 10 } };
  const now = 4 * H; // 4h into a 5h window
  const reset = now + 1 * H;
  t.evaluate(mk(60, reset), s, now);
  const out = t.evaluate(mk(92, reset), s, now + 5 * MIN);
  assert.ok(out.some((n) => n.kind === 'pace'));
});

test('sign-in expiry is reported once; master switch silences everything', () => {
  const t = new Tracker();
  const bad = { id: 'a1', label: 'Work', status: 'needs-login', usage: null };
  assert.equal(t.evaluate(bad, settings, 0)[0].kind, 'auth');
  assert.equal(t.evaluate(bad, settings, 1).length, 0);
  assert.equal(new Tracker().evaluate(bad, { ...settings, enabled: false }, 0).length, 0);
});
