// Renders sample ring icons to PNG files (handy when tuning the tray icon design).
const fs = require('fs');
const path = require('path');
const { renderRings } = require('../src/main/rings');
const { encodePNG } = require('../src/main/png');

const out = process.argv[2] || path.join(__dirname, '..', 'docs', 'img');
fs.mkdirSync(out, { recursive: true });
const samples = [
  [72, 0.45, 41, 0.3],
  [18, 0.2, 63, 0.6],
  [91, 0.8, 88, 0.9],
];
samples.forEach((s, i) => {
  for (const size of [16, 32, 256]) {
    const rgba = renderRings({ size, rings: [{ pct: s[0], elapsed: s[1] }, { pct: s[2], elapsed: s[3] }] });
    fs.writeFileSync(path.join(out, `preview-${i}-${size}.png`), encodePNG(size, size, rgba));
  }
});
console.log('written to', out);
