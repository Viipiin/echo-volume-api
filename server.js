// Echo Volume API — local REST API to control Echo Show / Echo volume from your laptop
// Uses the unofficial alexa-remote2 library (same calls the Alexa web app makes).
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
// DATA_DIR holds .env, cookie.json and st-token.json. The desktop app points it at its user-data folder;
// `npm start` uses that same folder once the app has been set up, so both share one login and SmartThings token.
const APP_DATA = path.join(process.env.APPDATA
  || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')),
  'Echo Volume');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync(path.join(APP_DATA, '.env')) ? APP_DATA : __dirname);
process.env.DATA_DIR = DATA_DIR; // smartthings.js reads it when loaded
require('dotenv').config({ path: path.join(DATA_DIR, '.env') });
const express = require('express');
const Alexa = require('alexa-remote2');
const smartthings = require('./smartthings');

const CFG = {
  port: Number(process.env.PORT || 5005),
  apiKey: process.env.API_KEY || '',
  amazonPage: process.env.AMAZON_PAGE || 'amazon.in',
  serviceHost: process.env.ALEXA_SERVICE_HOST || 'alexa.amazon.in',
  lang: process.env.ACCEPT_LANGUAGE || 'en-IN',
  proxyPort: Number(process.env.PROXY_PORT || 3001),
  defaultDevice: process.env.DEFAULT_DEVICE || '', // e.g. "Vipin's Echo Show 8"
  tvName: process.env.TV_NAME || 'TV', // name Alexa knows the TV by ("Alexa, turn on <TV_NAME>")
  cookieFile: path.join(DATA_DIR, 'cookie.json'),
  host: process.env.HOST || undefined, // undefined = all interfaces (desktop app sets 127.0.0.1)
};

const alexa = new Alexa();
const events = new (require('events'))(); // 'listening', 'listen-error', 'login-needed', 'ready'
let ready = false;
const lastVolume = {}; // serial -> volume before mute
const recentSet = {}; // serial -> { v, at }: volume we just set
const volumeQueue = {}; // serial -> { busy, next: { step, waiters } } (see sendVolume)
const volumeCache = {}; // serial -> { v, at }: last known volume (Amazon push updates, reads, our own changes)
const nowCache = {}; // serial -> { at, info }: player info shared by every open page; push updates clear it
let features = null; // alexa-features.js (set up below, once the shared UI state is loaded)

// ---------- Alexa login / cookie persistence ----------
function loadCookie() {
  try { return JSON.parse(fs.readFileSync(CFG.cookieFile, 'utf8')); } catch { return undefined; }
}
const saved = loadCookie();

alexa.on('cookie', () => {
  fs.writeFileSync(CFG.cookieFile, JSON.stringify(alexa.cookieData, null, 2));
  console.log('✔ Cookie saved/refreshed → cookie.json');
});

// Started once the port is ours (see bottom), so a second copy never opens another Amazon session
const startAlexa = () => alexa.init({
  cookie: saved,
  formerRegistrationData: saved,
  proxyOnly: true,
  proxyOwnIp: 'localhost',
  proxyPort: CFG.proxyPort,
  proxyLogLevel: 'info',
  amazonPage: CFG.amazonPage,
  alexaServiceHost: CFG.serviceHost,
  acceptLanguage: CFG.lang,
  useWsMqtt: true, // Amazon's push connection: volume, music, alarm and list changes arrive instantly
  cookieRefreshInterval: 7 * 24 * 60 * 60 * 1000, // refresh weekly
  logger: (m) => { if (/Retrying once/.test(m)) console.log('⚠ Amazon:', m.replace(/^Alexa-Remote: /, '')); },
}, (err) => {
  if (err) {
    // First run: alexa-remote2 starts a login proxy and reports it as an "error"
    console.log('\n' + (err.message || err));
    console.log(`\n➡  Open http://localhost:${CFG.proxyPort} in a browser and sign in to Amazon (${CFG.amazonPage}).`);
    console.log('   After login, restart this server.\n');
    events.emit('login-needed', `http://localhost:${CFG.proxyPort}`);
    return;
  }
  ready = true;
  events.emit('ready');
  console.log('✔ Connected to Alexa. Devices:');
  for (const s of Object.keys(alexa.serialNumbers)) {
    const d = alexa.serialNumbers[s];
    console.log(`   • ${d.accountName}  [${s}]  (${d.deviceFamily})`);
  }
  features.onReady();
});

// ---------- helpers ----------
const p = (fn) => new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r))));

// Voice-style (sequence) commands, paced. Commands sent too close together get "Too many requests",
// and alexa-remote2 then waits 30-60s before retrying once. So send them one at a time, a minimum gap apart.
const PACE_MS = Number(process.env.COMMAND_GAP_MS || 1500);
let paceChain = Promise.resolve(), paceLast = 0;
function sequence(serial, command, value) {
  const run = paceChain.then(async () => {
    const waitMs = paceLast + PACE_MS - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    paceLast = Date.now();
    return p((cb) => alexa.sendSequenceCommand(serial, command, value, cb));
  });
  paceChain = run.catch(() => {});
  return run;
}

function resolveDevice(input) {
  const q = (input || CFG.defaultDevice || '').toString().trim().toLowerCase();
  const all = Object.values(alexa.serialNumbers || {});
  if (!q) {
    const shows = all.filter((d) => /echo show|KNIGHT/i.test(`${d.accountName} ${d.deviceFamily}`));
    if (shows.length === 1) return shows[0];
    throw httpErr(400, 'Specify "device" (name or serial) or set DEFAULT_DEVICE in .env');
  }
  const d = all.find((x) => x.serialNumber.toLowerCase() === q)
    || all.find((x) => x.accountName.toLowerCase() === q)
    || all.find((x) => x.accountName.toLowerCase().includes(q));
  if (!d) throw httpErr(404, `Device "${input}" not found. GET /api/devices to list.`);
  return d;
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));

// Speaker groups have no volume of their own (commands to them are accepted but ignored): use the member Echos
const groupMembers = (dev) => (dev.deviceFamily === 'WHA'
  ? (dev.clusterMembers || []).map((s) => alexa.serialNumbers[s]).filter(Boolean) : null);

async function getVolume(dev) {
  const members = groupMembers(dev);
  if (members) {
    const vs = (await Promise.all(members.map(getVolume))).filter((v) => v != null);
    return vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) : null; // average of the members
  }
  // The Echo reports a new volume ~1-2s after it's set; until then trust what we sent (mute/up/down build on it)
  const recent = recentSet[dev.serialNumber];
  if (recent && Date.now() - recent.at < 5000) return recent.v;
  // With the push connection up, changes arrive by themselves; otherwise only share a read between open pages
  const cached = volumeCache[dev.serialNumber];
  if (cached && Date.now() - cached.at < (alexa.isWsMqttConnected?.() ? 60000 : 4000)) return cached.v;
  const media = await p((cb) => alexa.getMedia(dev.serialNumber, cb));
  if (media && typeof media.volume === 'number') {
    volumeCache[dev.serialNumber] = { v: media.volume, at: Date.now() };
    return media.volume;
  }
  return lastVolume[dev.serialNumber] ?? null; // unknown when nothing is playing on some firmware
}

async function setVolume(dev, level) {
  const members = groupMembers(dev);
  if (members) {
    if (!members.length) throw httpErr(503, `No Echo found in group "${dev.accountName}"`);
    const [v] = await Promise.all(members.map((m) => setVolume(m, level)));
    if (v > 0) lastVolume[dev.serialNumber] = v;
    return v;
  }
  // Sent as the spoken-style command "set volume to N" (Alexa's 0-10 scale) on that Echo.
  const step = Math.round(clamp(level) / 10);
  const v = step * 10;
  const serial = dev.serialNumber;
  recentSet[serial] = { v, at: Date.now() };
  try { await sendVolume(serial, step); } catch (e) { delete recentSet[serial]; throw e; }
  volumeCache[serial] = { v, at: Date.now() };
  if (v > 0) lastVolume[serial] = v;
  return v;
}

// One volume command at a time per Echo, latest value wins. Rapid clicks sent together can be applied
// out of order, and Amazon throttles bursts (a 4th command in a row took ~40s), so while one command is
// in flight, newer requests replace each other and only the last one is sent.
function sendVolume(serial, step) {
  const q = (volumeQueue[serial] ??= { busy: false, next: null });
  return new Promise((resolve, reject) => {
    if (q.next) { q.next.step = step; q.next.waiters.push({ resolve, reject }); }
    else q.next = { step, waiters: [{ resolve, reject }] };
    if (!q.busy) drainVolume(serial);
  });
}
async function drainVolume(serial) {
  const q = volumeQueue[serial];
  q.busy = true;
  while (q.next) {
    const job = q.next;
    q.next = null;
    try {
      await sequence(serial, 'textCommand', `set volume to ${job.step}`);
      job.waiters.forEach((w) => w.resolve());
    } catch (e) { job.waiters.forEach((w) => w.reject(e)); }
  }
  q.busy = false;
}

