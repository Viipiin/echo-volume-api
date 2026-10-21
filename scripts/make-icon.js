// Generates build/icon.png (256x256) and build/tray.png (32x32): white speaker on a teal rounded square.
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
const speaker = (x, y) => {
  const box = roundedBox(x, y, 0.30, 0.5, 0.075, 0.11, 0.02);
  // cone: trapezoid from x=0.33 to 0.52, half-height 0.11 -> 0.24
  const t = Math.min(Math.max((x - 0.33) / 0.19, 0), 1);
  const hh = 0.11 + t * 0.13;
  const cone = Math.max(Math.abs(y - 0.5) - hh, 0.33 - x, x - 0.52);
  return Math.min(box, cone);
};
const wave = (x, y, r, w) => {
  const d = Math.abs(Math.hypot(x - 0.5, y - 0.5) - r) - w;
  const ang = Math.atan2(y - 0.5, x - 0.5);
  return Math.abs(ang) < 0.85 ? d : Math.max(d, 0.05);
};

function pixel(px, py, size) {
  const ss = 4; let bg = 0, fg = 0;
  for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
    const x = (px + (i + 0.5) / ss) / size, y = (py + (j + 0.5) / ss) / size;
    if (roundedBox(x, y, 0.5, 0.5, 0.47, 0.47, 0.2) < 0) bg++;
    if (Math.min(speaker(x, y), wave(x, y, 0.13, 0.035), wave(x, y, 0.25, 0.035)) < 0) fg++;
  }
  bg /= ss * ss; fg /= ss * ss;
  const teal = [14, 143, 184];
  const c = teal.map((v) => Math.round(v * (1 - fg) + 255 * fg));
  return [...c, Math.round(255 * bg)];
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(256, pixel));
fs.writeFileSync(path.join(out, 'tray.png'), png(32, pixel));
console.log('Wrote build/icon.png and build/tray.png');
