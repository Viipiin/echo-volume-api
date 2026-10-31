// The payload: the packaged app folder (electron-builder --dir) as one Brotli stream.
// Inside the stream: MAGIC, then per entry [type u8: 0 file, 1 folder][path length u16][path, utf8, "/"-separated]
// and for a file [size u64][bytes]. Unpacking streams it straight to disk, so progress is real bytes and file names.
const crypto = require('crypto');
// Electron's own fs treats *.asar paths as archives; the app's app.asar must be handled as a plain file
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const path = require('path');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('EVPACK1\n');
const FILE = 0, DIR = 1;

// ---------- pack (build time) ----------
function walk(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push({ type: DIR, path: r }, ...walk(root, r));
    else if (e.isFile()) out.push({ type: FILE, path: r, size: fs.statSync(path.join(root, r)).size });
  }
  return out;
}
function header(entry) {
  const p = Buffer.from(entry.path, 'utf8');
  const h = Buffer.alloc(3 + p.length + (entry.type === FILE ? 8 : 0));
  h.writeUInt8(entry.type, 0); h.writeUInt16LE(p.length, 1); p.copy(h, 3);
  if (entry.type === FILE) h.writeBigUInt64LE(BigInt(entry.size), 3 + p.length);
  return h;
}
async function pack(srcDir, outFile, onProgress = () => {}) {
  const entries = walk(srcDir);
  const totalBytes = entries.reduce((n, e) => n + (e.size || 0), 0);
  let done = 0;
  async function* source() {
    yield MAGIC;
    for (const e of entries) {
      yield header(e);
      if (e.type !== FILE) continue;
      for await (const chunk of fs.createReadStream(path.join(srcDir, e.path), { highWaterMark: 1 << 20 })) { done += chunk.length; onProgress(done, totalBytes); yield chunk; }
    }
  }
  const hash = crypto.createHash('sha256');
  let packedBytes = 0;
  const tap = new (require('stream').Transform)({ transform(chunk, _e, cb) { hash.update(chunk); packedBytes += chunk.length; cb(null, chunk); } });
  const brotli = zlib.createBrotliCompress({ params: {
    // quality 5: ~25 s for ~370 MB; PAYLOAD_QUALITY=9 saves ~8 MB but takes ~5 min
    [zlib.constants.BROTLI_PARAM_QUALITY]: Number(process.env.PAYLOAD_QUALITY) || 5, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: totalBytes,
  } });
  await pipeline(Readable.from(source()), brotli, tap, fs.createWriteStream(outFile));
  return { files: entries.filter((e) => e.type === FILE).length, dirs: entries.filter((e) => e.type === DIR).length, totalBytes, packedBytes, sha256: hash.digest('hex') };
}

// ---------- verify + unpack (install time) ----------
async function sha256File(file, onProgress = () => {}, signal) {
  const hash = crypto.createHash('sha256');
  const size = fs.statSync(file).size;
  let done = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20, signal })) { hash.update(chunk); done += chunk.length; onProgress(done, size); }
  return hash.digest('hex');
}

// A path from the payload, made safe: relative, no "..", no drive or device names
function safeJoin(root, rel) {
  const parts = rel.split('/');
  if (!rel || parts.some((p) => !p || p === '.' || p === '..' || /[<>:"|?*\\\x00-\x1f]/.test(p))) throw new Error(`Bad path in the package: ${JSON.stringify(rel)}`);
  const full = path.join(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new Error(`Path outside the install folder: ${rel}`);
  return full;
}

class Unpacker extends Writable {
  constructor(root, onProgress) {
    super({ highWaterMark: 1 << 20 });
    this.root = root; this.onProgress = onProgress;
    this.buf = Buffer.alloc(0); this.state = 'magic'; this.fd = null; this.left = 0; this.file = ''; this.bytes = 0;
  }
  _write(chunk, _enc, cb) { try { this.feed(chunk); cb(); } catch (e) { cb(e); } }
  _final(cb) {
    if (this.state !== 'head' || this.buf.length) return cb(new Error('The package is incomplete'));
    cb();
  }
  _destroy(err, cb) { if (this.fd != null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; } cb(err); }
  take(n) { // n bytes from the buffer, or null until they're there
    if (this.buf.length < n) return null;
    const b = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return b;
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.state === 'data') {
        if (!this.buf.length && this.left) return;
        const n = Math.min(this.left, this.buf.length);
        if (n) { fs.writeSync(this.fd, this.buf, 0, n); this.buf = this.buf.subarray(n); this.left -= n; this.bytes += n; this.onProgress(this.bytes, this.file); }
        if (this.left) return;
        fs.closeSync(this.fd); this.fd = null; this.state = 'head';
      } else if (this.state === 'magic') {
        const m = this.take(MAGIC.length); if (!m) return;
        if (!m.equals(MAGIC)) throw new Error('This is not an Echo Volume package');
        this.state = 'head';
      } else { // head: type + path length, then path (+ size), all at once
        if (this.buf.length < 3) return;
        const type = this.buf.readUInt8(0), len = this.buf.readUInt16LE(1), need = 3 + len + (type === FILE ? 8 : 0);
        if (type !== FILE && type !== DIR) throw new Error('The package is damaged');
        const h = this.take(need); if (!h) return;
        const rel = h.subarray(3, 3 + len).toString('utf8'), full = safeJoin(this.root, rel);
        if (type === DIR) { fs.mkdirSync(full, { recursive: true }); continue; }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        this.left = Number(h.readBigUInt64LE(3 + len)); this.file = rel;
        this.fd = fs.openSync(full, 'w'); this.state = 'data';
        this.onProgress(this.bytes, rel);
      }
    }
  }
}
// Unpacks payloadFile into root (which must exist). onProgress(bytesWritten, currentFile). signal: AbortSignal.
async function unpack(payloadFile, root, onProgress, signal) {
  await pipeline(fs.createReadStream(payloadFile, { highWaterMark: 1 << 20 }), zlib.createBrotliDecompress(), new Unpacker(root, onProgress), { signal });
}

module.exports = { pack, sha256File, unpack, safeJoin };