// ---------- REST API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/icon.png', (_req, res) => res.sendFile(path.join(__dirname, 'build', 'icon.png'))); // phone home-screen icon

// ---------- Access control ----------
// This PC needs no key. Other devices (a phone on your Wi-Fi) need the API key: API_KEY from .env, or the one
// created when phone access is turned on in Settings (sent as x-api-key, or ?key= for links and live updates).
// Requests made by other websites in your browser, and host names other than this PC's (DNS rebinding), are refused.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress);
const hostOk = (hostHeader) => {
  const h = hostHeader.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const me = os.hostname().toLowerCase();
  return h === 'localhost' || net.isIP(h) !== 0 || h === me || h === `${me}.local`;
};
const lanKey = () => CFG.apiKey || (store.phone.enabled ? store.phone.key : '');

app.use('/api', (req, res, next) => {
  if (!hostOk(req.headers.host || '')) return res.status(403).json({ error: 'Unknown host name' });
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Requests from other websites are not allowed' });
  if (!isLocal(req)) {
    if (!lanKey()) return res.status(403).json({ error: 'Phone access is off. Turn it on in Echo Volume → Settings on the PC.' });
    if ((req.get('x-api-key') || req.query.key) !== lanKey()) return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) =>
  res.status(e.status || 500).json({ error: e.message || String(e) }));

// SmartThings (independent of the Alexa login)
app.use('/api/st', smartthings.router);

// ---------- Apple Music catalog (free iTunes Search API + Apple RSS charts; no login needed) ----------
const MUSIC_COUNTRY = (process.env.MUSIC_COUNTRY
  || { 'amazon.in': 'IN', 'amazon.com': 'US', 'amazon.co.uk': 'GB', 'amazon.de': 'DE', 'amazon.ca': 'CA', 'amazon.com.au': 'AU' }[CFG.amazonPage]
  || 'US').toUpperCase();
const art = (url, size = 300) => (url ? url.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/, `/${size}x${size}bb.jpg`) : null);

async function getJson(url, timeout = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw httpErr(502, `Apple catalog returned ${r.status}`);
  return r.json();
}

// Phrase Alexa searches Apple Music with: "Kesariya (From "Brahmastra")" by "Pritam, Arijit Singh & …" → "Kesariya by Pritam"
const clean = (s) => (s || '').replace(/\s*[([](from|feat|ft|with)\b.*?[)\]]/gi, '').replace(/\s+-\s+(single|ep)$/i, '').trim() || s;
const mainArtist = (s) => (s || '').split(/,|&| feat\.? | x /i)[0].trim();
// Album extras like "(Deluxe Edition)" or "(Original Motion Picture Soundtrack)" make the voice search miss
const cleanAlbum = (s) => clean(s).replace(/\s*[([][^)\]]*(deluxe|edition|soundtrack|motion picture|remaster|expanded|bonus)[^)\]]*[)\]]/gi, '').trim() || s;
// Compilations and soundtracks by "Various Artists": that artist makes Alexa misread the title ("couldn't find any
// extended songs by various artists") and a shortened title plays an unskippable stream, so send the full title
// without brackets instead ("the album Saiyaara Extended Album Original Motion Picture Soundtrack")
const various = (artist) => /^various artists$/i.test(mainArtist(artist));
const fullTitle = (s) => clean(s).replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const phrase = (type, title, artist) => {
  if (various(artist)) return type === 'album' ? `the album ${fullTitle(title)}` : clean(title);
  return type === 'album' ? `the album ${cleanAlbum(title)} by ${mainArtist(artist)}` : `${clean(title)} by ${mainArtist(artist)}`;
};

const ENTITY = { song: 'song', album: 'album', artist: 'musicArtist' };
// ?limit= up to 200 (the iTunes maximum); ?sort=newest|oldest orders by release date (default: Apple's relevance)
app.get('/api/music/search', wrap(async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const type = ENTITY[req.query.type] ? req.query.type : 'song';
  const limit = Math.max(1, Math.min(200, Math.round(Number(req.query.limit)) || 30));
  if (!q) throw httpErr(400, '"q" is required');
  const url = `https://itunes.apple.com/search?media=music&limit=${limit}&country=${MUSIC_COUNTRY}`
    + `&entity=${ENTITY[type]}&term=${encodeURIComponent(q)}`;
  const { results = [] } = await getJson(url);
  const items = results.map((r) => {
    const released = r.releaseDate || null;
    const year = released ? released.slice(0, 4) : null;
    if (type === 'artist') return { type, id: r.artistId, title: r.artistName, subtitle: r.primaryGenreName || 'Artist', artwork: null, query: r.artistName };
    // Year first so it isn't cut off by long artist credits
    if (type === 'album') return { type, id: r.collectionId, title: r.collectionName, subtitle: [year, r.artistName].filter(Boolean).join(' · '), released, artist: r.artistName, artwork: art(r.artworkUrl100), query: phrase(type, r.collectionName, r.artistName) };
    return { type, id: r.trackId, title: r.trackName, subtitle: [year, r.artistName].filter(Boolean).join(' · '), released, artist: r.artistName, artwork: art(r.artworkUrl100), query: phrase(type, r.trackName, r.artistName) };
  });
  // The same song often appears on several releases (single, album, compilation) with slightly different
  // credits: keep the first per title + main artist. Artists by name only (Apple has a page per genre).
  const seen = new Set();
  const unique = items.filter((it) => {
    const k = (type === 'artist' ? it.title : `${clean(it.title)}|${mainArtist(it.artist)}`).toLowerCase();
    return !seen.has(k) && seen.add(k);
  });
  const sort = req.query.sort;
  if (type !== 'artist' && (sort === 'newest' || sort === 'oldest')) {
    const dir = sort === 'newest' ? -1 : 1;
    unique.sort((a, b) => (!a.released) - (!b.released) || dir * (Date.parse(a.released) - Date.parse(b.released))); // undated last
  }
  res.json(unique);
}));

// Top songs / albums chart for the account's country (shown before the first search)
let topCache = {};
app.get('/api/music/top', wrap(async (req, res) => {
  const type = req.query.type === 'album' ? 'album' : 'song';
  const hit = topCache[type];
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return res.json(hit.items);
  const url = `https://rss.marketingtools.apple.com/api/v2/${MUSIC_COUNTRY.toLowerCase()}/music/most-played/30/${type}s.json`;
  let feed;
  for (let i = 0; !feed; i++) { // this feed often hangs a request, but answers the next one quickly
    try { feed = (await getJson(url, 6000)).feed; } catch (e) { if (i === 2) throw httpErr(502, 'Apple charts are not responding, try a search'); }
  }
  const items = (feed?.results || []).map((r) => ({
    type, id: r.id, title: r.name, subtitle: r.artistName, artwork: art(r.artworkUrl100),
    query: phrase(type, r.name, r.artistName),
  }));
  topCache[type] = { at: Date.now(), items };
  res.json(items);
}));

// ---------- UI state shared by the browser and the desktop app (in DATA_DIR) ----------
// theme, the Echo music plays on (also used by media keys / quick controls), favourites, recently played, playlists
const STORE_FILE = path.join(DATA_DIR, 'ui-state.json');
const store = {
  theme: 'system', musicDevice: '', favorites: [], recent: [], playlists: [], scenes: [],
  notify: { alerts: true, songs: false }, phone: { enabled: false, key: '' }, crossfade: 0,
  celebrations: [], celebrate: { enabled: true, time: '09:00', device: 'all', sound: '' }, celebrated: {},
};
try { Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))); } catch {}
const saveStore = () => fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), (e) => e && console.log('Saving ui-state.json failed:', e.message));

app.get('/api/ui', (_req, res) => res.json({ theme: store.theme, musicDevice: store.musicDevice }));
app.post('/api/ui', (req, res) => {
  const theme = req.body?.theme;
  if (!['system', 'light', 'dark', 'midnight'].includes(theme)) return res.status(400).json({ error: '"theme" must be system, light, dark or midnight' });
  store.theme = theme; saveStore();
  events.emit('theme', theme); // desktop app: applies it to its windows and title bar
  res.json({ theme });
});

