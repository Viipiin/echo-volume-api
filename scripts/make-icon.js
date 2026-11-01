// Generates build/icon.png (256x256), build/tray.png (32x32) and public/app-icon.png (32x32, the favicon): the logo,
// three cyan sound pills (short, tall, short) on a navy rounded square. Same shapes as #logo-tile in public/icons.svg.
// No dependencies: rasterises shapes with simple anti-aliasing and writes PNGs with zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distances in unit space (0..1)
const roundedBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
// The pills: x centre, half-height (unit space), shared half-width and the cyan gradient top -> bottom
const PILLS = [[0.31, 0.12], [0.5, 0.29], [0.69, 0.12]];
const PILL_HW = 0.06;
const pills = (x, y) => Math.min(...PILLS.map(([cx, hh]) => roundedBox(x, y, cx, 0.5, PILL_HW, hh, PILL_HW)));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const NAVY_TOP = [22, 34, 61], NAVY_BOTTOM = [11, 15, 26], CYAN_TOP = [44, 195, 240], CYAN_BOTTOM = [14, 143, 184], EDGE = [44, 195, 240];

function pixel(px, py, size) {
  const ss = 4; let bg = 0, fg = 0, edge = 0;
  const edgeW = Math.max(1.2 / size, 0.008); // a thin cyan rim, about a pixel at any size
  for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
    const x = (px + (i + 0.5) / ss) / size, y = (py + (j + 0.5) / ss) / size;
    const tile = roundedBox(x, y, 0.5, 0.5, 0.47, 0.47, 0.2);
    if (tile < 0) bg++;
    if (tile < 0 && tile > -edgeW) edge++;
    if (pills(x, y) < 0) fg++;
  }
  const n = ss * ss; bg /= n; fg /= n; edge /= n;
  const t = (px + 0.5) / size * 0.5 + (py + 0.5) / size * 0.5;
  let c = mix(NAVY_TOP, NAVY_BOTTOM, t);
  c = mix(c, EDGE, edge * 0.45 / Math.max(bg, 1e-6));
  c = mix(c, mix(CYAN_TOP, CYAN_BOTTOM, (py + 0.5) / size), fg / Math.max(bg, 1e-6));
  return [...c.map(Math.round), Math.round(255 * bg)];
}

module.exports = { pixel }; // installer/scripts/make-splash.js draws the same logo

if (require.main === module) {
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), png(256, pixel));
  fs.writeFileSync(path.join(out, 'tray.png'), png(32, pixel));
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'app-icon.png'), png(32, pixel));
  console.log('Wrote build/icon.png, build/tray.png and public/app-icon.png');
}
