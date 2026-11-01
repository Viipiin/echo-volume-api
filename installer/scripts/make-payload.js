// npm run build:payload — packs dist-app/win-unpacked (from npm run build:app) into installer/payload/payload.evpack
// and writes payload.json (version, sizes, SHA-256) next to it. Setup verifies the checksum before installing.
const fs = require('fs');
const path = require('path');
const { pack } = require('../lib/pack');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'dist-app', 'win-unpacked');
const OUT = path.join(ROOT, 'installer', 'payload');
const { version, productName } = require(path.join(ROOT, 'package.json'));

(async () => {
  const exe = path.join(SRC, `${productName}.exe`);
  if (!fs.existsSync(exe)) { console.error(`✖ ${exe} not found. Run npm run build:app first.`); process.exit(1); }
  // A stale folder from an older build would be packed as-is: insist it's from this version
  const asar = path.join(SRC, 'resources', 'app.asar');
  const built = JSON.parse(require('@electron/asar').extractFile(asar, 'package.json').toString('utf8')).version;
  if (built !== version) { console.error(`✖ dist-app/win-unpacked is version ${built}, package.json is ${version}. Run npm run build:app.`); process.exit(1); }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'payload.evpack');
  const t0 = Date.now();
  let lastPct = -1;
  const r = await pack(SRC, file, (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`  packing… ${pct}%\n`); }
  });
  const manifest = { format: 1, product: productName, version, ...r, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'payload.json'), JSON.stringify(manifest, null, 2));
  const mb = (b) => (b / 1048576).toFixed(1);
  console.log(`✔ payload ${version}: ${r.files} files, ${mb(r.totalBytes)} MB → ${mb(r.packedBytes)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  sha256 ${r.sha256}`);
})().catch((e) => { console.error('✖', e); process.exit(1); });
