// SmartThings integration (official API) — Samsung TV power, volume, mute, input, channel.
// Auth: OAuth-In app created with the SmartThings CLI. Tokens are stored in st-token.json and
// refreshed automatically (access token ~24h; refresh tokens are single-use and rotate).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const API = 'https://api.smartthings.com';
const ST = {
  clientId: process.env.ST_CLIENT_ID || '',
  clientSecret: process.env.ST_CLIENT_SECRET || '',
  redirectUri: process.env.ST_REDIRECT_URI || 'https://httpbin.org/get',
  tvDeviceId: process.env.ST_TV_DEVICE_ID || '',
  scope: 'r:devices:* x:devices:*',
  tokenFile: path.join(process.env.DATA_DIR || __dirname, 'st-token.json'),
};
const configured = () => !!(ST.clientId && ST.clientSecret);

// ---------- tokens ----------
let token = (() => { try { return JSON.parse(fs.readFileSync(ST.tokenFile, 'utf8')); } catch { return null; } })();
let pendingState = null;

function saveToken(t) {
  token = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 86399) * 1000 };
  fs.writeFileSync(ST.tokenFile, JSON.stringify(token, null, 2));
}

async function tokenRequest(params) {
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${ST.clientId}:${ST.clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ client_id: ST.clientId, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw httpErr(r.status === 400 || r.status === 401 ? 401 : 502, `SmartThings token error: ${j.error_description || j.error || r.status}`);
  saveToken(j);
}

let refreshing = null;
async function refresh() {
  if (!token?.refresh_token) throw httpErr(401, 'SmartThings not connected. Open /smartthings.html');
  // Single-use refresh tokens: never run two refreshes at once
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token })
    .then(() => console.log('✔ SmartThings token refreshed → st-token.json'))
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function accessToken() {
  if (!configured()) throw httpErr(503, 'SmartThings not configured: set ST_CLIENT_ID and ST_CLIENT_SECRET in .env');
  if (!token) throw httpErr(401, 'SmartThings not connected. Open /smartthings.html');
  if (Date.now() > token.expires_at - 60 * 60 * 1000) await refresh(); // refresh 1h before expiry
  return token.access_token;
}

// Refresh every 12h so the refresh token never goes unused long enough to expire
setInterval(() => { if (configured() && token) refresh().catch((e) => console.log('SmartThings refresh failed:', e.message)); }, 12 * 60 * 60 * 1000).unref();

// ---------- API helpers ----------
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function st(method, url, body) {
  const doFetch = async () => fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body && JSON.stringify(body),
  });
  let r = await doFetch();
  if (r.status === 401 && token) { await refresh(); r = await doFetch(); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 409) throw httpErr(409, 'The TV is off. Turn it on first.'); // SmartThings: "invalid device state"
  if (!r.ok) throw httpErr(r.status, `SmartThings: ${j.error?.message || j.message || r.status}`);
  return j;
}

let tvId = ST.tvDeviceId;
async function tvDeviceId() {
  if (tvId) return tvId;
  const { items = [] } = await st('GET', '/v1/devices');
  const caps = (d) => (d.components || []).flatMap((c) => (c.capabilities || []).map((x) => x.id));
  const tv = items.find((d) => d.ocf?.ocfDeviceType === 'oic.d.tv')
    || items.find((d) => caps(d).includes('tvChannel') && caps(d).includes('audioVolume'));
  if (!tv) throw httpErr(404, 'No TV found in SmartThings. Set ST_TV_DEVICE_ID in .env (GET /api/st/devices lists devices).');
  tvId = tv.deviceId;
  return tvId;
}

const command = async (capability, cmd, args = []) =>
  st('POST', `/v1/devices/${await tvDeviceId()}/commands`, { commands: [{ component: 'main', capability, command: cmd, arguments: args }] });

// What's on screen. The TV reports the running app's Tizen package as tvChannelName
// (e.g. "9Ur5IzDKqV.TizenYouTube"), or a channel number + name for live TV. No titles are reported.
const APP_PACKAGES = { youtube: 'YouTube', netflix: 'Netflix', amazon: 'Prime Video', primevideo: 'Prime Video',
  hotstar: 'JioHotstar', disney: 'Disney+', sonyliv: 'SonyLIV', zee5: 'ZEE5', spotify: 'Spotify', appletv: 'Apple TV',
  jiocinema: 'JioCinema', mxplayer: 'MX Player', browser: 'Internet', tvplus: 'Samsung TV Plus' };
