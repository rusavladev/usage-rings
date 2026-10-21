// Builds assets/icon.png, icon.ico (Windows) and icon.icns (macOS) from the ring renderer.
//   node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const { renderRings } = require('../src/main/rings');
const { encodePNG } = require('../src/main/png');

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });

const png = (size) =>
  encodePNG(
    size,
    size,
    renderRings({ size, rings: [{ pct: 28, elapsed: 0.55 }, { pct: 62, elapsed: 0.3 }], dark: true, accent: [76, 141, 255] }),
  );

fs.writeFileSync(path.join(out, 'icon.png'), png(256));

// ── .ico: PNG-compressed entries
const icoSizes = [256, 64, 48, 32, 16];
const icoImages = icoSizes.map(png);
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const entries = icoSizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(icoImages[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += icoImages[i].length;
  return e;
});
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([head, ...entries, ...icoImages]));

// ── .icns: PNG payloads (ic07=128, ic08=256, ic09=512, ic10=1024)
const icnsTypes = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];
const chunks = icnsTypes.map(([type, size]) => {
  const data = png(size);
  const h = Buffer.alloc(8);
  h.write(type, 0, 'ascii');
  h.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([h, data]);
});
const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii');
icnsHead.writeUInt32BE(total, 4);
fs.writeFileSync(path.join(out, 'icon.icns'), Buffer.concat([icnsHead, ...chunks]));

console.log('icons written to', out);
