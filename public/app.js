// Echo Volume main page: devices, TV, Apple Music & Podcasts, playlists, Alexa (moved out of index.html for the CSP)
if (/Electron/.test(navigator.userAgent)) document.documentElement.classList.add('app');
const $ = (id) => document.getElementById(id);
// API key: only needed on other devices (a phone opens the link with ?key=…, remembered for next time)
const key = (() => {
  const k = new URLSearchParams(location.search).get('key');
  try { if (k) localStorage.setItem('apiKey', k); return k || localStorage.getItem('apiKey') || ''; } catch { return k || ''; }
})();
const api = (url, body) => fetch('/api' + url, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(key && { 'x-api-key': key }) },
  body: body && JSON.stringify(body),
}).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// Theme and the music Echo are saved on the server, so the browser and the desktop app match
const THEMES = ['light', 'dark', 'midnight'];
const THEME_NAMES = { system: 'Auto (match Windows)', light: 'Light', dark: 'Dark', midnight: 'Midnight' };
const THEME_HINTS = { system: 'Light or Midnight, following Windows', light: 'Bright and airy', dark: 'Flat graphite, no glow', midnight: 'Deep navy with a cyan glow' };
let themeNow = 'system';
function applyTheme(t) {
  themeNow = THEMES.includes(t) ? t : 'system';
  if (THEMES.includes(t)) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $('theme').title = `Theme: ${THEME_NAMES[themeNow]}`;
  // Phones colour their status bar to match
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0b0f1a');
}
let uiState = { theme: 'system', musicDevice: '' };
const uiReady = api('/ui').then((s) => { uiState = s; applyTheme(s.theme); }).catch(() => {});
$('theme').onclick = async () => {
  const t = await UI.menu($('theme'), ['system', 'light', 'dark', 'midnight']
    .map((value) => ({ value, swatch: value, label: THEME_NAMES[value], hint: THEME_HINTS[value], checked: value === themeNow })));
  if (!t || t === themeNow) return;
  applyTheme(t);
  api('/ui', { theme: t }).catch(() => {});
};
// Greeting by time of day, refreshed every few minutes (the app stays open all day)
function greet() {
  const h = new Date().getHours();
  $('hello').textContent = h < 5 ? 'Good night!' : h < 12 ? 'Good morning!' : h < 17 ? 'Good afternoon!' : 'Good evening!';
}
greet(); setInterval(greet, 5 * 60 * 1000);
// Collapsible menu (wide screens), remembered on this device
function setMenuCollapsed(mini) {
  document.querySelector('.shell').classList.toggle('mini', mini);
  $('sideToggle').setAttribute('aria-expanded', String(!mini));
  $('sideToggle').title = mini ? 'Expand the menu' : 'Collapse the menu';
  document.querySelectorAll('#tabs button').forEach((b) => { b.title = mini ? b.querySelector('.l').textContent : ''; });
}
try { setMenuCollapsed(localStorage.getItem('menuCollapsed') === '1'); } catch {}
$('sideToggle').onclick = () => {
  const mini = !document.querySelector('.shell').classList.contains('mini');
  setMenuCollapsed(mini);
  try { localStorage.setItem('menuCollapsed', mini ? '1' : '0'); } catch {}
};

const KIND = { KNIGHT:'Echo Show', ECHO:'Echo', ROOK:'Echo', WHA:'Speaker group', VOX:'Alexa app', REAVER:'PC', THIRD_PARTY_AVS_VIDEO_FIRST:'TV' };
const isMain = (d) => d.online && !['VOX', 'REAVER', 'THIRD_PARTY_AVS_VIDEO_FIRST'].includes(d.family);
const order = (d) => (d.family === 'KNIGHT' ? 0 : d.family === 'WHA' ? 2 : 1);

let showAll = false;
try { showAll = localStorage.getItem('showAll') === '1'; } catch {}
$('showAll').checked = showAll;

let devices = [];
const muted = {}; // serial -> volume before mute (UI side)

function setConn(state, text) { $('dot').className = 'dot ' + state; $('connText').textContent = text; }

function render() {
  const list = devices.filter((d) => showAll || isMain(d)).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  if (!list.length) { $('grid').innerHTML = '<div class="empty">No devices to show.</div>'; return; }
  $('grid').innerHTML = list.map((d) => `
    <div class="card ${d.online ? '' : 'offline'}" data-serial="${esc(d.serial)}">
      <div class="top"><span class="name" title="${esc(d.name)}">${esc(d.name)}</span><span class="kind">${esc(KIND[d.family] || d.family)}${d.online ? '' : ' · offline'}</span></div>
      <div class="vol" data-el="vol">–</div>
      <input type="range" min="0" max="10" step="1" value="0" data-el="slider" aria-label="Volume for ${esc(d.name)}" />
      <div class="row">
        <button data-act="down" aria-label="Volume down">− 1</button>
        <button data-act="up" aria-label="Volume up">+ 1</button>
        <button data-act="mute">Mute</button>
      </div>
      <div class="presets">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => `<button data-preset="${v}" aria-label="Volume ${v}">${v}</button>`).join('')}</div>
      ${d.members?.length ? `<div class="members">${d.members.map((m) => memberRow(m, d.name)).join('')}</div>` : ''}
      <div class="status" data-el="status"></div>
    </div>`).join('');
  list.forEach((d) => loadVolume(d.serial));
  if (typeof decorateCards === 'function') decorateCards(); // extras.js: Do Not Disturb and timer badges
}
// Speaker group cards: each member Echo's own volume (the big number is their average)
function memberRow(serial, group) {
  const name = devices.find((x) => x.serial === serial)?.name || serial;
  return `<div class="mrow" data-member="${esc(serial)}"><span>${esc(name)}</span>
    <input type="range" min="0" max="10" step="1" value="0" aria-label="Volume for ${esc(name)} in ${esc(group)}" /><b>–</b></div>`;
}

const card = (serial) => document.querySelector(`.card[data-serial="${CSS.escape(serial)}"]`);
const el = (serial, name) => card(serial)?.querySelector(`[data-el="${name}"]`);

// Device volume is 0-100; UI uses Alexa's 0-10 steps ("Alexa, volume 3" = 30)
const toStep = (v) => (v == null ? null : Math.round(v / 10));
const level = {}; // serial -> current step 0-10