// Only the fields the tiles need, size-limited (it's written to disk)
const musicItem = (it) => {
  const s = (v, n) => (v == null ? '' : String(v).slice(0, n));
  const item = { type: ['song', 'album', 'artist', 'radio', 'podcast'].includes(it?.type) ? it.type : 'song', title: s(it?.title, 200), subtitle: s(it?.subtitle, 300), artwork: /^https:\/\//.test(it?.artwork) ? s(it.artwork, 500) : null, query: s(it?.query, 300).trim() };
  if (/^\d{1,15}$/.test(String(it?.id ?? ''))) item.id = String(it.id); // podcasts: to list their episodes
  if (!item.query) throw httpErr(400, '"item.query" is required');
  return item;
};
app.get('/api/music/favorites', (_req, res) => res.json(store.favorites));
app.post('/api/music/favorites', wrap(async (req, res) => {
  const item = musicItem(req.body?.item);
  store.favorites = [item, ...store.favorites.filter((f) => f.query !== item.query)].slice(0, 200);
  saveStore(); res.json(store.favorites);
}));
app.post('/api/music/favorites/remove', wrap(async (req, res) => {
  store.favorites = store.favorites.filter((f) => f.query !== req.body?.query);
  saveStore(); res.json(store.favorites);
}));
app.get('/api/music/recent', (_req, res) => res.json(store.recent));

app.use('/api', (req, res, next) => {
  if (!ready) return res.status(503).json({ error: `Not logged in yet. Open http://localhost:${CFG.proxyPort}` });
  next();
});

// Device list (incl. online flag) is only loaded at startup; re-read it from Amazon, at most every 10s
let lastDeviceRefresh = Date.now();
async function refreshDevices() {
  if (Date.now() - lastDeviceRefresh < 10000) return;
  lastDeviceRefresh = Date.now();
  await p((cb) => alexa.initDeviceState(cb)).catch((e) => console.log('Device refresh failed:', e.message || e));
}

app.get('/api/devices', wrap(async (_req, res) => {
  await refreshDevices();
  res.json(Object.values(alexa.serialNumbers).map((d) => ({
    name: d.accountName, serial: d.serialNumber, family: d.deviceFamily, type: d.deviceType, online: d.online,
    ...(d.deviceFamily === 'WHA' && { members: d.clusterMembers || [] }),
  })));
}));

app.get('/api/volume', wrap(async (req, res) => {
  const dev = resolveDevice(req.query.device);
  res.json({ device: dev.accountName, volume: await getVolume(dev) });
}));

app.post('/api/volume', wrap(async (req, res) => {
  const { device, level } = req.body || {};
  if (level === undefined || isNaN(level)) throw httpErr(400, '"level" (0-100) is required');
  const dev = resolveDevice(device);
  res.json({ device: dev.accountName, volume: await setVolume(dev, level) });
}));

app.post('/api/volume/:dir(up|down)', wrap(async (req, res) => {
  const dev = resolveDevice(req.body?.device);
  const step = clamp(req.body?.step ?? 10);
  const cur = (await getVolume(dev)) ?? 50;
  const next = req.params.dir === 'up' ? cur + step : cur - step;
  res.json({ device: dev.accountName, from: cur, volume: await setVolume(dev, next) });
}));

app.post('/api/mute', wrap(async (req, res) => {
  const dev = resolveDevice(req.body?.device);
  const cur = await getVolume(dev);
  if (cur) lastVolume[dev.serialNumber] = cur;
  await setVolume(dev, 0);
  res.json({ device: dev.accountName, volume: 0, restoreTo: lastVolume[dev.serialNumber] ?? null });
}));

app.post('/api/unmute', wrap(async (req, res) => {
  const dev = resolveDevice(req.body?.device);
  const v = lastVolume[dev.serialNumber] ?? 40;
  res.json({ device: dev.accountName, volume: await setVolume(dev, v) });
}));

// ---------- Voice-style commands (same as speaking to an Echo) ----------
// Echo used to relay a command: explicit device, else DEFAULT_DEVICE, else first online Echo Show / Echo.
function commandDevice(input) {
  if (input || CFG.defaultDevice) return resolveDevice(input);
  const all = Object.values(alexa.serialNumbers || {}).filter((d) => d.online !== false);
  const d = all.find((x) => x.deviceFamily === 'KNIGHT') || all.find((x) => /^(ECHO|ROOK)$/.test(x.deviceFamily));
  if (!d) throw httpErr(503, 'No online Echo found to send the command through');
  return d;
}

async function textCommand(dev, text) {
  await sequence(dev.serialNumber, 'textCommand', text);
  return { via: dev.accountName, command: text.toLowerCase() };
}

app.post('/api/command', wrap(async (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) throw httpErr(400, '"text" is required, e.g. {"text":"turn on tv"}');
  res.json(await textCommand(commandDevice(req.body?.device), text));
}));

app.post('/api/tv/:state(on|off)', wrap(async (req, res) => {
  const name = (req.body?.name || CFG.tvName).toString();
  res.json(await textCommand(commandDevice(req.body?.device), `turn ${req.params.state} ${name}`));
}));

// Power state of smart home TVs (the Alexa built-in TV device often reports offline even when the TV is on)
let tvEntities = null; // cached: [{ name, id }]
app.get('/api/tv/state', wrap(async (_req, res) => {
  if (!tvEntities) {
    const list = await p((cb) => alexa.getSmarthomeEntities(cb));
    tvEntities = (Array.isArray(list) ? list : [])
      .filter((e) => {
        if (e.providerData?.categoryType === 'GROUP') return false; // a room group that contains the TV
        const ops = (e.supportedOperations || []).join(' ');
        return /turnOn/.test(ops) && (/_TV\./.test(ops) || e.displayName.toLowerCase() === CFG.tvName.toLowerCase());
      })
      .map((e) => ({ name: e.displayName, id: e.id }));
  }
  if (!tvEntities.length) return res.json([]);
  const r = await p((cb) => alexa.querySmarthomeDevices(tvEntities.map((t) => t.id), 'ENTITY', cb));
  const states = {};
  for (const s of r?.deviceStates || []) {
    const caps = (s.capabilityStates || []).map((c) => { try { return JSON.parse(c); } catch { return {}; } });
    const power = caps.find((c) => c.namespace === 'Alexa.PowerController' && c.name === 'powerState');
    const conn = caps.find((c) => c.namespace === 'Alexa.EndpointHealth' && c.name === 'connectivity');
    states[s.entity?.entityId] = { power: power?.value ?? null, reachable: conn ? conn.value?.value === 'OK' : null };
  }
  // A TV in standby comes back as an error (ENDPOINT_UNREACHABLE), not a state
  for (const err of r?.errors || []) {
    const id = err.entity?.entityId;
    if (id && !states[id] && err.code === 'ENDPOINT_UNREACHABLE') states[id] = { power: 'OFF', reachable: false };
  }
  res.json(tvEntities.map((t) => ({ ...t, ...(states[t.id] || { power: null, reachable: null }) })));
}));

// TV volume (smart home Alexa.Speaker). The TV doesn't report its volume, so these only send changes.
const tvName = (req) => (req.body?.name || CFG.tvName).toString();

app.post('/api/tv/volume', wrap(async (req, res) => {
  const level = req.body?.level;
  if (level === undefined || isNaN(level)) throw httpErr(400, '"level" (0-100) is required');
  res.json(await textCommand(commandDevice(req.body?.device), `set the volume on ${tvName(req)} to ${clamp(level)}`));
}));

app.post('/api/tv/volume/:dir(up|down)', wrap(async (req, res) => {
  const step = Math.max(1, clamp(req.body?.step ?? 5));
  const verb = req.params.dir === 'up' ? 'increase' : 'decrease';
  res.json(await textCommand(commandDevice(req.body?.device), `${verb} the volume on ${tvName(req)} by ${step}`));
}));

app.post('/api/tv/:m(mute|unmute)', wrap(async (req, res) => {
  res.json(await textCommand(commandDevice(req.body?.device), `${req.params.m} ${tvName(req)}`));
}));

