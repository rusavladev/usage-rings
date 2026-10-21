'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Shapes = require('../src/renderer/shapes');
const { renderRings } = require('../src/main/rings');

test('every shape has a monotone outline-fraction table starting at the top', () => {
  for (const id of Shapes.IDS) {
    const L = Shapes.layout(id, 100, 2);
    const { p, N } = L.tab;
    assert.equal(p[0], 0, id);
    assert.equal(p[N], 1, id);
    for (let i = 1; i <= N; i++) assert.ok(p[i] >= p[i - 1] - 1e-5, `${id} not monotone at ${i}`);
    const start = Shapes.pointAt(L.sh, 0);
    assert.ok(Math.abs(start.x) < 1e-6 && start.y < 0, `${id} should start straight up`);
  }
});

test('rings stay inside the canvas and keep a hole for the accent dot', () => {
  for (const id of Shapes.IDS) {
    const L = Shapes.layout(id, 64, 2);
    const { minx, maxx, miny, maxy } = L.sh.bbox;
    for (const v of [L.cx + L.sPx * minx, L.cy + L.sPx * miny]) assert.ok(v >= -1e-6, `${id} leaves canvas`);
    for (const v of [L.cx + L.sPx * maxx, L.cy + L.sPx * maxy]) assert.ok(v <= 64 + 1e-6, `${id} leaves canvas`);
    assert.ok(L.rings[1].dIn > 0.5, `${id} inner ring collapsed`);
    assert.ok(L.rings[0].dIn > L.rings[1].dOut, `${id} rings overlap`);
  }
});

test('every shape rasterises to visible pixels at tray size', () => {
  for (const id of Shapes.IDS) {
    const buf = renderRings({ size: 32, shape: id, accent: [255, 0, 0], rings: [{ pct: 40, elapsed: 0.3 }, { pct: 70, elapsed: 0.6 }] });
    let visible = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) visible++;
    assert.ok(visible > 80, `${id} drew only ${visible} px`);
  }
});

test('SVG path starts at the top and is closed', () => {
  for (const id of Shapes.IDS) {
    const L = Shapes.layout(id, 100, 2);
    const d = Shapes.pathD(L, 0);
    assert.match(d, /^M/);
    assert.match(d, /Z$/);
  }
});