function nowPlaying(channel, channelName, input, inputs) {
  if (channel) return { kind: 'channel', label: channelName ? `Channel ${channel} · ${channelName}` : `Channel ${channel}` };
  if (channelName && /\./.test(channelName)) {
    const pkg = channelName.split('.').pop();
    const key = Object.keys(APP_PACKAGES).find((k) => pkg.toLowerCase().includes(k));
    return { kind: 'app', label: key ? APP_PACKAGES[key] : pkg.replace(/^Tizen/, '').replace(/([a-z])([A-Z])/g, '$1 $2'), package: channelName };
  }
  if (channelName) return { kind: 'channel', label: channelName };
  if (input && input !== 'dtv') return { kind: 'input', label: inputs.find((i) => i.id === input)?.name || input };
  return null;
}

// fast=true: skips the device details (name) for frequent polling; health is read every time, because it's
// what tells us the TV is off: once the TV goes offline SmartThings keeps the last switch value ("on") and app.
let tvMeta = { name: null, online: null };
let poweredOnAt = 0; // a TV just switched on reports itself online a few seconds later; trust the switch until then
async function tvStatus(fast) {
  const id = await tvDeviceId();
  const [dev, status, health] = await Promise.all([
    fast && tvMeta.name ? null : st('GET', `/v1/devices/${id}`),
    st('GET', `/v1/devices/${id}/components/main/status`),
    st('GET', `/v1/devices/${id}/health`).catch(() => ({})),
  ]);
  if (dev) tvMeta.name = dev.label || dev.name;
  tvMeta.online = health?.state ? health.state === 'ONLINE' : null;
  const offline = tvMeta.online === false && Date.now() - poweredOnAt > 60000;
  const v = (cap, attr) => (cap === 'switch' && offline ? 'off' : status[cap]?.[attr]?.value ?? null);
  // Samsung TVs list inputs as [{id, name}] in samsungvd.mediaInputSource; standard capability as plain ids
  const samsungInputs = v('samsungvd.mediaInputSource', 'supportedInputSourcesMap');
  const inputs = Array.isArray(samsungInputs) && samsungInputs.length
    ? samsungInputs.map((i) => ({ id: i.id, name: i.name || i.id }))
    : (v('mediaInputSource', 'supportedInputSources') || []).map((i) => ({ id: i, name: i }));
  const input = v('samsungvd.mediaInputSource', 'inputSource') ?? v('mediaInputSource', 'inputSource');
  return {
    name: tvMeta.name,
    nowPlaying: v('switch', 'switch') === 'on' ? nowPlaying(v('tvChannel', 'tvChannel'), v('tvChannel', 'tvChannelName'), input, inputs) : null,
    deviceId: id,
    online: tvMeta.online,
    power: v('switch', 'switch'),
    volume: v('audioVolume', 'volume'),
    muted: v('audioMute', 'mute') === 'muted',
    input,
    inputs,
    samsungInputs: Array.isArray(samsungInputs) && samsungInputs.length > 0,
    channel: v('tvChannel', 'tvChannel'),
  };
}

// ---------- routes (mounted at /api/st) ----------
const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message || String(e) }));
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));

router.get('/auth/status', (_req, res) => res.json({ configured: configured(), connected: !!token, redirectUri: ST.redirectUri }));

router.get('/auth/url', (_req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Set ST_CLIENT_ID and ST_CLIENT_SECRET in .env, then restart' });
  pendingState = crypto.randomBytes(16).toString('hex');
  const q = new URLSearchParams({ client_id: ST.clientId, response_type: 'code', redirect_uri: ST.redirectUri, scope: ST.scope, state: pendingState });
  res.json({ url: `${API}/oauth/authorize?${q}` });
});

router.post('/auth/code', wrap(async (req, res) => {
  const { code, state } = req.body || {};
  if (!code) throw httpErr(400, '"code" is required');
  if (state && pendingState && state !== pendingState) throw httpErr(400, 'State mismatch, start sign-in again');
  await tokenRequest({ grant_type: 'authorization_code', code: String(code).trim(), redirect_uri: ST.redirectUri });
  pendingState = null;
  console.log('✔ SmartThings connected → st-token.json');
  res.json({ connected: true });
}));