// ---------- Local playlists: named lists of songs kept here, played one after another ----------
// Alexa can't be handed a queue of Apple Music songs, so each song is started on its own: after it starts,
// the Echo is checked every few seconds and the next song is played once a different track comes on
// (Alexa's autoplay, or a skip on the Echo) or playback stops.
// A list without an id (songs queued from search results, a Surprise mix) can carry "more": called near its end
// for items to add, so it keeps going; and "surprise" ('song' | 'podcast'), the Surprise button that started it.
let plRun = null; // { serial, list (id), index, title (as Alexa names it once started), at (started), idle (checks) }
let plTimer = null, plBusy = false, podMisses = 0; // podcasts in a row that Alexa played something else for
const plStatus = () => (plRun ? { device: alexa.serialNumbers[plRun.serial]?.accountName || null, serial: plRun.serial, list: plRun.list, index: plRun.index, surprise: plRun.surprise || null } : null);
const plName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const plSummary = (l) => ({ id: l.id, name: l.name, count: l.items.length, artwork: l.items.find((x) => x.artwork)?.artwork || null });
const plList = () => ({ lists: store.playlists.map(plSummary), playing: plStatus(), crossfade: store.crossfade });
const runItems = (run) => (run.list ? store.playlists.find((x) => x.id === run.list)?.items : run.items) || [];
function playlist(id) {
  const l = store.playlists.find((x) => x.id === id);
  if (!l) throw httpErr(404, 'That playlist no longer exists');
  return l;
}
function stopPlaylist(serial) {
  if (!plRun || (serial && plRun.serial !== serial)) return;
  plRun = null; clearInterval(plTimer); plTimer = null; clearTimeout(fadeTimer);
}
// fadeIn: the volume to bring the song up to once it plays (it starts quiet, at the end of a crossfade)
async function playlistPlay(dev, list, index, fadeIn) {
  const item = list.items[index];
  if (!item) return stopPlaylist();
  const run = plRun = { serial: dev.serialNumber, list: list.id, items: list.items, more: list.more, surprise: list.surprise, index, title: null, at: Date.now(), idle: 0 };
  clearInterval(plTimer); clearTimeout(fadeTimer);
  plTimer = setInterval(() => playlistCheck().catch((e) => console.log('Playlist check failed:', e.message)), 5000);
  plTimer.unref?.();
  if (list.surprise) surpriseSeen(list.surprise, item);
  // Top up a few items before the end, in the background, so the next one starts without a wait
  if (list.more && index >= list.items.length - 3) {
    list.more().then((add) => list.items.push(...add)).catch((e) => console.log('Adding to the queue failed:', e.message || e));
  }
  const start = () => (item.type === 'podcast' ? playPodcastShow(dev, item.query) : playMusic(dev, item.query));
  if (!fadeIn) return start();
  run.fading = true; // keep the checks out until it's back up
  try {
    try { await start(); } catch (e) { await setVolume(dev, fadeIn).catch(() => {}); throw e; }
    await crossfadeIn(dev, run, fadeIn);
  } finally { run.fading = false; }
}
async function playlistStep(dir, fadeIn) {
  const run = plRun; if (!run) return;
  const dev = alexa.serialNumbers[run.serial];
  const list = run.list ? store.playlists.find((x) => x.id === run.list) // null id: songs queued from search results, a Surprise mix
    : { id: null, items: run.items, more: run.more, surprise: run.surprise };
  const next = run.index + dir;
  if (!dev || !list || next < 0 || next >= list.items.length) {
    if (dir > 0 && dev) await p((cb) => alexa.sendCommand(dev.serialNumber, 'pause', null, cb)).catch(() => {}); // end of the list
    if (fadeIn && dev) await setVolume(dev, fadeIn).catch(() => {}); // faded out for a song that's gone now
    return stopPlaylist();
  }
  await playlistPlay(dev, list, next, fadeIn);
}
async function playlistCheck() {
  const run = plRun;
  // Give Alexa time to start the song (longer for a podcast: it's asked by voice, and the song before can still
  // be reported meanwhile, which would be taken for the podcast and then for it moving on)
  const podcast = run && runItems(run)[run.index]?.type === 'podcast';
  if (!run || plBusy || run.fading || Date.now() - run.at < (podcast ? 20000 : 10000)) return;
  plBusy = true;
  try {
    const i = await playerInfo(run.serial, true);
    if (plRun !== run || run.fading) return;
    // A podcast reports the show as its title and the episode below it: Alexa going on to another episode of
    // the show counts as moving on too (a Surprise mix then plays the next show)
    const title = (podcast && i.infoText?.title ? [i.infoText.title, i.infoText.subText1].filter(Boolean).join(' · ') : i.infoText?.title) || null;
    if (i.state === 'PLAYING' && title) {
      run.idle = 0;
      if (!run.title && podcast) {
        // Alexa didn't find the show and played something else ("empire" became a song, "the a16z show" another
        // podcast): on to the next one, unless that keeps happening
        const want = runItems(run)[run.index] || {}, got = words(i.infoText?.title);
        const same = words(`${want.title} ${want.query}`).some((w) => got.includes(w));
        if (!/podcast/i.test(i.provider?.providerName || '') || !same) {
          if (++podMisses <= 3) { console.log(`"${runItems(run)[run.index]?.query}" didn't start as a podcast, skipping it`); return playlistStep(1); }
        } else podMisses = 0;
      }
      if (!run.title) run.title = title;
      if (title !== run.title) await playlistStep(1); // it moved on to something else
      else scheduleCrossfade(run, i.progress);
    } else if (i.state === 'PAUSED') { run.idle = 0; clearTimeout(fadeTimer); } // paused by someone: wait
    else {
      // Stopped: at once when the song played to its end, otherwise after a few checks (a brief hiccup)
      const pr = i.progress || {}, ended = pr.mediaLength > 0 && pr.mediaProgress >= pr.mediaLength - 3;
      if (++run.idle >= (ended ? 1 : 3)) await playlistStep(1);
    }
  } finally { plBusy = false; }
}

// ---------- Crossfade between playlist songs ----------
// An Echo plays one stream at a time, so two songs can't overlap. Instead the volume is lowered over the last
// seconds of a song, the next one is started while it's quiet, and the volume comes back up once it plays.
// Steps go as "set volume to N" (Alexa's 0-10 scale): the player's own volume command lands ~10s late on these
// Echos and drops commands sent close together. Those are rate limited, so it's two steps down and two back up.
let fadeTimer = null;
const FADE_LEAD = 2; // seconds: start the next song this long before the end (Alexa takes a moment to start it)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The quieter levels on the way down from v: ~60% and ~30% in Alexa's steps of 10, never below 10
const fadeSteps = (v) => [...new Set([0.6, 0.3].map((f) => Math.max(10, Math.round((v * f) / 10) * 10)))].filter((x) => x < v);
// From each check (5s apart): once the end is near, time the fade to start "store.crossfade" seconds before it
function scheduleCrossfade(run, pr) {
  clearTimeout(fadeTimer);
  const secs = store.crossfade, dev = alexa.serialNumbers[run.serial];
  if (!secs || !(pr?.mediaLength > 0) || run.index + 1 >= runItems(run).length) return; // off, unknown length, last song
  if (runItems(run)[run.index]?.type === 'podcast') return; // a talk doesn't fade into the next one
  if (!dev || dev.deviceFamily === 'WHA') return; // speaker groups: a command per member would hit the rate limit
  const left = pr.mediaLength - (pr.mediaProgress || 0);
  if (left > secs + 10) return; // a later check times it more precisely
  fadeTimer = setTimeout(() => crossfadeOut(run).catch((e) => console.log('Crossfade failed:', e.message || e)), Math.max(0, (left - secs) * 1000));
  fadeTimer.unref?.();
}
async function crossfadeOut(run) {
  const dev = alexa.serialNumbers[run.serial];
  if (plRun !== run || run.fading || !dev) return;
  const from = await getVolume(dev), steps = from > 0 ? fadeSteps(from) : [];
  if (!steps.length) return; // muted, unknown or already quiet: the usual hand-off when the song ends
  run.fading = true;
  let handedOff = false;
  try {
    const gap = (Math.max(1, store.crossfade - FADE_LEAD) * 1000) / steps.length; // over all but the last FADE_LEAD seconds
    for (const v of steps) {
      if (plRun !== run) return;
      const t = Date.now();
      await setVolume(dev, v);
      await wait(gap - (Date.now() - t));
    }
    if (plRun !== run) return;
    const i = await playerInfo(run.serial, true);
    if (i.state === 'PAUSED' || (i.infoText?.title && i.infoText.title !== run.title)) return; // paused or skipped meanwhile
    handedOff = true;
    run.fading = false;
    await playlistStep(1, from);
  } finally {
    if (!handedOff) { run.fading = false; await setVolume(dev, from).catch(() => {}); }
  }
}
// The next song was started quietly: wait until it plays, then bring it back up to "to".
// Whatever happens, the volume ends back at "to".
async function crossfadeIn(dev, run, to) {
  try {
    const start = Date.now();
    for (;;) {
      await wait(800);
      if (plRun !== run || Date.now() - start > 15000) return;
      const i = await playerInfo(run.serial, true);
      // (near its start: the song before can still be reported for a moment)
      if (i.state === 'PLAYING' && i.infoText?.title && (i.progress?.mediaProgress ?? 0) < 20) { run.title = i.infoText.title; break; }
    }
    for (const v of fadeSteps(to).reverse().slice(1)) { // the steps above the lowest, going up
      if (plRun !== run) return;
      await setVolume(dev, v);
      await wait(1500);
    }
  } finally { await setVolume(dev, to).catch((e) => console.log('Crossfade: restoring the volume failed:', e.message || e)); }
}

