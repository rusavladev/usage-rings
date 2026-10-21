'use strict';
// Fake accounts for `npm run demo` and for generating README screenshots. No network, no tokens.

const H = 60 * 60 * 1000;
const D = 24 * H;

function demoAccounts(now = Date.now()) {
  const mk = (id, label, email, plan, five, week, scoped = [], provider = 'claude', color = '#4c8dff') => ({
    id,
    provider,
    color,
    label,
    email,
    plan,
    tokens: null,
    status: 'ok',
    error: null,
    fetchedAt: now,
    usage: { fiveHour: five, sevenDay: week, scoped },
  });
  return [
    mk('demo-1', 'Personal', 'you@example.com', 'Max 5x',
      { pct: 42, resetsAt: now + 3.2 * H },
      { pct: 31, resetsAt: now + 4.1 * D },
      [{ label: 'Opus', pct: 55, resetsAt: now + 4.1 * D }, { label: 'Sonnet', pct: 12, resetsAt: now + 4.1 * D }], 'claude', '#4c8dff'),
    mk('demo-2', 'Work', 'dev@acme.dev', 'Team',
      { pct: 78, resetsAt: now + 1.1 * H },
      { pct: 52, resetsAt: now + 2.6 * D }, [], 'openai', '#a56bff'),
    mk('demo-3', 'Side project', 'hacker@example.org', 'Pro',
      { pct: 94, resetsAt: now + 0.6 * H },
      { pct: 88, resetsAt: now + 1.3 * D }, [], 'claude', '#ff5fa2'),
    mk('demo-4', 'Research', 'lab@example.edu', 'Max 20x',
      { pct: 6, resetsAt: now + 4.7 * H },
      { pct: 14, resetsAt: now + 6.2 * D }, [], 'openai', '#19c8e6'),
  ];
}

module.exports = { demoAccounts };
