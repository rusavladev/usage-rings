'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsage, parseProfile, elapsedFraction, FIVE_HOURS } = require('../src/main/usage');
const { renderRings, levelFor } = require('../src/main/rings');

test('parses the flat legacy usage shape', () => {
  const u = parseUsage({
    five_hour: { utilization: 35, resets_at: '2026-10-21T18:00:00Z' },
    seven_day: { utilization: 14.5, resets_at: '2026-10-25T09:00:00Z' },
    seven_day_opus: { utilization: 60, resets_at: '2026-10-25T09:00:00Z' },
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false },
  });
  assert.equal(u.fiveHour.pct, 35);
  assert.equal(u.fiveHour.resetsAt, Date.parse('2026-10-21T18:00:00Z'));
  assert.equal(u.sevenDay.pct, 14.5);
  assert.deepEqual(u.scoped.map((s) => s.label), ['Opus']);
});

test('parses the structured limits array', () => {
  const u = parseUsage({
    limits: [
      { kind: 'session', percent: 12, resets_at: '2026-10-21T18:00:00Z' },
      { kind: 'weekly_all', percent: 40, resets_at: '2026-10-25T09:00:00Z' },
      { kind: 'weekly_scoped', scope: 'sonnet', percent: 8, resets_at: '2026-10-25T09:00:00Z' },
    ],
  });
  assert.equal(u.fiveHour.pct, 12);
  assert.equal(u.sevenDay.pct, 40);
  assert.equal(u.scoped[0].label, 'Sonnet');
});

test('tolerates nulls, garbage and out-of-range values', () => {
  assert.deepEqual(parseUsage(null), { fiveHour: null, sevenDay: null, scoped: [] });
  const u = parseUsage({ five_hour: { utilization: 140, resets_at: null }, seven_day: 'nope' });
  assert.equal(u.fiveHour.pct, 100);
  assert.equal(u.fiveHour.resetsAt, null);
  assert.equal(u.sevenDay, null);
});

test('derives the plan name from a profile', () => {
  assert.equal(parseProfile({ account: { email: 'a@b.c' }, organization: { rate_limit_tier: 'default_claude_max_5x' } }).plan, 'Max 5x');
  assert.equal(parseProfile({ account: { has_claude_pro: true } }).plan, 'Pro');
});

test('elapsedFraction clamps and handles unknown resets', () => {
  const now = 1_000_000;
  assert.equal(elapsedFraction(null, FIVE_HOURS, now), null);
  assert.equal(elapsedFraction(now + FIVE_HOURS / 2, FIVE_HOURS, now), 0.5);
  assert.equal(elapsedFraction(now - 1, FIVE_HOURS, now), 1);
});

test('rings rasteriser returns a full RGBA buffer with visible pixels', () => {
  const buf = renderRings({ size: 16, rings: [{ pct: 50, elapsed: 0.4 }, { pct: 20, elapsed: 0.1 }] });
  assert.equal(buf.length, 16 * 16 * 4);
  assert.ok(buf.some((v, i) => i % 4 === 3 && v > 0));
  assert.equal(levelFor(10), 'ok');
  assert.equal(levelFor(70), 'warn');
  assert.equal(levelFor(95), 'hot');
});

test('names per-model limits whose scope is an object (e.g. Fable)', () => {
  const u = parseUsage({
    five_hour: { utilization: 39, resets_at: '2026-10-21T16:09:59+00:00' },
    seven_day: { utilization: 11, resets_at: '2026-10-28T02:59:59+00:00' },
    seven_day_opus: null,
    limits: [
      { kind: 'session', percent: 39, resets_at: '2026-10-21T16:09:59+00:00', scope: null },
      { kind: 'weekly_all', percent: 11, resets_at: '2026-10-28T02:59:59+00:00', scope: null },
      { kind: 'weekly_scoped', percent: 0, resets_at: '2026-10-28T03:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      { kind: 'weekly_scoped', percent: 5, resets_at: '2026-10-28T03:00:00+00:00', scope: { model: { id: 'claude-sonnet-4-5', display_name: null } } },
    ],
  });
  assert.deepEqual(u.scoped.map((s) => s.label), ['Fable', 'Sonnet 4.5']);
  assert.equal(u.scoped[1].pct, 5);
});