app.get('/api/music/crossfade', (_req, res) => res.json({ seconds: store.crossfade }));
app.post('/api/music/crossfade', (req, res) => {
  const s = Number(req.body?.seconds);
  if (![0, 5, 10, 15].includes(s)) return res.status(400).json({ error: '"seconds" must be 0, 5, 10 or 15' });
  store.crossfade = s; saveStore();
  if (!s) clearTimeout(fadeTimer);
  res.json({ seconds: s });
});

app.get('/api/music/playlists', (_req, res) => res.json(plList()));
app.post('/api/music/playlists', wrap(async (req, res) => {
  const name = plName(req.body?.name);
  if (!name) throw httpErr(400, '"name" is required');
  const dup = store.playlists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (dup) throw httpErr(409, `There's already a playlist called “${dup.name}”`);
  const list = { id: crypto.randomUUID().slice(0, 8), name, items: [] };
  store.playlists.push(list); saveStore();
  res.json({ ...plList(), created: list.id });
}));
app.get('/api/music/playlists/:id', wrap(async (req, res) => {
  const l = playlist(req.params.id);
  res.json({ id: l.id, name: l.name, items: l.items, playing: plStatus(), crossfade: store.crossfade });
}));
app.post('/api/music/playlists/:id/rename', wrap(async (req, res) => {
  const l = playlist(req.params.id), name = plName(req.body?.name);
  if (!name) throw httpErr(400, '"name" is required');
  l.name = name; saveStore(); res.json(plList());
}));
app.post('/api/music/playlists/:id/delete', wrap(async (req, res) => {
  const l = playlist(req.params.id);
  if (plRun?.list === l.id) stopPlaylist();
  store.playlists = store.playlists.filter((x) => x !== l); saveStore();
  res.json(plList());
}));
app.post('/api/music/playlists/:id/add', wrap(async (req, res) => {
  const l = playlist(req.params.id), item = musicItem(req.body?.item);
  if (item.type !== 'song') throw httpErr(400, 'Only songs can go in a playlist');
  const added = !l.items.some((x) => x.query === item.query);
  if (added) l.items = [...l.items, item].slice(0, 300);
  saveStore(); res.json({ ...plSummary(l), added });
}));
app.post('/api/music/playlists/:id/remove', wrap(async (req, res) => {
  const l = playlist(req.params.id);
  const at = l.items.findIndex((x) => x.query === req.body?.query);
  if (at >= 0) {
    l.items.splice(at, 1);
    // Keep pointing at the song that's playing; if it was the one removed, the next check moves on to the one after it
    if (plRun?.list === l.id && at <= plRun.index) plRun.index--;
    saveStore();
  }
  res.json({ id: l.id, name: l.name, items: l.items, playing: plStatus() });
}));
// Play from "index" (default: the first song) on the given Echo
app.post('/api/music/playlists/:id/play', wrap(async (req, res) => {
  const l = playlist(req.params.id);
  if (!l.items.length) throw httpErr(409, `“${l.name}” is empty`);
  const dev = musicDevice(req.body?.device);
  const index = Math.max(0, Math.min(l.items.length - 1, Math.round(Number(req.body?.index)) || 0));
  await playlistPlay(dev, l, index);
  res.json({ device: dev.accountName, playing: l.items[index].title, playlist: plStatus() });
}));
app.post('/api/music/playlists-stop', (_req, res) => { stopPlaylist(); res.json({ playing: null }); });

// ---------- Apple Music playback on an Echo (or speaker group) ----------
// Same as alexa.playMusicProvider, but with our locale (the library hardcodes de-DE).
async function playOnProvider(dev, providerId, phrase) {
  const validateObj = {
    type: 'Alexa.Music.PlaySearchPhrase',
    operationPayload: JSON.stringify({
      deviceType: dev.deviceType, deviceSerialNumber: dev.serialNumber, locale: CFG.lang,
      customerId: dev.deviceOwnerCustomerId, musicProviderId: providerId, searchPhrase: phrase,
    }),
  };
  const v = await p((cb) => alexa.httpsGet('/api/behaviors/operation/validate', cb, { method: 'POST', data: JSON.stringify(validateObj) }));
  if (v?.result !== 'VALID') throw new Error('Alexa rejected the search phrase');
  await sequence(dev.serialNumber, {
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: { ...validateObj, operationPayload: v.operationPayload, '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode' },
  });
}

// Speaker groups ignore the music API (accepted, but nothing plays), so ask a member Echo by voice:
// "play X on apple music on <group>" — same as saying it out loud.
function groupMember(group) {
  const members = groupMembers(group);
  const d = members.find((m) => m.online !== false) || members[0];
  if (!d) throw httpErr(503, `No Echo found in group "${group.accountName}"`);
  return d;
}

// Music routes target the given Echo and remember it; without "device" they use the remembered one
// (media keys and quick controls rely on that).
function musicDevice(input) {
  if (input) {
    const d = resolveDevice(input);
    if (store.musicDevice !== d.serialNumber) { store.musicDevice = d.serialNumber; saveStore(); }
    return d;
  }
  return alexa.serialNumbers[store.musicDevice] || resolveDevice();
}

// Play a search phrase: Apple Music by default, TuneIn for radio stations. Returns how it was sent.
async function playMusic(dev, query, provider = 'APPLE_MUSIC') {
  const spoken = provider === 'TUNEIN' ? 'tunein' : 'apple music';
  delete nowCache[dev.serialNumber];
  if (dev.deviceFamily === 'WHA') {
    await textCommand(groupMember(dev), `play ${query} on ${spoken} on ${dev.accountName}`);
    return 'voice-command';
  }
  try {
    await playOnProvider(dev, provider, query);
    return 'music-api';
  } catch (e) {
    // Fallback: the spoken-style command, as if said to that Echo
    console.log(`Play via the music API failed (${e.message || e}), using a voice command`);
    await textCommand(dev, `play ${query} on ${spoken}`);
    return 'voice-command';
  }
}

// With "query": play it (and add "item", the tile shown, to recently played). Without: resume playback.
// Radio stations (item.type "radio", or provider "TUNEIN") play through TuneIn.
app.post('/api/music/play', wrap(async (req, res) => {
  const query = (req.body?.query || '').toString().trim();
  const dev = musicDevice(req.body?.device);
  if (!query) {
    await p((cb) => alexa.sendCommand(dev.serialNumber, 'play', null, cb));
    delete nowCache[dev.serialNumber];
    return res.json({ device: dev.accountName, command: 'play' });
  }
  const provider = req.body?.provider === 'TUNEIN' || req.body?.item?.type === 'radio' ? 'TUNEIN' : 'APPLE_MUSIC';
  stopPlaylist(dev.serialNumber); // something else chosen: the playlist doesn't take over again
  try {
    const item = musicItem({ title: query, ...req.body?.item, query });
    store.recent = [item, ...store.recent.filter((r) => r.query !== query)].slice(0, 30);
    saveStore();
  } catch {}
  // "queue": the other songs shown next to this one. They play after it, so a single song doesn't end in silence.
  const queue = provider === 'APPLE_MUSIC' && Array.isArray(req.body?.queue)
    ? req.body.queue.map((q) => { try { return musicItem(q); } catch { return null; } }).filter((q) => q && q.type === 'song' && q.query !== query).slice(0, 50)
    : [];
  if (queue.length) {
    const via = await playlistPlay(dev, { id: null, items: [{ query }, ...queue] }, 0).then(() => 'music-api');
    return res.json({ device: dev.accountName, playing: query, via, queued: queue.length });
  }
  res.json({ device: dev.accountName, playing: query, via: await playMusic(dev, query, provider) });
}));

// "play the latest episode of X on apple podcasts" (Alexa can't be handed a podcast through the music API)
async function playPodcastShow(dev, show) {
  const say = `play the latest episode of ${show} on apple podcasts`;
  delete nowCache[dev.serialNumber];
  if (dev.deviceFamily === 'WHA') await textCommand(groupMember(dev), `${say} on ${dev.accountName}`);
  else await textCommand(dev, say);
  return 'voice-command';
}

