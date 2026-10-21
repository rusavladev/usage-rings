'use strict';
// Software rasteriser for the tray icon. No canvas, no native deps:
// it produces an RGBA buffer that we hand to Electron as a PNG.
//
//   outer ring = 5-hour session, inner ring = weekly limit (any shape – see renderer/shapes.js)
//   coloured arc      = how much of the limit is LEFT (it drains as you spend)
//   brighter track    = how much of the window's TIME is left
//   thin white tick   = the end of the time that's left – keep the coloured arc ahead of it
//   centre dot        = the account's identity colour

const Shapes = require('../renderer/shapes');

const COLORS = {
  ok: [61, 214, 160],
  warn: [245, 185, 69],
  hot: [255, 99, 88],
  idle: [150, 154, 168],
};

function levelFor(pct) {
  if (pct == null) return 'idle';
  if (pct >= 85) return 'hot';
  if (pct >= 60) return 'warn';
  return 'ok';
}

const colorFor = (pct) => COLORS[levelFor(pct)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const TAU = Math.PI * 2;

/**
 * @param {object} o
 * @param {number} o.size                      pixel size (square)
 * @param {Array<{pct:number|null, elapsed:number|null}>} o.rings   outer first (pct = % USED)
 * @param {boolean} [o.dark]                   taskbar theme
 * @param {boolean} [o.roundCaps]
 * @param {number[]|null} [o.accent]           account colour [r,g,b] for the centre dot
 * @param {string} [o.shape]                   one of Shapes.IDS
 */
function renderRings({ size, rings, dark = true, roundCaps = size >= 64, accent = null, shape = 'circle' }) {
  const n = size;
  const L = Shapes.layout(shape, n, rings.length);
  const { sh, tab, sPx, cx, cy } = L;
  const base = dark ? [255, 255, 255] : [0, 0, 0];
  const layers = [];

  // Ring bounds are expressed as a scale factor ("rho") of the unit outline.
  rings.forEach((ring, i) => {
    const g = L.rings[i];
    const frac = ring.pct != null ? clamp01(1 - ring.pct / 100) : 0; // remaining quota
    const elapsed = ring.elapsed == null ? null : clamp01(ring.elapsed);
    const tl = elapsed == null ? 0 : 1 - elapsed; // fraction of time left

    const dim = dark ? 0.1 : 0.12;
    const lit = dark ? 0.26 : 0.28;
    const band = { rhoIn: g.rhoIn, rhoOut: g.rhoOut, rhoMid: g.rhoMid, thick: g.thick };
    layers.push({ ...band, p0: 0, p1: 1, color: base, alpha: elapsed == null ? lit * 0.7 : dim });
    if (elapsed != null && tl > 0) layers.push({ ...band, p0: 0, p1: tl, color: base, alpha: lit - dim, add: true });
    if (frac > 0.002) layers.push({ ...band, p0: 0, p1: Math.max(frac, 1e-4), color: colorFor(ring.pct), alpha: 1, caps: roundCaps });
    if (elapsed != null) {
      layers.push({
        rhoIn: g.rhoIn - (0.015 * n) / L.aPx,
        rhoOut: g.rhoOut + (0.01 * n) / L.aPx,
        tick: tl,
        halfW: Math.min(3, Math.max(0.55, n * 0.032)),
        color: dark ? [255, 255, 255] : [20, 20, 20],
        alpha: 0.95,
      });
    }
  });

  if (accent) layers.push({ disc: L.dot, color: accent, alpha: 1 });

  for (const l of layers) {
    if (!l.caps) continue;
    l.capR = l.thick / 2;
    l.capPts = [l.p0, l.p1].map((f) => {
      const u = Shapes.pointAt(sh, f);
      return [cx + l.rhoMid * sPx * u.x, cy + l.rhoMid * sPx * u.y];
    });
  }

  const SS = n >= 128 ? 2 : 4;
  const SAMPLES = SS * SS;
  const px = new Float32Array(n * n * 4); // premultiplied RGBA

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cover = new Float32Array(layers.length);
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const dx = fx - cx;
          const dy = fy - cy;
          const r = Math.hypot(dx, dy);
          let th = Math.atan2(dx, -dy);
          if (th < 0) th += TAU;
          const pos = (th / TAU) * tab.N;
          const i0 = Math.min(tab.N - 1, Math.floor(pos));
          const f = pos - i0;
          const gPx = (tab.g[i0] * (1 - f) + tab.g[i0 + 1] * f) * sPx;
          const p = tab.p[i0] * (1 - f) + tab.p[i0 + 1] * f;
          const rho = r / gPx; // this sample's scale relative to the unit outline

          for (let l = 0; l < layers.length; l++) {
            const La = layers[l];
            let hit = false;
            if (La.disc != null) {
              hit = r <= La.disc;
            } else if (La.tick != null) {
              if (rho >= La.rhoIn && rho <= La.rhoOut) {
                let d = Math.abs(p - La.tick);
                if (d > 0.5) d = 1 - d;
                hit = d * rho * sPx * sh.perim <= La.halfW;
              }
            } else {
              if (rho >= La.rhoIn && rho <= La.rhoOut) hit = p >= La.p0 && p <= La.p1;
              if (!hit && La.caps) {
                for (const c of La.capPts) {
                  if (Math.hypot(fx - c[0], fy - c[1]) <= La.capR) {
                    hit = true;
                    break;
                  }
                }
              }
            }
            if (hit) cover[l] += 1;
          }
        }
      }
      const o = (y * n + x) * 4;
      for (let l = 0; l < layers.length; l++) {
        if (!cover[l]) continue;
        const La = layers[l];
        const a = (cover[l] / SAMPLES) * La.alpha;
        if (La.add) {
          px[o] += (La.color[0] / 255) * a;
          px[o + 1] += (La.color[1] / 255) * a;
          px[o + 2] += (La.color[2] / 255) * a;
          px[o + 3] += a;
          continue;
        }
        const k = 1 - a;
        px[o] = px[o] * k + (La.color[0] / 255) * a;
        px[o + 1] = px[o + 1] * k + (La.color[1] / 255) * a;
        px[o + 2] = px[o + 2] * k + (La.color[2] / 255) * a;
        px[o + 3] = px[o + 3] * k + a;
      }
    }
  }

  const out = Buffer.alloc(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const a = Math.min(1, px[i * 4 + 3]);
    if (a <= 0) continue;
    out[i * 4] = Math.round(Math.min(1, px[i * 4] / a) * 255);
    out[i * 4 + 1] = Math.round(Math.min(1, px[i * 4 + 1] / a) * 255);
    out[i * 4 + 2] = Math.round(Math.min(1, px[i * 4 + 2] / a) * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

module.exports = { renderRings, colorFor, levelFor, COLORS };