function showVol(serial, v) {
  const s = toStep(v);
  if (s != null && serial === musicTarget()) { // volume row in the music card
    if (!timers.music && document.activeElement !== $('mVolSlider')) $('mVolSlider').value = s;
    $('mVolVal').textContent = s;
  }
  if (s != null) {
    document.querySelectorAll(`.mrow[data-member="${CSS.escape(serial)}"]`).forEach((r) => {
      if (document.activeElement !== r.querySelector('input')) r.querySelector('input').value = s;
      r.querySelector('b').textContent = s;
    });
  }
  const c = card(serial); if (!c) return;
  if (s != null) level[serial] = s;
  const isMuted = v === 0 && muted[serial] != null;
  el(serial, 'vol').innerHTML = s == null ? '–<small>unknown</small>' : isMuted ? `0<small>muted</small>` : `${s}<small>/ 10</small>`;
  el(serial, 'vol').classList.toggle('muted', isMuted);
  if (s != null) el(serial, 'slider').value = s;
  c.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('cur', +b.dataset.preset === s && !isMuted));
  const btn = c.querySelector('[data-act="mute"]');
  btn.textContent = isMuted ? 'Unmute' : 'Mute';
  btn.classList.toggle('on', isMuted);
}
function status(serial, text, err) {
  const s = el(serial, 'status'); if (!s) return;
  s.textContent = text; s.classList.toggle('err', !!err);
  if (!err && text) setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 2000);
}

const pending = {}; // serial -> volume changes in flight
async function loadVolume(serial) {
  const before = reqId[serial];
  try {
    const v = (await api('/volume?device=' + encodeURIComponent(serial))).volume;
    if (!pending[serial] && reqId[serial] === before) showVol(serial, v); // don't overwrite a newer change
  } catch (e) { status(serial, e.message, true); }
}

// Optimistic: update the UI immediately, then send. Only the latest request per device updates status.
const reqId = {};
async function setLevel(serial, step) {
  step = Math.max(0, Math.min(10, step));
  const id = (reqId[serial] = (reqId[serial] || 0) + 1);
  if (step > 0) delete muted[serial];
  showVol(serial, step * 10);
  pending[serial] = (pending[serial] || 0) + 1;
  try {
    const r = await api('/volume', { device: serial, level: step * 10 });
    if (id === reqId[serial]) status(serial, step === 0 && muted[serial] != null ? 'Muted' : 'Volume ' + toStep(r.volume));
  } catch (e) {
    if (id === reqId[serial]) status(serial, e.message, true);
  } finally {
    pending[serial]--;
  }
}

async function load() {
  try {
    const h = await api('/health');
    if (!h.ready) throw new Error('Not logged in');
    devices = await api('/devices');
    document.dispatchEvent(new Event('devices')); // screens drawn before the list arrived (Moods) fill their Echo pickers
    setConn('ok', 'Connected');
    render();
    if (!stOn) updateTv(); // the Alexa TV panel is hidden when SmartThings is connected
    musicInit();
    alexaInit();
  } catch (e) {
    setConn('bad', e.message);
    $('grid').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// Slider: debounce so dragging sends one command
const timers = {};
$('grid').addEventListener('input', (e) => {
  const m = e.target.closest('.mrow');
  if (m) { // a member Echo's slider inside a group card
    const serial = m.dataset.member, v = +e.target.value;
    m.querySelector('b').textContent = v;
    clearTimeout(timers[serial]);
    timers[serial] = setTimeout(() => { delete timers[serial]; setLevel(serial, v); }, 150);
    return;
  }
  if (e.target.dataset.el !== 'slider') return;
  const serial = e.target.closest('.card').dataset.serial;
  const v = +e.target.value;
  el(serial, 'vol').innerHTML = `${v}<small>/ 10</small>`; el(serial, 'vol').classList.remove('muted');
  clearTimeout(timers[serial]);
  timers[serial] = setTimeout(() => { delete timers[serial]; setLevel(serial, v); }, 150);
});

$('grid').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const serial = b.closest('.card').dataset.serial;
  if (b.dataset.preset) return setLevel(serial, +b.dataset.preset);
  const act = b.dataset.act; if (!act) return;
  if (act === 'up' || act === 'down') return setLevel(serial, (level[serial] ?? 5) + (act === 'up' ? 1 : -1));
  // Mute = volume 0, remembering the level shown; optimistic like the other buttons (Amazon can be slow)
  if (act === 'mute') {
    if (muted[serial] != null) { const to = Math.round((muted[serial] || 40) / 10); delete muted[serial]; setLevel(serial, to); }
    else { muted[serial] = (level[serial] || 4) * 10; setLevel(serial, 0); }
  }
});

$('showAll').onchange = (e) => { showAll = e.target.checked; try { localStorage.setItem('showAll', showAll ? '1' : '0'); } catch {} render(); };
$('refresh').onclick = load;

// TV status = smart home power state (the Alexa built-in TV entry reports offline even when on)
async function updateTv() {
  try {
    const tv = (await api('/tv/state')).find((t) => t.power);
    $('tvDot').className = 'dot ' + (tv?.power === 'ON' ? 'ok' : '');
    $('tvState').textContent = !tv ? 'Unknown' : tv.power === 'ON' ? 'On' : 'Off';
  } catch { $('tvDot').className = 'dot'; $('tvState').textContent = 'Unknown'; }
}
const refreshTv = updateTv;
setInterval(() => { if (!document.hidden && !stOn) refreshTv(); }, 30000);

async function tvSend(path, body, btn) {
  const s = $('tvStatus');
  if (btn) btn.disabled = true;
  s.classList.remove('err'); s.textContent = 'Sending…';
  try { const r = await api('/tv/' + path, body); s.textContent = `Sent "${r.command}" via ${r.via}`; }
  catch (e) { s.textContent = e.message; s.classList.add('err'); }
  finally { if (btn) btn.disabled = false; }
}
document.querySelectorAll('[data-tvcmd]').forEach((b) => b.onclick = () => tvSend(b.dataset.tvcmd, { step: 5 }, b));
$('tvSet').onsubmit = (e) => {
  e.preventDefault();
  const v = $('tvLevel').value;
  if (v === '') return;
  tvSend('volume', { level: Math.max(0, Math.min(100, +v)) }, e.submitter);
};

document.querySelectorAll('[data-tv]').forEach((b) => b.onclick = async () => {
  const s = $('tvStatus');
  b.disabled = true; s.classList.remove('err'); s.textContent = 'Sending…';
  try {
    const r = await api('/tv/' + b.dataset.tv, {});
    s.textContent = `Sent "${r.command}" via ${r.via}`;
    setTimeout(refreshTv, 11000); setTimeout(refreshTv, 25000); // TV takes a few seconds to (dis)connect
  }
  catch (e) { s.textContent = e.message; s.classList.add('err'); }
  finally { b.disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && devices.length) devices.forEach((d) => card(d.serial) && loadVolume(d.serial)); });