router.get('/devices', wrap(async (_req, res) => {
  const { items = [] } = await st('GET', '/v1/devices');
  res.json(items.map((d) => ({ name: d.label || d.name, deviceId: d.deviceId, type: d.ocf?.ocfDeviceType || d.type })));
}));

// ---------- app launcher (custom.launchapp) ----------
// Tizen app IDs. Add more in .env: ST_TV_APPS=[{"name":"ZEE5","appId":"..."}]
const DEFAULT_APPS = [
  { name: 'YouTube', appId: '111299001912' },
  { name: 'Netflix', appId: '3201907018807' },
  { name: 'Prime Video', appId: '3201910019365' },
  { name: 'Disney+', appId: '3201901017640' },
  { name: 'Apple TV', appId: '3201807016597' },
  { name: 'Spotify', appId: '3201606009684' },
];
const APPS = (() => {
  try { return [...DEFAULT_APPS, ...JSON.parse(process.env.ST_TV_APPS || '[]')]; } catch { return DEFAULT_APPS; }
})();

// Ask the TV to re-report its state (SmartThings caches values; remote-control changes aren't pushed)
router.post('/tv/refresh', wrap(async (_req, res) => {
  await command('refresh', 'refresh');
  res.json({ ok: true });
}));

router.post('/tv/key',wrap(async (req, res) => {
  const key = String(req.body?.key || '').toUpperCase();
  if (!['UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'BACK', 'EXIT', 'MENU', 'HOME', 'MUTE', 'PLAY', 'PAUSE'].includes(key)) throw httpErr(400, 'Unsupported key');
  await command('samsungvd.remoteControl', 'send', [key, 'PRESS_AND_RELEASED']);
  res.json({ key });
}));

router.get('/tv/apps',(_req, res) => res.json(APPS));

router.post('/tv/app', wrap(async (req, res) => {
  const { appId, appName } = req.body || {};
  if (!appId && !appName) throw httpErr(400, '"appId" or "appName" is required');
  const preset = APPS.find((a) => a.appId === appId || (appName && a.name.toLowerCase() === String(appName).toLowerCase()));
  const id = appId || preset?.appId || '';
  const name = appName || preset?.name || '';
  await command('custom.launchapp', 'launchApp', name ? [id, name] : [id]);
  res.json({ launched: name || id, appId: id || null });
}));

// ?refresh=1 first asks the TV to re-report (throttled to once per 5s), so remote-control changes show up
let lastRefresh = 0;
router.get('/tv', wrap(async (req, res) => {
  if (req.query.refresh && Date.now() - lastRefresh > 5000) {
    lastRefresh = Date.now();
    await command('refresh', 'refresh').catch((e) => console.log('TV refresh failed:', e.message));
  }
  res.json(await tvStatus(!!req.query.fast));
}));

router.post('/tv/power', wrap(async (req, res) => {
  const on = req.body?.on !== false;
  await command('switch', on ? 'on' : 'off');
  poweredOnAt = on ? Date.now() : 0;
  res.json({ power: on ? 'on' : 'off' });
}));

router.post('/tv/volume', wrap(async (req, res) => {
  const level = req.body?.level;
  if (level === undefined || isNaN(level)) throw httpErr(400, '"level" (0-100) is required');
  await command('audioVolume', 'setVolume', [clamp(level)]);
  res.json({ volume: clamp(level) });
}));

router.post('/tv/volume/:dir(up|down)', wrap(async (req, res) => {
  await command('audioVolume', req.params.dir === 'up' ? 'volumeUp' : 'volumeDown');
  res.json({ ok: true });
}));

router.post('/tv/:m(mute|unmute)', wrap(async (req, res) => {
  await command('audioMute', req.params.m);
  res.json({ muted: req.params.m === 'mute' });
}));

router.post('/tv/input', wrap(async (req, res) => {
  const source = (req.body?.source || '').toString();
  if (!source) throw httpErr(400, '"source" is required, e.g. "HDMI1"');
  // Samsung TVs take the source id via their own capability; fall back to the standard one
  await command('samsungvd.mediaInputSource', 'setInputSource', [source])
    .catch(() => command('mediaInputSource', 'setInputSource', [source]));
  res.json({ input: source });
}));

router.post('/tv/channel/:dir(up|down)', wrap(async (req, res) => {
  await command('tvChannel', req.params.dir === 'up' ? 'channelUp' : 'channelDown');
  res.json({ ok: true });
}));

module.exports = { router, configured };