// ---------- Surprise me: popular Hindi songs, or podcasts to learn from, back to back without end ----------
// Built from Apple's free catalog: songs by popular artists of each kind (iTunes search lists an artist's most
// popular songs first) plus India's current chart; podcasts from a hand-picked list plus India's Technology and
// History charts. Played like a playlist (one item at a time) that tops itself up near its end. What a Surprise
// has played is kept for a few days and left out of later mixes while there's enough else.
const SURPRISE_ARTISTS = {
  new: ['Arijit Singh', 'Pritam', 'Shreya Ghoshal', 'Vishal Mishra', 'Jubin Nautiyal', 'Sachet Tandon', 'Atif Aslam', 'Badshah', 'Sachin-Jigar', 'Darshan Raval', 'Neha Kakkar', 'B Praak'],
  noughties: ['Sonu Nigam', 'KK', 'Shaan', 'Mohit Chauhan', 'Sunidhi Chauhan', 'Shankar-Ehsaan-Loy', 'A.R. Rahman', 'Himesh Reshammiya', 'Javed Ali', 'Shafqat Amanat Ali', 'Vishal-Shekhar', 'Kunal Ganjawala'],
  nineties: ['Kumar Sanu', 'Udit Narayan', 'Alka Yagnik', 'Abhijeet', 'Nadeem-Shravan', 'Anu Malik', 'Jatin-Lalit', 'Kavita Krishnamurthy', 'Sadhana Sargam', 'Hariharan'],
  classic: ['Kishore Kumar', 'Mohammed Rafi', 'Lata Mangeshkar', 'Asha Bhosle', 'R.D. Burman', 'Mukesh', 'Laxmikant-Pyarelal', 'Manna Dey', 'Hemant Kumar', 'S.D. Burman'],
  indie: ['Jagjit Singh', 'Ghulam Ali', 'Nusrat Fateh Ali Khan', 'Rahat Fateh Ali Khan', 'Kailash Kher', 'Anuv Jain', 'Prateek Kuhad', 'The Local Train', 'Papon', 'Lucky Ali', 'Pankaj Udhas', 'Ritviz'],
  punjabi: ['Diljit Dosanjh', 'AP Dhillon', 'Karan Aujla', 'Sidhu Moose Wala', 'Guru Randhawa', 'Shubh', 'Gurdas Maan', 'Masoom Sharma', 'Sapna Choudhary', 'Amit Saini Rohtakiya', 'Jassie Gill', 'Harrdy Sandhu'],
};
// Other Indian languages and devotional music are left out; "chart" songs must also be Hindi / Punjabi kinds
const NOT_HINDI = /tamil|telugu|bengali|malayalam|kannada|marathi|gujarati|bhojpuri|odia|oriya|assamese|devotional|christian|children/i;
const CHART_KINDS = /bollywood|indian pop|punjabi|haryanvi|ghazal|sufi/i;
// Versions that aren't the song as people know it (and medleys Alexa may not find)
const ODD_VERSION = /lo-?fi|slowed|reverb|mashup|instrumental|karaoke|jukebox|non ?stop|medley|remix|8d|sped up|ringtone/i;
const SURPRISE_PODCASTS = [ // say: the show's name as Alexa finds it on Apple Podcasts
  { id: '1434243584', say: 'Lex Fridman Podcast', group: 'tech' },
  { id: '1528594034', say: 'Hard Fork', group: 'tech' },
  { id: '1050462261', say: 'Acquired podcast', group: 'tech' },
  { id: '1474429475', say: 'Waveform The MKBHD Podcast', group: 'tech' },
  { id: '1516093381', say: 'Dwarkesh Podcast', group: 'tech' },
  { id: '1011668648', say: 'Decoder with Nilay Patel', group: 'tech' },
  { id: '523121474', say: 'TED Radio Hour podcast', group: 'tech' },
  { id: '160904630', say: 'TED Talks Daily', group: 'know' },
  { id: '278981407', say: 'Stuff You Should Know', group: 'know' },
  { id: '354668519', say: 'Freakonomics Radio', group: 'know' },
  { id: '1537788786', say: 'The Rest Is History', group: 'know' },
  { id: '73330895', say: 'In Our Time', group: 'know' },
  { id: '1190896090', say: 'The Seen and the Unseen', group: 'know' },
  { id: '1501941375', say: 'Figuring Out with Raj Shamani', group: 'hindi' },
  { id: '1542452346', say: 'The Ranveer Show Hindi', group: 'hindi' },
  { id: '1578091507', say: 'Padhaku Nitin', group: 'hindi' },
  { id: '1831664449', say: 'Bharat Unscripted', group: 'hindi' },
  { id: '1677107935', say: 'WTF with Nikhil Kamath', group: 'hindi' },
  { id: '1706988597', say: 'Smartphone Nation Hindi', group: 'hindi' },
];
const SURPRISE_CHARTS = { 1318: { group: 'tech', take: 15 }, 1487: { group: 'know', take: 10 } }; // Apple genre ids
const NOT_LEARNING = /apple events|learn(ing)? (english|german|french|spanish|japanese)|deutsch|coffee break/i;
const SEEN_DAYS = 3;

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// One from each group in turn (each group shuffled), so the kinds keep changing
const interleave = (groups) => {
  const lists = Object.values(groups).map((g) => shuffle([...g])).filter((g) => g.length), out = [];
  while (lists.some((g) => g.length)) for (const g of lists) if (g.length) out.push(g.shift());
  return out;
};
const words = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && w !== 'the');
const cached = {}; // key → { at, value }: Apple lookups, kept for a day (iTunes allows ~20 requests a minute)
async function cachedJson(key, url, ms = 24 * 3600000) {
  const hit = cached[key];
  if (hit && Date.now() - hit.at < ms) return hit.value;
  let value;
  for (let i = 0; value === undefined; i++) { // the chart feeds sometimes hang a request and answer the next one
    try { value = await getJson(url, 8000); } catch (e) { if (i === 1) throw e; }
  }
  cached[key] = { at: Date.now(), value };
  return value;
}

function surpriseSeen(kind, item) {
  const seen = (store.surpriseSeen ||= {})[kind] ||= {};
  seen[item.query] = Date.now();
  const old = Date.now() - SEEN_DAYS * 86400000;
  for (const [q, at] of Object.entries(seen)) if (at < old) delete seen[q];
  saveStore();
}
// Up to n items, never seen first (in the order given), then the longest-ago seen; nothing already queued
function pickFresh(kind, items, n, queued) {
  const seen = store.surpriseSeen?.[kind] || {}, have = new Set(queued.map((x) => x.query)), uniq = new Set();
  const left = items.filter((x) => !have.has(x.query) && !uniq.has(x.query) && uniq.add(x.query));
  const fresh = left.filter((x) => !seen[x.query]);
  const stale = left.filter((x) => seen[x.query]).sort((a, b) => seen[a.query] - seen[b.query]);
  return fresh.concat(stale).slice(0, n);
}

// An artist's popular songs (their top 25 in Apple's search, Hindi kinds only)
async function artistSongs(name) {
  const url = `https://itunes.apple.com/search?media=music&entity=song&limit=25&country=${MUSIC_COUNTRY}&term=${encodeURIComponent(name)}`;
  const { results = [] } = await cachedJson('artist:' + name, url);
  const want = words(name);
  return results.filter((r) => r.trackName && !NOT_HINDI.test(r.primaryGenreName || '') && !ODD_VERSION.test(`${r.trackName} ${r.collectionName}`)
      && (!r.trackTimeMillis || (r.trackTimeMillis > 90000 && r.trackTimeMillis < 15 * 60000))
      && want.some((w) => words(`${r.artistName} ${r.collectionName}`).includes(w))) // by them, not just a similar name
    .map((r) => ({ type: 'song', id: r.trackId, title: r.trackName, subtitle: r.artistName, artwork: art(r.artworkUrl100), query: phrase('song', r.trackName, r.artistName) }));
}
async function chartSongs() {
  const url = `https://rss.marketingtools.apple.com/api/v2/${MUSIC_COUNTRY.toLowerCase()}/music/most-played/100/songs.json`;
  const { feed } = await cachedJson('chart:songs', url, 6 * 3600000);
  return (feed?.results || []).filter((r) => {
    const kinds = (r.genres || []).map((g) => g.name).join(' ');
    return CHART_KINDS.test(kinds) && !NOT_HINDI.test(kinds) && !ODD_VERSION.test(r.name);
  }).map((r) => ({ type: 'song', id: r.id, title: r.name, subtitle: r.artistName, artwork: art(r.artworkUrl100), query: phrase('song', r.name, r.artistName) }));
}
// A batch of ~35 songs: a few popular songs each from one random artist of every kind, plus current hits
async function surpriseSongs(queued = []) {
  const groups = {};
  await Promise.all([
    ...Object.entries(SURPRISE_ARTISTS).map(async ([kind, names]) => {
      for (const name of shuffle([...names]).slice(0, 3)) { // another artist if one finds nothing
        const songs = await artistSongs(name).catch((e) => { console.log(`Surprise: ${name}: ${e.message}`); return []; });
        const picked = pickFresh('song', shuffle(songs.slice(0, 15)), 5, queued); // their 15 most popular
        if (picked.length) { groups[kind] = picked; break; }
      }
    }),
    chartSongs().then((s) => { groups.chart = pickFresh('song', shuffle(s), 6, queued); }).catch((e) => console.log('Surprise: chart:', e.message)),
  ]);
  return pickFresh('song', interleave(groups), 40, queued); // (the same song can come from two kinds)
}