// ---------- SmartThings TV (used instead of the Alexa TV panel when connected) ----------
let stOn = false, stMuted = false;
async function stLoad() {
  try {
    const s = await api('/st/auth/status');
    if (!s.connected) return;
    $('stTv').hidden = false; $('alexaTv').hidden = true; stOn = true;
    stRefresh(false, true);
    const apps = await api('/st/tv/apps');
    $('stApps').innerHTML = apps.map((a) => `<button type="button" data-app="${esc(a.name)}">${esc(a.name)}</button>`).join('');
  } catch {}
}
let stBusy = 0, stInputsKey = '', stHoldUntil = 0, stVolume = null;
function stShowVol(v) { stVolume = v; $('stVol').textContent = v; $('stSlider').value = v; }
function stShowMute(m) { stMuted = m; $('stMute').textContent = m ? 'Unmute' : 'Mute'; $('stMute').classList.toggle('primary', m); }
function stShowPower(on, online) {
  $('stTv').classList.toggle('off', !on); // volume/channel/input/apps only work while the TV is on
  // A TV in standby drops off the network, so "offline" just means off
  $('stDot').className = 'dot ' + (on ? 'ok' : '');
  $('stState').textContent = on ? 'On' : 'Off';
}
async function stRefresh(fast, fromTv) {
  try {
    const q = [fast && 'fast=1', fromTv && 'refresh=1'].filter(Boolean).join('&');
    const t = await api('/st/tv' + (q ? '?' + q : ''));
    // A change is in flight or just sent (SmartThings reports the new value a moment later): keep the local value
    if (stBusy || stTimer || Date.now() < stHoldUntil) return;
    $('stName').textContent = t.name || 'TV';
    $('stNow').hidden = !t.nowPlaying;
    if (t.nowPlaying) { $('stNowLabel').textContent = t.nowPlaying.label; $('stNow').title = t.nowPlaying.package || ''; }
    stShowPower(t.power === 'on', t.online);
    if (t.volume != null && document.activeElement !== $('stSlider')) stShowVol(t.volume);
    stShowMute(!!t.muted);
    const sel = $('stInput');
    const opts = [...(t.inputs || [])];
    if (t.input && !opts.some((o) => o.id === t.input)) opts.unshift({ id: t.input, name: t.input });
    const k = JSON.stringify(opts);
    if (k !== stInputsKey) { stInputsKey = k; sel.innerHTML = opts.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join(''); }
    if (t.input && document.activeElement !== sel) sel.value = t.input;
  } catch (e) { stStatus(e.message, true); }
}
function stStatus(t, err) { const s = $('stStatus'); s.textContent = t; s.classList.toggle('err', !!err); }
// Optimistic: the UI changes immediately; the command follows. On error, re-read the real state.
async function stSend(path, body) {
  stBusy++; stStatus('Sending…');
  try {
    await api('/st/tv/' + path, body || {});
    stStatus('Done');
    stHoldUntil = Date.now() + 2500; setTimeout(() => stRefresh(true), 2600);
  } catch (e) {
    stStatus(e.message, true); stHoldUntil = 0; setTimeout(() => stRefresh(true), 0);
  } finally { stBusy--; }
}
// Volume: slider and −/+ taps are coalesced into one "set volume" command
let stTimer = null;
function stQueueVolume(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  stShowVol(v);
  if (v > 0 && stMuted) stShowMute(false);
  clearTimeout(stTimer);
  stTimer = setTimeout(() => { stTimer = null; stSend('volume', { level: v }); }, 250);
}
document.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => {
  const path = b.dataset.st;
  if (path === 'volume/up' || path === 'volume/down') return stQueueVolume((stVolume ?? 0) + (path === 'volume/up' ? 1 : -1));
  if (path === 'mute') { const m = !stMuted; stShowMute(m); return stSend(m ? 'mute' : 'unmute'); }
  if (path === 'power') { const on = b.dataset.on === 'true'; stShowPower(on, true); return stSend('power', { on }); }
  stSend(path);
});
$('stSlider').oninput = (e) => stQueueVolume(+e.target.value);
$('stApps').onclick = (e) => {
  const b = e.target.closest('[data-app]'); if (!b) return;
  stSend('app', { appName: b.dataset.app });
};
document.querySelectorAll('[data-key]').forEach((b) => b.onclick = () => stSend('key', { key: b.dataset.key }));
$('stAppForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('stAppName').value.trim(); if (!v) return;
  stSend('app', /^[\w.]*\d{6,}[\w.]*$/.test(v) ? { appId: v } : { appName: v }); // long numeric = Tizen app ID
};
$('stSlider').onchange = (e) => e.target.blur();
$('stInput').onchange = (e) => { stSend('input', { source: e.target.value }); e.target.blur(); };

// Live updates: every 6s ask the TV to re-report its state (picks up remote-control changes);
// full read (name, online) every 5th time. Also refresh right away when the tab becomes visible.
let stTick = 0;
setInterval(() => { if (stOn && !document.hidden) stRefresh(++stTick % 5 !== 0, true); }, 6000);
document.addEventListener('visibilitychange', () => { if (stOn && !document.hidden) stRefresh(true, true); });

// Echo cards: re-read volumes every 10s (skipped for a card while its slider is being dragged)
setInterval(() => {
  if (document.hidden) return;
  document.querySelectorAll('.card[data-serial]').forEach((c) => {
    const serial = c.dataset.serial;
    if (!timers[serial] && document.activeElement !== el(serial, 'slider')) loadVolume(serial);
  });
}, 10000);

// ---------- Apple Music: browse the catalog, play on any Echo / speaker group ----------
let mType = 'song', mItems = [], mTopLoaded = '', npState = null;
let mReq = 0; // only the latest chart/search request may fill the tiles (a slow chart must not replace results)
const musicTarget = () => $('mDevice').value;
function mStatus(t, err) {
  const s = $('mStatus'); s.textContent = t; s.classList.toggle('err', !!err);
  if (!err && t) setTimeout(() => { if (s.textContent === t) s.textContent = ''; }, 4000);
}

// Echos and speaker groups music / announcements can target
const playable = () => devices.filter((d) => d.online && ['KNIGHT', 'ECHO', 'ROOK', 'WHA'].includes(d.family))
  .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
const deviceOptions = (list) => list.map((d) => `<option value="${esc(d.serial)}">${esc(d.name)}${d.family === 'WHA' ? ' (group)' : ''}</option>`).join('');

let favs = new Set(); // queries of favourite items
async function musicInit() {
  const list = playable();
  $('music').hidden = !list.length;
  if (!list.length) return;
  await uiReady;
  const cur = musicTarget() || uiState.musicDevice;
  $('mDevice').innerHTML = deviceOptions(list);
  if (list.some((d) => d.serial === cur)) $('mDevice').value = cur;
  api('/music/favorites').then((f) => { favs = new Set(f.map((x) => x.query)); markFavs(); }).catch(() => {});
  if (mView === 'top' && mTopLoaded !== mType && !$('mQuery').value.trim()) loadTop();
  fillMove();
  refreshNow();
  loadVolume(musicTarget());
}

