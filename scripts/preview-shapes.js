// Renders every ring shape side by side on a taskbar-coloured strip (handy when tuning shapes).
const fs = require('fs');
const path = require('path');
const Shapes = require('../src/renderer/shapes');
const { renderRings } = require('../src/main/rings');
const { encodePNG } = require('../src/main/png');

const out = process.argv[2] || path.join(__dirname, '..', 'docs', 'img', 'shapes.png');
const size = 112;
const pad = 20;
const ids = Shapes.IDS;
const W = pad + ids.length * (size + pad);
const H = size + pad * 2;
const canvas = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) [32, 32, 32, 255].forEach((v, k) => (canvas[i * 4 + k] = v));
const accents = [[76, 141, 255], [165, 107, 255], [255, 95, 162], [25, 200, 230], [255, 138, 61], [212, 180, 131], [229, 231, 235], [139, 208, 80], [76, 141, 255]];
ids.forEach((id, idx) => {
  const icon = renderRings({ size, shape: id, dark: true, roundCaps: true, accent: accents[idx], rings: [{ pct: 28 + idx * 6, elapsed: 0.45 }, { pct: 62 - idx * 4, elapsed: 0.3 }] });
  const ox = pad + idx * (size + pad);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((y + pad) * W + ox + x) * 4;
      const al = icon[s + 3] / 255;
      for (let k = 0; k < 3; k++) canvas[d + k] = Math.round(icon[s + k] * al + canvas[d + k] * (1 - al));
    }
});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePNG(W, H, canvas));
console.log('written', out);