async function podcastPool() {
  const ids = SURPRISE_PODCASTS.map((x) => x.id).join(',');
  const look = await cachedJson('pod:picked', `https://itunes.apple.com/lookup?id=${ids}&country=${MUSIC_COUNTRY}`).catch(() => ({ results: [] }));
  const byId = Object.fromEntries((look.results || []).map((r) => [String(r.collectionId), r]));
  const tile = (id, say, title, author, artwork, group) => ({ type: 'podcast', id, title: title || say, subtitle: author || 'Podcast', artwork, query: say, group });
  const pool = SURPRISE_PODCASTS.map((x) => {
    const r = byId[x.id] || {};
    return tile(x.id, x.say, r.collectionName, r.artistName, r.artworkUrl600 || art(r.artworkUrl100, 600), x.group);
  });
  await Promise.all(Object.entries(SURPRISE_CHARTS).map(async ([genre, { group, take }]) => {
    const url = `https://itunes.apple.com/${MUSIC_COUNTRY.toLowerCase()}/rss/toppodcasts/limit=40/genre=${genre}/json`;
    const entries = (await cachedJson('pod:chart:' + genre, url, 6 * 3600000).catch(() => ({})))?.feed?.entry || [];
    for (const e of entries.filter((x) => !NOT_LEARNING.test(x['im:name']?.label || '')).slice(0, take)) {
      const id = e.id?.attributes?.['im:id'], title = e['im:name']?.label;
      if (!id || !title || pool.some((x) => x.id === id)) continue;
      // Alexa finds a show by its name without the tagline ("The AI Daily Brief: Artificial Intelligence News…"),
      // but a one-word name is too vague ("Empire: World History" → "empire" plays a song): then the whole title
      const short = title.split(/:| \| | - | – /)[0].trim();
      const say = short.split(/\s+/).length >= 2 ? short : title.replace(/[:|–-]/g, ' ').replace(/\s+/g, ' ').trim();
      pool.push(tile(id, say, title, e['im:artist']?.label, e['im:image']?.at(-1)?.label?.replace(/\/\d+x\d+bb/, '/600x600bb') || null, /[ऀ-ॿ]/.test(title) ? 'hindi' : group));
    }
  }));
  return pool;
}
// A batch of 9 shows: tech, Hindi and knowledge in turn
async function surprisePodcasts(queued = []) {
  const pool = await podcastPool(), groups = {};
  for (const p of pool) (groups[p.group] ||= []).push(p);
  return pickFresh('podcast', interleave(groups), 9, queued).map(({ group, ...p }) => p);
}

// { device, kind: 'song' | 'podcast' }: start a new mix; it plays until something else is chosen
app.post('/api/music/surprise', wrap(async (req, res) => {
  const kind = req.body?.kind === 'podcast' ? 'podcast' : 'song';
  const dev = musicDevice(req.body?.device);
  const build = kind === 'podcast' ? surprisePodcasts : surpriseSongs;
  const items = await build();
  if (!items.length) throw httpErr(502, 'Apple Music isn\'t answering right now, try again in a minute');
  let adding = null; // one top-up at a time
  const more = () => (adding ||= build(items).finally(() => { adding = null; }));
  stopPlaylist(dev.serialNumber);
  await playlistPlay(dev, { id: null, items, more, surprise: kind }, 0);
  res.json({ device: dev.accountName, kind, playing: items[0].title, by: items[0].subtitle, queued: items.length });
}));

app.post('/api/music/:cmd(pause|next|previous)', wrap(async (req, res) => {
  const dev = musicDevice(req.body?.device);
  // A local playlist is playing here: next / previous move through it, not Alexa's own up-next songs
  if (req.params.cmd !== 'pause' && plRun?.serial === dev.serialNumber) {
    await playlistStep(req.params.cmd === 'next' ? 1 : -1);
    return res.json({ device: dev.accountName, command: req.params.cmd, playlist: plStatus() });
  }
  await p((cb) => alexa.sendCommand(dev.serialNumber, req.params.cmd, null, cb));
  delete nowCache[dev.serialNumber];
  res.json({ device: dev.accountName, command: req.params.cmd });
}));

// Shuffle / repeat on or off (where the music source allows it; /api/music/now says)
app.post('/api/music/:mode(shuffle|repeat)', wrap(async (req, res) => {
  const dev = musicDevice(req.body?.device);
  const on = !!req.body?.on;
  await p((cb) => alexa.sendCommand(dev.serialNumber, req.params.mode, on, cb));
  delete nowCache[dev.serialNumber];
  res.json({ device: dev.accountName, [req.params.mode]: on });
}));

// What plays next; jump to one of those tracks with its id
app.get('/api/music/queue', wrap(async (req, res) => {
  const dev = musicDevice(req.query.device);
  const q = (await p((cb) => alexa.getPlayerQueue(dev.serialNumber, 30, cb)))?.queueInfo || {};
  res.json((q.media || []).map((m) => ({
    id: m.queueItemId || m.mediaId || m.id || null,
    title: m.infoText?.title || m.title || '',
    artist: m.infoText?.subText1 || m.artist || '',
    artwork: m.mainArt?.url || m.art?.url || null,
    length: m.durationSeconds ?? m.mediaLength ?? null,
  })).filter((m) => m.title));
}));
app.post('/api/music/jump', wrap(async (req, res) => {
  const dev = musicDevice(req.body?.device);
  if (!req.body?.id) throw httpErr(400, '"id" (from /api/music/queue) is required');
  await p((cb) => alexa.sendCommand(dev.serialNumber, 'jump', String(req.body.id), cb));
  delete nowCache[dev.serialNumber];
  res.json({ device: dev.accountName, jumped: req.body.id });
}));

// Skip within the track. Amazon's Forward/Rewind/Seek player commands don't seek on Apple Music
// (they change track or are ignored), but the spoken "skip forward / rewind N seconds" does.
async function seekBy(dev, seconds) {
  const text = seconds > 0 ? `skip forward ${seconds} seconds` : `rewind ${-seconds} seconds`;
  // A group member must be told the group by name; plain "skip forward" on a member pauses the group
  if (dev.deviceFamily === 'WHA') await textCommand(groupMember(dev), `${text} on ${dev.accountName}`);
  else await textCommand(dev, text);
}
app.post('/api/music/seek', wrap(async (req, res) => {
  const seconds = Math.round(Number(req.body?.seconds));
  if (!seconds || Math.abs(seconds) > 600) throw httpErr(400, '"seconds" is required: e.g. 15 to skip forward, -10 to go back');
  const dev = musicDevice(req.body?.device);
  await seekBy(dev, seconds);
  res.json({ device: dev.accountName, seconds });
}));

// Move what's playing to another Echo or group: start the same song (or station) there, pause it here and
// skip to about the same point. Only that song moves, not the album or playlist around it.
app.post('/api/music/move', wrap(async (req, res) => {
  const from = resolveDevice(req.body?.from || store.musicDevice);
  const to = resolveDevice(req.body?.to);
  if (from.serialNumber === to.serialNumber) throw httpErr(400, 'Pick a different Echo to move to');
  const i = await playerInfo(from.serialNumber, true);
  const title = i.infoText?.title, provider = i.provider?.providerName || '';
  if (!title) throw httpErr(409, `Nothing is playing on ${from.accountName}`);
  if (/bluetooth/i.test(provider)) throw httpErr(409, 'Bluetooth audio can\'t be moved: it comes from the phone or PC');
  const radio = /tunein|radio/i.test(provider);
  const query = radio ? title : `${clean(title)} by ${mainArtist(i.infoText?.subText1 || '')}`.replace(/ by $/, '');
  const startedAt = Date.now(), pos = i.progress?.mediaProgress || 0;
  stopPlaylist(from.serialNumber);
  await playMusic(to, query, radio ? 'TUNEIN' : 'APPLE_MUSIC');
  await p((cb) => alexa.sendCommand(from.serialNumber, 'pause', null, cb)).catch(() => {});
  delete nowCache[from.serialNumber];
  store.musicDevice = to.serialNumber; saveStore();
  if (!radio && pos > 20) {
    // Once it has started there, catch up to where it was (voice seek; about right, not to the second)
    setTimeout(() => seekBy(to, Math.min(600, Math.round(pos + (Date.now() - startedAt) / 1000)))
      .catch((e) => console.log('Move: seeking failed:', e.message)), 5000);
  }
  res.json({ from: from.accountName, to: to.accountName, playing: query });
}));