// Volume row in the music card: the Echo (or group) the music plays on, same as its own card
$('mVolSlider').oninput = () => {
  const v = +$('mVolSlider').value;
  $('mVolVal').textContent = v;
  clearTimeout(timers.music);
  timers.music = setTimeout(() => { delete timers.music; setLevel(musicTarget(), v); }, 150);
};
document.querySelectorAll('[data-mvol]').forEach((b) => b.onclick = () => {
  const t = musicTarget(); if (!t) return;
  setLevel(t, (level[t] ?? 5) + +b.dataset.mvol);
});
// "Move to": every other Echo / group
function fillMove() {
  const others = playable().filter((d) => d.serial !== musicTarget());
  $('mMove').innerHTML = '<option value="">Choose…</option>' + deviceOptions(others);
}
$('mMove').onchange = async () => {
  const to = $('mMove').value; if (!to) return;
  $('mMove').disabled = true;
  mStatus('Moving the music…');
  try {
    const r = await api('/music/move', { from: musicTarget(), to });
    $('mDevice').value = to;
    mStatus(`Moved “${r.playing}” to ${r.to}`);
    setTimeout(refreshNow, 3000); setTimeout(refreshNow, 8000);
  } catch (e) { mStatus(e.message, true); }
  finally { $('mMove').disabled = false; fillMove(); }
};

function renderTiles(items, label, empty = 'No results.') {
  mItems = items;
  $('mLabel').textContent = label;
  const playingAt = plOpen && plPlaying?.list === plOpen.id ? plPlaying.index : -1;
  $('mTiles').innerHTML = items.length ? items.map((it, i) => `
    <div class="tw${i === playingAt ? ' now' : ''}">
      <button class="tile" data-i="${i}" title="Play ${esc(it.title)}">
        <div class="cover"><span>${it.title[0] ? esc(it.title[0].toUpperCase()) : UI.icon('music')}</span>${it.artwork ? `<img src="${esc(it.artwork)}" alt="" loading="lazy" />` : ''}</div>
        <b>${esc(it.title)}</b><span>${esc(it.subtitle || '')}</span>
      </button>
      <button class="fav" data-i="${i}" aria-label="Favourite ${esc(it.title)}">${UI.icon('star', 'sm')}</button>
      ${plOpen ? `<button class="pladd" data-i="${i}" title="Remove from “${esc(plOpen.name)}”" aria-label="Remove ${esc(it.title)} from the playlist">${UI.icon('close', 'sm')}</button>`
        : it.type === 'song' ? `<button class="pladd" data-i="${i}" title="Add to a playlist" aria-label="Add ${esc(it.title)} to a playlist">${UI.icon('plus', 'sm')}</button>` : ''}
    </div>`).join('') : `<div class="empty">${esc(empty)}</div>`;
  markFavs();
}
function markFavs() {
  const mark = (b, on) => { b.classList.toggle('on', on); b.innerHTML = UI.icon(on ? 'star-fill' : 'star', 'sm'); b.setAttribute('aria-pressed', on); };
  document.querySelectorAll('#mTiles .fav').forEach((b) => mark(b, favs.has(mItems[+b.dataset.i]?.query)));
  mark($('npFav'), !!npItem && favs.has(npItem.query));
}
// Add or remove a favourite; the server keeps the list (ui-state.json in the data folder)
async function toggleFav(it) {
  const on = !favs.has(it.query);
  on ? favs.add(it.query) : favs.delete(it.query);
  markFavs();
  try {
    const list = await api(on ? '/music/favorites' : '/music/favorites/remove', on ? { item: it } : { query: it.query });
    favs = new Set(list.map((x) => x.query));
    if (mView === 'fav') showList('fav'); else markFavs();
    mStatus(on ? `Added “${it.title}” to favourites` : `Removed “${it.title}” from favourites`);
  } catch (err) { mStatus(err.message, true); }
}

// The song playing now as a favourite item: same search phrase the tiles use ("Title by Main Artist")
let npItem = null;
const cleanTitle = (s) => s.replace(/\s*[([](from|feat|ft|with)\b.*?[)\]]/gi, '').trim() || s;
const mainArtist = (s) => (s || '').split(/,|&| feat\.? | x /i)[0].trim();
function nowItem(n) {
  // A podcast: the show (title) can be favourited; the episode is in "artist"
  if (n.title && /podcast/i.test(n.provider || '')) return { type: 'podcast', title: n.title, subtitle: 'Podcast', artwork: n.artwork, query: n.title };
  // Bluetooth audio (no provider) and radio streams have no song to search for
  if (!n.title || !n.artist || !n.provider || /bluetooth|tunein|radio/i.test(n.provider)) return null;
  return { type: 'song', title: n.title, subtitle: n.artist, artwork: n.artwork, query: `${cleanTitle(n.title)} by ${mainArtist(n.artist)}` };
}
$('npFav').onclick = () => npItem && toggleFav(npItem);

// Lists under the search bar: Top (charts), Recent (played from here), Favourites; a search shows its results
let mView = 'top';
function setView(v) {
  mView = v;
  $('mView').querySelectorAll('button').forEach((x) => x.classList.toggle('cur', x.dataset.view === v));
  $('mRefresh').hidden = v !== 'top';
}
// Top: a new mix of songs each time (albums, stations and podcasts are reloaded)
$('mRefresh').onclick = () => { $('mQuery').value = ''; showList('top'); };
async function showList(v) {
  setView(v);
  closePodcast();
  if (v === 'top') return loadTop();
  if (v === 'lists') return showPlaylists();
  const req = ++mReq;
  $('mTiles').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const items = await api(v === 'fav' ? '/music/favorites' : '/music/recent');
    if (req !== mReq) return;
    if (v === 'fav') favs = new Set(items.map((x) => x.query));
    renderTiles(items, v === 'fav' ? `Favourites · ${items.length}` : 'Recently played',
      v === 'fav' ? 'No favourites yet. Tap the star on any song, album or artist.' : 'Nothing played from here yet.');
  } catch (e) { if (req === mReq) mStatus(e.message, true); }
}
$('mView').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) { $('mQuery').value = ''; showList(b.dataset.view); } };

async function loadTop() {
  const radio = mType === 'radio', pod = mType === 'podcast';
  const type = mType === 'album' ? 'album' : 'song'; // no artist chart; show top songs
  const req = ++mReq;
  closePodcast();
  // A refresh keeps the tiles shown (dimmed) until the new ones arrive, so nothing jumps
  if ($('mTiles').querySelector('.tw')) $('mTiles').classList.add('stale');
  else $('mTiles').innerHTML = '<div class="empty">Loading…</div>';
  $('mRefresh').disabled = true; $('mRefresh').classList.add('spin');
  try {
    const items = await api(radio ? `/radio?limit=${$('mLimit').value}` : pod ? `/podcasts/top?limit=${Math.min(100, $('mLimit').value)}` : '/music/top?type=' + type);
    if (req === mReq) { renderTiles(items, radio ? 'Popular stations' : pod ? 'Top podcasts' : type === 'album' ? 'Top albums' : 'Top songs · Hindi, English, Punjabi, Urdu'); mTopLoaded = mType; }
  } catch (e) { if (req === mReq) { renderTiles([], 'Search to find music'); mStatus(e.message, true); } }
  finally { if (req === mReq) { $('mRefresh').disabled = false; $('mRefresh').classList.remove('spin'); $('mTiles').classList.remove('stale'); } }
}

