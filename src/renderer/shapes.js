'use strict';
// Ring shapes. Shared by the main process (tray-icon rasteriser) and the popup (SVG), so it is
// written as a tiny UMD module: `require()` in Node, `window.Shapes` in the page.
//
// Every shape is a closed, star-shaped polygon around its centre, listed clockwise starting at the
// top. A "ring" is that outline scaled about the centre, so rings nest like concentric circles
// and progress is measured as a fraction (0..1) of the outline's length, starting at the top.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shapes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TAU = Math.PI * 2;
  const THETA_N = 1440;

  const LABELS = {
    circle: 'Circle',
    squircle: 'Squircle',
    square: 'Square',
    diamond: 'Diamond',
    triangle: 'Triangle',
    pentagon: 'Pentagon',
    hexagon: 'Hexagon',
    octagon: 'Octagon',
    star: 'Star',
  };

  const regular = (n, vertexUp) =>
    Array.from({ length: n }, (_, k) => {
      const phi = (k * TAU) / n + (vertexUp ? 0 : Math.PI / n);
      return { x: Math.sin(phi), y: -Math.cos(phi) };
    });

  const polar = (count, radius) =>
    Array.from({ length: count }, (_, k) => {
      const phi = (k * TAU) / count;
      const g = radius(phi);
      return { x: g * Math.sin(phi), y: -g * Math.cos(phi) };
    });

  const BUILD = {
    circle: () => polar(360, () => 1),
    squircle: () => polar(360, (phi) => Math.pow(Math.pow(Math.abs(Math.sin(phi)), 4) + Math.pow(Math.abs(Math.cos(phi)), 4), -0.25)),
    square: () => regular(4, false),
    diamond: () => regular(4, true),
    triangle: () => regular(3, true),
    pentagon: () => regular(5, true),
    hexagon: () => regular(6, true),
    octagon: () => regular(8, false),
    star: () => {
      const pts = [];
      for (let k = 0; k < 5; k++) {
        const a = (k * TAU) / 5;
        const b = ((k + 0.5) * TAU) / 5;
        pts.push({ x: Math.sin(a), y: -Math.cos(a) }, { x: 0.45 * Math.sin(b), y: -0.45 * Math.cos(b) });
      }
      return pts;
    },
  };

  /** Rotate/insert so that the outline starts exactly where the straight-up ray hits it. */
  function startAtTop(pts) {
    const n = pts.length;
    const v = pts.findIndex((p) => Math.abs(p.x) < 1e-9 && p.y < 0);
    if (v >= 0) return pts.slice(v).concat(pts.slice(0, v));
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (a.x * b.x < 0) {
        const u = -a.x / (b.x - a.x);
        const y = a.y + u * (b.y - a.y);
        if (y < 0) {
          const mid = { x: 0, y };
          return [mid].concat(pts.slice(i + 1), pts.slice(0, i + 1));
        }
      }
    }
    return pts;
  }

  const cache = new Map();

  function shape(id) {
    if (!BUILD[id]) id = 'circle';
    if (cache.has(id)) return cache.get(id);
    const pts = startAtTop(BUILD[id]());
    const n = pts.length;
    const cum = [0];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const perim = cum[n];
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, inr = Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      minx = Math.min(minx, a.x); maxx = Math.max(maxx, a.x);
      miny = Math.min(miny, a.y); maxy = Math.max(maxy, a.y);
      // distance from the origin to segment a-b
      const ex = b.x - a.x, ey = b.y - a.y;
      const t = Math.max(0, Math.min(1, -(a.x * ex + a.y * ey) / (ex * ex + ey * ey)));
      inr = Math.min(inr, Math.hypot(a.x + t * ex, a.y + t * ey));
    }
    const sh = { id, pts, cum, perim, bbox: { minx, maxx, miny, maxy }, inr, tab: null };
    cache.set(id, sh);
    return sh;
  }

  /** Lookup tables indexed by angle θ (clockwise from up): boundary distance g and outline fraction p. */
  function tables(sh) {
    if (sh.tab) return sh.tab;
    const g = new Float32Array(THETA_N + 1);
    const p = new Float32Array(THETA_N + 1);
    const { pts, cum, perim } = sh;
    const n = pts.length;
    for (let k = 0; k < THETA_N; k++) {
      const th = (k / THETA_N) * TAU;
      const dx = Math.sin(th), dy = -Math.cos(th);
      let best = Infinity, bestP = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (a.x * ey - a.y * ex) / den;
        const u = (a.x * dy - a.y * dx) / den;
        if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) {
          best = t;
          bestP = (cum[i] + u * Math.hypot(ex, ey)) / perim;
        }
      }
      g[k] = best === Infinity ? 1 : best;
      p[k] = bestP;
    }
    p[0] = 0; // the start point (vertex ties can otherwise resolve to 1)
    g[THETA_N] = g[0];
    p[THETA_N] = 1;
    sh.tab = { g, p, N: THETA_N };
    return sh.tab;
  }

  /** Unit-outline point at outline fraction f (0..1). */
  function pointAt(sh, f) {
    const { pts, cum, perim } = sh;
    const n = pts.length;
    const d = (((f % 1) + 1) % 1) * perim;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid - 1;
    }
    const a = pts[lo], b = pts[(lo + 1) % n];
    const seg = cum[lo + 1] - cum[lo] || 1;
    const u = (d - cum[lo]) / seg;
    return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) };
  }

  /**
   * Geometry for `nRings` nested rings inside an n×n canvas. Ring thickness is measured along the
   * outline's normal, so it looks the same on every shape (shrunk only if the shape is too small).
   */
  function layout(id, n, nRings = 2, o = {}) {
    const sh = shape(id);
    const { minx, maxx, miny, maxy } = sh.bbox;
    const edge = (o.edge ?? 0.02) * n;
    const half = Math.max(maxx - minx, maxy - miny) / 2;
    const sPx = (n / 2 - edge) / half;
    const cx = n / 2 - (sPx * (minx + maxx)) / 2;
    const cy = n / 2 - (sPx * (miny + maxy)) / 2;
    const aPx = sPx * sh.inr;
    let thick = (o.thick ?? 0.15) * n;
    let gap = (o.gap ?? 0.05) * n;
    const hole = (o.hole ?? 0.13) * n;
    const total = nRings * thick + (nRings - 1) * gap;
    const k = Math.min(1, Math.max(0.3, (aPx - hole) / total));
    thick *= k;
    gap *= k;
    const rings = [];
    for (let i = 0; i < nRings; i++) {
      const dOut = aPx - i * (thick + gap);
      const dIn = dOut - thick;
      rings.push({ dOut, dIn, rhoOut: dOut / aPx, rhoIn: dIn / aPx, rhoMid: (dOut + dIn) / 2 / aPx, thick });
    }
    const dot = Math.max(1.1, rings[nRings - 1].dIn - 0.02 * n);
    return { sh, n, cx, cy, sPx, aPx, rings, dot, tab: tables(sh), perimPx: (rho) => rho * sPx * sh.perim };
  }

  /** SVG path (clockwise, starting at the top) for ring i. */
  function pathD(L, i) {
    const rho = L.rings[i].rhoMid;
    const f = (v) => +v.toFixed(2);
    if (L.sh.id === 'circle') {
      const r = rho * L.sPx;
      return `M${f(L.cx)} ${f(L.cy - r)}A${f(r)} ${f(r)} 0 1 1 ${f(L.cx)} ${f(L.cy + r)}A${f(r)} ${f(r)} 0 1 1 ${f(L.cx)} ${f(L.cy - r)}Z`;
    }
    return (
      L.sh.pts
        .map((p, k) => `${k ? 'L' : 'M'}${f(L.cx + rho * L.sPx * p.x)} ${f(L.cy + rho * L.sPx * p.y)}`)
        .join('') + 'Z'
    );
  }

  /** Canvas position + outward unit vector of the point at outline fraction f on ring i. */
  function pointOnRing(L, i, f) {
    const u = pointAt(L.sh, f);
    const len = Math.hypot(u.x, u.y) || 1;
    const rho = L.rings[i].rhoMid;
    return { x: L.cx + rho * L.sPx * u.x, y: L.cy + rho * L.sPx * u.y, ux: u.x / len, uy: u.y / len };
  }

  return { LABELS, IDS: Object.keys(LABELS), shape, tables, layout, pathD, pointAt, pointOnRing, TAU };
});