// Sleep timer: pause after N minutes (0 cancels). Kept in memory, so a restart clears it.
const sleepTimers = {}; // serial -> { at, timer }
app.post('/api/music/sleep', wrap(async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!(minutes >= 0 && minutes <= 600)) throw httpErr(400, '"minutes" is required (0 cancels)');
  const dev = musicDevice(req.body?.device);
  const serial = dev.serialNumber;
  clearTimeout(sleepTimers[serial]?.timer);
  delete sleepTimers[serial];
  if (minutes > 0) {
    const at = Date.now() + minutes * 60000;
    sleepTimers[serial] = {
      at,
      timer: setTimeout(() => {
        delete sleepTimers[serial];
        alexa.sendCommand(serial, 'pause', null, (e) => console.log(e ? `Sleep timer: pausing ${dev.accountName} failed: ${e.message}` : `Sleep timer: paused ${dev.accountName}`));
      }, minutes * 60000),
    };
  }
  res.json({ device: dev.accountName, sleepAt: sleepTimers[serial]?.at ?? null });
}));

// Player info, shared for 3s between the pages polling it (fresh = skip the cache)
async function playerInfo(serial, fresh) {
  const c = nowCache[serial];
  if (!fresh && c && Date.now() - c.at < 3000) return c.info;
  const info = (await p((cb) => alexa.getPlayerInfo(serial, cb)))?.playerInfo || {};
  nowCache[serial] = { at: Date.now(), info };
  return info;
}
// Shuffle / repeat button states: SELECTED = on, ENABLED = off but available, anything else = not available
const transport = (v) => (v === 'SELECTED' ? true : v === 'ENABLED' ? false : null);

app.get('/api/music/now', wrap(async (req, res) => {
  const dev = musicDevice(req.query.device);
  const i = await playerInfo(dev.serialNumber);
  res.json({
    device: dev.accountName,
    serial: dev.serialNumber,
    sleepAt: sleepTimers[dev.serialNumber]?.at ?? null,
    state: i.state || null, // PLAYING | PAUSED | IDLE | null
    title: i.infoText?.title || null,
    artist: i.infoText?.subText1 || null,
    album: i.infoText?.subText2 || null,
    artwork: i.mainArt?.url || null,
    provider: i.provider?.providerName || null,
    length: i.progress?.mediaLength ?? null,
    position: i.progress?.mediaProgress ?? null,
    shuffle: transport(i.transport?.shuffle),
    repeat: transport(i.transport?.repeat),
    surprise: plRun?.serial === dev.serialNumber ? plRun.surprise || null : null, // a Surprise mix playing here
  });
}));

// Echos that can speak (not groups, the Alexa app, PCs or the TV entry)
const speakers = () => Object.values(alexa.serialNumbers)
  .filter((d) => d.online !== false && !['WHA', 'VOX', 'REAVER', 'THIRD_PARTY_AVS_VIDEO_FIRST'].includes(d.deviceFamily));

// ---------- Routines ----------
let routinesCache = null; // { at, list } — full routine objects are needed to run them
async function routines() {
  if (!routinesCache || Date.now() - routinesCache.at > 5 * 60 * 1000) {
    const list = await p((cb) => alexa.getAutomationRoutines(cb));
    routinesCache = { at: Date.now(), list: (Array.isArray(list) ? list : []).filter((r) => r.status === 'ENABLED' && r.sequence) };
  }
  return routinesCache.list;
}
const routineName = (r) => r.name || r.triggers?.find((t) => t.payload?.utterance)?.payload.utterance || 'Routine';

app.get('/api/routines', wrap(async (_req, res) => {
  res.json((await routines()).map((r) => ({ id: r.automationId, name: routineName(r) })).sort((a, b) => a.name.localeCompare(b.name)));
}));

// device = the Echo the routine runs "from" (where Alexa answers); defaults like voice commands
app.post('/api/routines/run', wrap(async (req, res) => {
  const r = (await routines()).find((x) => x.automationId === req.body?.id);
  if (!r) throw httpErr(404, 'Routine not found. Refresh the list.');
  let dev = commandDevice(req.body?.device);
  if (dev.deviceFamily === 'WHA') dev = groupMember(dev); // groups can't run sequences themselves
  // A routine takes over: end a playlist or Surprise mix and pause it first. Otherwise the checks take the routine
  // interrupting the song for the song ending and start the next one, and the mix plays on after the routine.
  if (plRun) {
    const serial = plRun.serial;
    stopPlaylist();
    await p((cb) => alexa.sendCommand(serial, 'pause', null, cb)).catch(() => {});
  }
  await sequence(dev.serialNumber, r);
  res.json({ ran: routineName(r), via: dev.accountName });
}));

// Smart home devices Alexa knows about (useful to find the exact TV name)
app.get('/api/smarthome', wrap(async (_req, res) => {
  const list = await p((cb) => alexa.getSmarthomeEntities(cb));
  res.json((Array.isArray(list) ? list : []).map((e) => ({
    name: e.displayName, id: e.id, type: e.type || e.entityType, actions: e.supportedOperations || e.supportedProperties,
  })));
}));

app.get('/api/health', (_req, res) => res.json({ ready }));

// Phone access in the desktop app, which listens on 127.0.0.1 only: while it's on, also listen on the network.
// (`npm start` already listens on all interfaces.) Either way, other devices still need the key (see above).
let lanServer = null;
const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(CFG.host);
function syncLan() {
  const want = loopbackOnly && store.phone.enabled;
  if (want && !lanServer) {
    lanServer = app.listen(CFG.port, '::', () => console.log(`Phone access: listening on the network (port ${CFG.port})`))
      .on('error', (e) => { console.log('Phone access: could not listen on the network:', e.message); lanServer = null; });
  } else if (!want && lanServer) {
    lanServer.close();
    lanServer = null;
  }
}

// Alarms & timers, lists, scenes, Do Not Disturb, equalizer, Bluetooth, sounds, smart home, radio, live updates…
features = require('./alexa-features')({
  alexa, p, sequence, resolveDevice, groupMembers, groupMember, commandDevice, textCommand, speakers, musicDevice,
  musicItem, art, store, saveStore, events, CFG, httpErr, wrap, volumeCache, nowCache, syncLan, isLocal, lanKey, stopPlaylist,
  musicCountry: MUSIC_COUNTRY,
});
app.use('/api', features.router);

// JSON (not Express's HTML pages) for unknown API routes and malformed request bodies
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({
  error: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : err.message || String(err),
}));

// One copy at a time. The desktop app listens on 127.0.0.1 and `npm start` on all interfaces, so both could
// bind the same port and the browser would reach either one; check both loopback addresses first.
const portTaken = (port) => Promise.all(['127.0.0.1', '::1'].map((host) => new Promise((resolve) => {
  const s = net.connect({ host, port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
}))).then((r) => r.includes(true));

function listenError(e) {
  if (events.emit('listen-error', e)) return; // desktop app shows a message
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`\n✖ Port ${CFG.port} is already in use: Echo Volume (the desktop app or another "npm start") is already running.`
    + `\n  Use it at http://localhost:${CFG.port}, or quit it first.\n`);
  process.exit(1);
}

portTaken(CFG.port).then((taken) => {
  if (taken) return listenError(Object.assign(new Error(`Port ${CFG.port} is already in use`), { code: 'EADDRINUSE' }));
  app.listen(CFG.port, CFG.host, () => {
    console.log(`Echo Volume API → http://localhost:${CFG.port}  (UI at /)   data: ${DATA_DIR}`);
    events.emit('listening', CFG.port);
    syncLan();
    startAlexa();
  }).on('error', listenError);
});

module.exports = { events, port: CFG.port, proxyPort: CFG.proxyPort, isReady: () => ready, theme: () => store.theme };