async function search() {
  const q = $('mQuery').value.trim();
  if (!q) return showList(mView === 'search' ? 'top' : mView);
  setView('search');
  mStatus('Searching…');
  $('mTiles').innerHTML = '<div class="empty">Searching…</div>';
  const radio = mType === 'radio', pod = mType === 'podcast';
  const sort = ['artist', 'radio', 'podcast'].includes(mType) ? '' : $('mSort').value; // these have no release date
  const req = ++mReq;
  closePodcast();
  try {
    const items = await api(radio ? `/radio?limit=${$('mLimit').value}&q=${encodeURIComponent(q)}`
      : pod ? `/podcasts/search?limit=${$('mLimit').value}&q=${encodeURIComponent(q)}`
      : `/music/search?type=${mType}&limit=${$('mLimit').value}&sort=${sort}&q=${encodeURIComponent(q)}`);
    if (req !== mReq) return;
    renderTiles(items, `${radio ? 'Stations' : pod ? 'Podcasts' : 'Results'} for “${q}” · ${items.length}${sort ? (sort === 'newest' ? ' · newest first' : ' · oldest first') : ''}`);
    mStatus('');
  } catch (e) { if (req === mReq) mStatus(e.message, true); }
}
// Sort and count are remembered; changing either re-runs the current search
for (const id of ['mSort', 'mLimit']) {
  try { const v = localStorage.getItem(id); if (v != null && [...$(id).options].some((o) => o.value === v)) $(id).value = v; } catch {}
  $(id).onchange = () => {
    try { localStorage.setItem(id, $(id).value); } catch {}
    if ($('mQuery').value.trim()) search();
    else if (id === 'mLimit' && mType === 'radio' && mView === 'top') loadTop(); // popular stations list
  };
}
const syncSort = () => {
  $('mSort').disabled = ['artist', 'radio', 'podcast'].includes(mType);
  $('radioNote').hidden = mType !== 'radio';
  $('mQuery').placeholder = { radio: 'Search radio stations…', podcast: 'Search podcasts…' }[mType] || 'Search songs, albums, artists…';
};
$('mForm').onsubmit = (e) => { e.preventDefault(); search(); };
$('mType').onclick = (e) => {
  const b = e.target.closest('[data-type]'); if (!b) return;
  mType = b.dataset.type;
  $('mType').querySelectorAll('button').forEach((x) => x.classList.toggle('cur', x === b));
  syncSort();
  if ($('mQuery').value.trim() || mView === 'top') search();
};
$('mDevice').onchange = () => { fillMove(); refreshNow(); loadVolume(musicTarget()); }; // the server remembers the Echo from this request

$('mTiles').onclick = async (e) => {
  const f = e.target.closest('.fav');
  if (f) return toggleFav(mItems[+f.dataset.i]);
  const a = e.target.closest('.pladd');
  if (a) return plOpen ? removeFromPlaylist(mItems[+a.dataset.i]) : openAddMenu(a, mItems[+a.dataset.i]);
  const t = e.target.closest('.tile'); if (!t) return;
  if (t.dataset.pl) return openPlaylist(t.dataset.pl);
  if (plOpen) return playPlaylist(plOpen, +t.dataset.i, t);
  const it = mItems[+t.dataset.i];
  if (it.type === 'podcast') return it.id ? openPodcast(it) : playPodcast(it, true);
  t.classList.add('busy');
  mStatus(`Starting “${it.title}”…`);
  try {
    // Songs shown after this one keep playing when it ends
    const queue = it.type === 'song' ? mItems.slice(+t.dataset.i + 1).concat(mItems.slice(0, +t.dataset.i)).filter((x) => x.type === 'song') : undefined;
    const r = await api('/music/play', { device: musicTarget(), query: it.query, item: it, queue });
    mStatus(`Playing on ${r.device}`);
    setTimeout(refreshNow, 2500); setTimeout(refreshNow, 6000);
  } catch (err) { mStatus(err.message, true); }
  finally { t.classList.remove('busy'); }
};

