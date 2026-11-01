// Writes installer/assets/splash.bmp: shown by the portable exe while it unpacks Setup (a few seconds, before any window).
// 24-bit BMP (what the NSIS splash takes): navy gradient, sound rings, the app logo.
const fs = require('fs');
const path = require('path');
const { pixel } = require('../../scripts/make-icon');

const W = 400, H = 240, LOGO = 96, LX = (W - LOGO) / 2, LY = (H - LOGO) / 2;
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const NAVY = [11, 15, 26], DEEP = [15, 30, 56];

function color(x, y) {
  let c = mix(NAVY, DEEP, Math.max(0, 1 - Math.hypot(x - W / 2, y - H / 2) / 260));
  const d = Math.hypot(x - W / 2, y - H / 2), ring = Math.abs(((d - 58) % 24) - 12);
  if (d > 58 && d < 190 && ring < 1.1) c = mix(c, [44, 195, 240], (1.1 - ring) * 0.5 * (1 - d / 190));
  if (x >= LX && y >= LY && x < LX + LOGO && y < LY + LOGO) {
    const [r, g, b, a] = pixel(x - LX, y - LY, LOGO);
    c = mix(c, [r, g, b], a / 255);
  }
  return c;
}

const row = Math.ceil((W * 3) / 4) * 4, data = Buffer.alloc(row * H), head = Buffer.alloc(54);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = color(x, y); data.set([b, g, r], (H - 1 - y) * row + x * 3); }
head.write('BM'); head.writeUInt32LE(54 + data.length, 2); head.writeUInt32LE(54, 10);
head.writeUInt32LE(40, 14); head.writeInt32LE(W, 18); head.writeInt32LE(H, 22);
head.writeUInt16LE(1, 26); head.writeUInt16LE(24, 28); head.writeUInt32LE(data.length, 34);
const out = path.join(__dirname, '..', 'assets', 'splash.bmp');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([head, data]));
console.log('Wrote installer/assets/splash.bmp');