// ---------- Playlists: named lists of songs kept here (ui-state.json), played one after another ----------
// The server starts each song and moves on to the next once the Echo goes to another track or stops.
let plOpen = null, plPlaying = null; // the playlist shown (with its songs); which playlist is playing, and where
const songs = (n) => `${n} song${n === 1 ? '' : 's'}`;
async function showPlaylists() {
  const req = ++mReq;
  $('mTiles').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { lists, playing } = await api('/music/playlists');
    if (req !== mReq) return;
    plPlaying = playing;
    mItems = [];
    $('mLabel').textContent = `Playlists · ${lists.length}`;
    $('plPanel').hidden = false;
    $('plPanel').innerHTML = `<form class="plnew" id="plNew"><input class="plinput" maxlength="60" placeholder="New playlist name" aria-label="New playlist name" />
      <button type="submit" class="go">Create</button></form>`;
    $('mTiles').innerHTML = lists.length ? lists.map((l) => `
      <div class="tw${playing?.list === l.id ? ' now' : ''}">
        <button class="tile" data-pl="${esc(l.id)}" title="Open ${esc(l.name)}">
          <div class="cover"><span>${l.name[0] ? esc(l.name[0].toUpperCase()) : UI.icon('music')}</span>${l.artwork ? `<img src="${esc(l.artwork)}" alt="" loading="lazy" />` : ''}</div>
          <b>${esc(l.name)}</b><span>${songs(l.count)}${playing?.list === l.id ? ` · playing on ${esc(playing.device || '')}` : ''}</span>
        </button>
      </div>`).join('') : '<div class="empty">No playlists yet. Create one above, then tap + on any song.</div>';
  } catch (e) { if (req === mReq) mStatus(e.message, true); }
}
async function createPlaylist(name) {
  const r = await api('/music/playlists', { name });
  mStatus(`Created “${name.trim()}”`);
  return r.created;
}
async function openPlaylist(id) {
  const req = ++mReq;
  try {
    const l = await api(`/music/playlists/${encodeURIComponent(id)}`);
    if (req !== mReq) return;
    setView('lists');
    plOpen = l; plPlaying = l.playing;
    drawPlaylistHead();
    renderTiles(l.items, `${l.name} · ${songs(l.items.length)}`, 'No songs yet. Tap + on any song (or on the song playing now) to add it here.');
  } catch (e) { mStatus(e.message, true); showList('lists'); }
}
function drawPlaylistHead() {
  const l = plOpen, on = plPlaying?.list === l.id;
  $('plPanel').hidden = false;
  $('plPanel').innerHTML = `
    <button type="button" class="back" data-pl="back">← All playlists</button>
    <div class="podbtns plbtns">
      <button type="button" class="go" data-pl="play" ${l.items.length ? '' : 'disabled'}>${UI.icon('play', 'sm')}Play all</button>
      ${on ? `<button type="button" data-pl="stop">${UI.icon('stop', 'sm')}Stop after this song</button>` : ''}
      <button type="button" data-pl="rename">Rename</button>
      <button type="button" data-pl="delete">Delete</button>
      <label class="kind" title="Fade the song out at its end and the next one in (one Echo plays one song at a time, so they don't overlap)">Crossfade
        <select id="plFade" aria-label="Crossfade between songs">${[[0, 'Off'], [5, '5 s'], [10, '10 s'], [15, '15 s']]
          .map(([v, t]) => `<option value="${v}"${v === (l.crossfade || 0) ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>
    <p class="kind">${on ? `Playing song ${plPlaying.index + 1} of ${l.items.length} on ${esc(plPlaying.device || '')}. Next and Previous move through the playlist.`
      : 'Songs play in order. Tap a song to start from there.'}</p>`;
}
async function playPlaylist(l, index, tile) {
  tile?.classList.add('busy');
  mStatus(`Starting “${l.name}”…`);
  try {
    const r = await api(`/music/playlists/${encodeURIComponent(l.id)}/play`, { device: musicTarget(), index });
    plPlaying = r.playlist;
    mStatus(`Playing “${r.playing}” on ${r.device}`);
    if (plOpen?.id === l.id) { drawPlaylistHead(); renderTiles(plOpen.items, $('mLabel').textContent); }
    setTimeout(refreshNow, 2500); setTimeout(refreshNow, 6000);
  } catch (e) { mStatus(e.message, true); }
  finally { tile?.classList.remove('busy'); }
}
async function removeFromPlaylist(it) {
  try {
    const l = await api(`/music/playlists/${encodeURIComponent(plOpen.id)}/remove`, { query: it.query });
    plOpen = l; plPlaying = l.playing;
    drawPlaylistHead();
    renderTiles(l.items, `${l.name} · ${songs(l.items.length)}`, 'No songs yet. Tap + on any song to add it here.');
    mStatus(`Removed “${it.title}”`);
  } catch (e) { mStatus(e.message, true); }
}
// While a playlist is open, follow the server moving through it (checked with each now-playing refresh)
async function checkPlaylistNow() {
  try {
    const { playing } = await api('/music/playlists');
    if (!plOpen || JSON.stringify(playing) === JSON.stringify(plPlaying)) return;
    plPlaying = playing;
    drawPlaylistHead();
    renderTiles(plOpen.items, $('mLabel').textContent);
  } catch {}
}
$('plPanel').onclick = async (e) => {
  const b = e.target.closest('[data-pl]'); if (!b) return;
  const l = plOpen, act = b.dataset.pl;
  if (act === 'back') { closePodcast(); return showList('lists'); }
  if (act === 'play') return playPlaylist(l, 0);
  if (act === 'stop') {
    await api('/music/playlists-stop', {}).catch(() => {});
    plPlaying = null; drawPlaylistHead(); renderTiles(l.items, $('mLabel').textContent);
    return mStatus('The playlist stops after this song');
  }
  if (act === 'rename') {
    b.outerHTML = `<form id="plRename" class="plnew flush"><input class="plinput" maxlength="60" value="${esc(l.name)}" aria-label="Playlist name" /><button type="submit" class="go">Save</button></form>`;
    const inp = $('plRename').querySelector('input'); inp.focus(); inp.select();
    return;
  }
  if (act === 'delete') {
    if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap again to delete'; return; }
    try { await api(`/music/playlists/${encodeURIComponent(l.id)}/delete`, {}); mStatus(`Deleted “${l.name}”`); closePodcast(); showList('lists'); }
    catch (err) { mStatus(err.message, true); }
  }
};
$('plPanel').onchange = async (e) => {
  if (e.target.id !== 'plFade') return;
  try {
    const { seconds } = await api('/music/crossfade', { seconds: Number(e.target.value) });
    plOpen.crossfade = seconds;
    mStatus(seconds ? `Crossfade: ${seconds} s between songs` : 'Crossfade off');
  } catch (err) { mStatus(err.message, true); }
};
$('plPanel').onsubmit = async (e) => {
  e.preventDefault();
  const name = e.target.querySelector('input').value.trim(); if (!name) return;
  try {
    if (e.target.id === 'plNew') return openPlaylist(await createPlaylist(name));
    if (e.target.id === 'plRename') {
      await api(`/music/playlists/${encodeURIComponent(plOpen.id)}/rename`, { name });
      plOpen.name = name; drawPlaylistHead(); $('mLabel').textContent = `${name} · ${songs(plOpen.items.length)}`;
    }
  } catch (err) { mStatus(err.message, true); }
};

// + on a song: pick a playlist (or make a new one) to add it to
let plAdd = null;
async function openAddMenu(anchor, it) {
  plAdd = it;
  const m = $('plMenu');
  m.innerHTML = '<div class="plt">Loading…</div>';
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(innerWidth - 248, r.left)) + 'px';
  m.style.top = (r.bottom + 350 > innerHeight ? Math.max(8, r.top - 346) : r.bottom + 6) + 'px';
  try {
    const { lists } = await api('/music/playlists');
    if (plAdd !== it) return;
    m.innerHTML = `<div class="plt">Add “${esc(it.title)}” to</div>
      ${lists.map((l) => `<button type="button" class="pli" data-id="${esc(l.id)}"><b>${esc(l.name)}</b><span>${l.count}</span></button>`).join('')}
      <form><input maxlength="60" placeholder="New playlist" aria-label="New playlist name" /><button type="submit">Add</button></form>`;
    if (!lists.length) m.querySelector('input').focus();
  } catch (e) { m.innerHTML = `<div class="plt">${esc(e.message)}</div>`; }
}
const closeAddMenu = () => { plAdd = null; $('plMenu').hidden = true; };
async function addToPlaylist(id) {
  const it = plAdd; closeAddMenu();
  try {
    const r = await api(`/music/playlists/${encodeURIComponent(id)}/add`, { item: it });
    mStatus(r.added ? `Added “${it.title}” to “${r.name}”` : `“${it.title}” is already in “${r.name}”`);
  } catch (e) { mStatus(e.message, true); }
}
$('plMenu').onclick = (e) => { const b = e.target.closest('.pli'); if (b) addToPlaylist(b.dataset.id); };
$('plMenu').onsubmit = async (e) => {
  e.preventDefault();
  const name = e.target.querySelector('input').value.trim(); if (!name) return;
  try { addToPlaylist(await createPlaylist(name)); } catch (err) { mStatus(err.message, true); }
};
document.addEventListener('click', (e) => {
  if (!$('plMenu').hidden && !e.target.closest('#plMenu, .pladd, #npPl')) closeAddMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('plMenu').hidden) closeAddMenu(); });
$('npPl').onclick = () => npItem && openAddMenu($('npPl'), npItem);

// ---------- Podcasts: a show's page with its episodes ----------
// Alexa plays a show or its latest episode, not older episodes by name; Previous goes back one episode.
let podItem = null;
function closePodcast() { podItem = null; $('podPanel').hidden = true; $('mTiles').hidden = false; plOpen = null; $('plPanel').hidden = true; }
async function openPodcast(it) {
  podItem = it;
  $('mTiles').hidden = true;
  $('podPanel').hidden = false;
  $('podPanel').innerHTML = '<div class="empty">Loading episodes…</div>';
  try {
    const { podcast, episodes } = await api(`/podcasts/${encodeURIComponent(it.id)}/episodes`);
    if (podItem !== it) return;
    const show = { ...it, title: podcast.title || it.title, artwork: podcast.artwork || it.artwork };
    const date = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
    $('podPanel').innerHTML = `
      <button type="button" class="back" data-pod="back">← Back</button>
      <div class="podhead">
        ${show.artwork ? `<img src="${esc(show.artwork)}" alt="" />` : ''}
        <div><b>${esc(show.title)}</b><span>${esc(podcast.subtitle || it.subtitle || '')}</span>
          <div class="podbtns">
            <button type="button" class="go" data-pod="latest">${UI.icon('play', 'sm')}Latest episode</button>
            <button type="button" data-pod="show" title="Alexa usually continues where you left off">${UI.icon('play', 'sm')}Play show</button>
            <button type="button" data-pod="fav" class="podfav">${UI.icon(favs.has(show.query) ? 'star-fill' : 'star', 'sm')}Favourite</button>
          </div></div></div>
      <p class="kind">Alexa plays the show or its latest episode. For an older episode, start the latest and use Previous to go back.</p>
      <ol class="episodes">${episodes.map((ep, i) => `<li><b>${esc(ep.title)}</b>
        <span>${i === 0 ? 'Latest · ' : ''}${esc(date(ep.released))}${ep.minutes ? ` · ${ep.minutes} min` : ''}</span>
        ${ep.summary ? `<small>${esc(ep.summary)}</small>` : ''}</li>`).join('') || '<li class="empty small">No episodes listed.</li>'}</ol>`;
    $('podPanel').dataset.show = JSON.stringify(show);
  } catch (e) { $('podPanel').innerHTML = `<button type="button" class="back" data-pod="back">← Back</button><div class="empty">${esc(e.message)}</div>`; }
}
async function playPodcast(it, latest) {
  mStatus(`Asking Alexa for “${it.title}”…`);
  try {
    const r = await api('/podcasts/play', { device: musicTarget(), podcast: it.query || it.title, latest, item: it });
    mStatus(`Playing on ${r.device}`);
    setTimeout(refreshNow, 3000); setTimeout(refreshNow, 7000);
  } catch (e) { mStatus(e.message, true); }
}
$('podPanel').onclick = async (e) => {
  const b = e.target.closest('[data-pod]'); if (!b) return;
  if (b.dataset.pod === 'back') return closePodcast();
  const show = JSON.parse($('podPanel').dataset.show || 'null') || podItem;
  if (b.dataset.pod === 'fav') { await toggleFav(show); b.innerHTML = `${UI.icon(favs.has(show.query) ? 'star-fill' : 'star', 'sm')}Favourite`; return; }
  b.disabled = true;
  await playPodcast(show, b.dataset.pod === 'latest');
  b.disabled = false;
};

// ---------- Surprise me: a fresh mix of popular Hindi songs, or of podcasts to learn from ----------
// The server picks it, plays one after another and keeps adding more; Next skips to the next pick.
// Tapping the playing one again starts a new mix.
let surpriseOn = null;
function markSurprise(kind) {
  surpriseOn = kind || null;
  document.querySelectorAll('[data-surprise]').forEach((b) => {
    const on = b.dataset.surprise === surpriseOn, small = b.querySelector('small');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    if (!b.classList.contains('busy')) small.textContent = on ? 'Playing · Next skips · tap for a new mix' : small.dataset.idle;
  });
}
$('surprise').onclick = async (e) => {
  const b = e.target.closest('[data-surprise]'); if (!b || b.classList.contains('busy')) return;
  const kind = b.dataset.surprise, small = b.querySelector('small');
  b.classList.add('busy');
  small.textContent = kind === 'song' ? 'Picking Hindi songs…' : 'Picking podcasts…';
  try {
    const r = await api('/music/surprise', { device: musicTarget(), kind });
    mStatus(kind === 'song' ? `Surprise: “${r.playing}” on ${r.device}` : `Surprise: the latest “${r.playing}” on ${r.device}`);
    b.classList.remove('busy');
    markSurprise(kind);
    setTimeout(refreshNow, 3000); setTimeout(refreshNow, 8000);
  } catch (err) { b.classList.remove('busy'); markSurprise(surpriseOn); mStatus(err.message, true); }
};

// Progress: the Echo reports position on each poll (every 5s); move the bar in between
let np = { pos: null, len: null, at: 0, playing: false }, sleepAt = null;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function drawProgress() {
  const ok = np.len > 0 && np.pos != null;
  $('npProg').hidden = !ok;
  if (ok) {
    const pos = Math.min(np.len, np.pos + (np.playing ? (Date.now() - np.at) / 1000 : 0));
    $('npPos').textContent = fmt(pos); $('npLen').textContent = fmt(np.len);
    $('npBar').style.width = (pos / np.len) * 100 + '%';
  }
  const left = sleepAt ? Math.ceil((sleepAt - Date.now()) / 60000) : 0;
  $('sleepLeft').textContent = left > 0 ? `${left} min left` : '';
  if (left <= 0 && $('mSleep').value !== '0' && document.activeElement !== $('mSleep')) $('mSleep').value = '0';
}
setInterval(drawProgress, 1000);

function showNow(n) {
  npState = n.state;
  const idle = !n.title;
  $('npTitle').textContent = idle ? 'Nothing playing' : n.title;
  $('npSub').textContent = idle ? '' : [n.artist, n.provider].filter(Boolean).join(' · ');
  $('npArt').hidden = !n.artwork; $('npPh').hidden = !!n.artwork;
  if (n.artwork && $('npArt').src !== n.artwork) $('npArt').src = n.artwork;
  $('npToggle').innerHTML = UI.icon(n.state === 'PLAYING' ? 'pause' : 'play');
  np = { pos: n.position, len: n.length, at: Date.now(), playing: n.state === 'PLAYING' };
  sleepAt = n.sleepAt;
  drawProgress();
  npItem = nowItem(n);
  $('npFav').hidden = !npItem;
  $('npPl').hidden = npItem?.type !== 'song';
  markFavs();
  markSurprise(n.surprise);
  if (plOpen) checkPlaylistNow();
  // Shuffle / repeat only where the music source offers them (Apple Music and TuneIn on Alexa don't)
  for (const m of ['shuffle', 'repeat']) {
    const b = document.querySelector(`[data-mcmd="${m}"]`);
    b.hidden = n[m] == null; b.classList.toggle('on', !!n[m]);
  }
  refreshQueue(n);
}

// "Up next": only some sources list what plays next (not Apple Music or TuneIn on Alexa)
let queueKey = '';
async function refreshQueue(n) {
  const k = `${musicTarget()}|${n.title}|${n.provider}`;
  if (k === queueKey) return;
  queueKey = k;
  if (!n.title || !n.provider || /apple music|tunein|bluetooth/i.test(n.provider)) { $('mQueue').hidden = true; return; }
  try {
    const q = await api('/music/queue?device=' + encodeURIComponent(musicTarget()));
    $('mQueueList').innerHTML = q.map((m) => `<button type="button" data-qid="${esc(m.id || '')}">
      <b>${esc(m.title)}</b><span>${esc(m.artist)}</span></button>`).join('');
    $('mQueue').hidden = q.length < 2; // a one-item queue is just what's playing (podcasts report that)
  } catch { $('mQueue').hidden = true; }
}
$('mQueueList').onclick = async (e) => {
  const b = e.target.closest('[data-qid]'); if (!b?.dataset.qid) return;
  try { await api('/music/jump', { device: musicTarget(), id: b.dataset.qid }); queueKey = ''; setTimeout(refreshNow, 1500); }
  catch (err) { mStatus(err.message, true); }
};
$('mSleep').onchange = async () => {
  const minutes = +$('mSleep').value;
  try {
    const r = await api('/music/sleep', { device: musicTarget(), minutes });
    sleepAt = r.sleepAt; drawProgress();
    mStatus(minutes ? `${r.device} will pause in ${minutes} min` : 'Sleep timer off');
  } catch (e) { mStatus(e.message, true); }
  $('mSleep').blur();
};
async function refreshNow() {
  if (!musicTarget()) return;
  try { showNow(await api('/music/now?device=' + encodeURIComponent(musicTarget()))); } catch {}
}
document.querySelectorAll('[data-mcmd]').forEach((b) => b.onclick = async () => {
  let cmd = b.dataset.mcmd;
  if (cmd === 'shuffle' || cmd === 'repeat') {
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    try { await api('/music/' + cmd, { device: musicTarget(), on }); setTimeout(refreshNow, 1500); }
    catch (e) { b.classList.toggle('on', !on); mStatus(e.message, true); }
    return;
  }
  if (cmd === 'toggle') { cmd = npState === 'PLAYING' ? 'pause' : 'play'; $('npToggle').innerHTML = UI.icon(cmd === 'pause' ? 'play' : 'pause'); npState = cmd === 'pause' ? 'PAUSED' : 'PLAYING'; }
  try { await api('/music/' + cmd, { device: musicTarget() }); setTimeout(refreshNow, 1500); }
  catch (e) { mStatus(e.message, true); refreshNow(); }
});
// Seek presses add up: tap +10 five times and one 50s skip is sent shortly after the last tap
let seekTotal = 0, seekTimer = null;
const seekText = (s) => { const a = Math.abs(s), m = Math.floor(a / 60), r = a % 60; return m ? `${m} min${r ? ` ${r}s` : ''}` : `${r}s`; };
document.querySelectorAll('[data-seek]').forEach((b) => b.onclick = () => {
  seekTotal = Math.max(-600, Math.min(600, seekTotal + +b.dataset.seek));
  clearTimeout(seekTimer);
  const badge = $('seekBadge');
  if (!seekTotal) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = `${seekTotal > 0 ? '+' : '−'}${seekText(seekTotal)}`;
  seekTimer = setTimeout(async () => {
    const s = seekTotal; seekTotal = 0;
    badge.textContent = `${s > 0 ? 'Skipping' : 'Going back'} ${seekText(s)}…`;
    try { await api('/music/seek', { device: musicTarget(), seconds: s }); mStatus(s > 0 ? `Skipped forward ${seekText(s)}` : `Went back ${seekText(s)}`); setTimeout(refreshNow, 1500); }
    catch (e) { mStatus(e.message, true); }
    finally { if (!seekTotal) setTimeout(() => { if (!seekTotal) badge.hidden = true; }, 1200); }
  }, 900);
});
setInterval(() => { if (!document.hidden && !$('music').hidden) refreshNow(); }, 5000);

// ---------- Alexa: announcements and routines ----------
function aStatus(t, err) {
  const s = $('aStatus'); s.textContent = t; s.classList.toggle('err', !!err);
  if (!err && t) setTimeout(() => { if (s.textContent === t) s.textContent = ''; }, 5000);
}
let routinesLoaded = false;
function alexaInit() {
  const list = playable();
  $('alexaCard').hidden = !list.length;
  if (!list.length) return;
  const cur = $('annDevice').value || 'all';
  $('annDevice').innerHTML = '<option value="all">All Echos</option>' + deviceOptions(list);
  if ([...$('annDevice').options].some((o) => o.value === cur)) $('annDevice').value = cur;
  if (!routinesLoaded) loadRoutines();
}
async function loadRoutines() {
  try {
    const list = await api('/routines');
    routinesLoaded = true;
    $('routines').innerHTML = list.length
      ? list.map((r) => `<button type="button" data-rid="${esc(r.id)}">${esc(r.name)}</button>`).join('')
      : '<span class="kind">No routines in the Alexa app yet.</span>';
  } catch (e) { $('routines').innerHTML = `<span class="kind">${esc(e.message)}</span>`; }
}
$('annForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('annText').value.trim(); if (!text) return;
  const btn = e.submitter; if (btn) btn.disabled = true;
  aStatus('Sending…');
  try {
    const r = await api('/announce', { text, device: $('annDevice').value, mode: $('annMode').value, sound: $('annSound').value });
    aStatus(`${r.mode === 'speak' ? 'Said' : 'Announced'} on ${r.devices.join(', ')}`);
    $('annText').value = '';
  } catch (err) { aStatus(err.message, true); }
  finally { if (btn) btn.disabled = false; }
};
$('routines').onclick = async (e) => {
  const b = e.target.closest('[data-rid]'); if (!b) return;
  b.disabled = true;
  aStatus(`Running “${b.textContent}”…`);
  try {
    const dev = $('annDevice').value;
    const r = await api('/routines/run', { id: b.dataset.rid, device: dev === 'all' ? undefined : dev });
    aStatus(`Ran “${r.ran}” on ${r.via}`);
  } catch (err) { aStatus(err.message, true); }
  finally { b.disabled = false; }
};

load();
stLoad();
