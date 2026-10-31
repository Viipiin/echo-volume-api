// Setup / uninstall wizard. Talks to the main process only through window.setup (preload.js).
'use strict';
const $ = (id) => document.getElementById(id);
const api = window.setup;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let state = null, opts = null, current = null;

// ---------- screens ----------
function show(id, focusId) {
  const next = $(id);
  if (current === next) return;
  if (current) { current.classList.remove('active'); current.inert = true; }
  next.inert = false;
  next.classList.add('active');
  current = next;
  // Focus the main action (or the heading) once the screen is in
  setTimeout(() => (focusId ? $(focusId) : next.querySelector('h1, h2'))?.focus({ preventScroll: true }), reduced ? 0 : 120);
}
const scopeText = (s) => (s === 'machine' ? 'for everyone on this PC' : 'for you only');
// A button's text, with the admin shield in front when it will ask for administrator rights (DOM only, no HTML strings)
function setLabel(b, label, admin) {
  b.textContent = '';
  if (admin) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#i-shield');
    svg.append(use); b.append(svg, ' ');
  }
  b.append(label);
}
function button(label, cls, onClick, { admin = false, id } = {}) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = `btn ${cls}`; if (id) b.id = id;
  setLabel(b, label, admin);
  b.onclick = onClick;
  return b;
}
const needsAdmin = (o) => o.scope === 'machine' && !state.elevated;

// ---------- welcome ----------
function renderWelcome() {
  $('w-version').textContent = `Version ${state.version}`;
  const acts = $('w-actions'); acts.textContent = '';
  const ex = state.existing;
  opts = {
    action: 'install', scope: ex ? ex.scope : 'user', dir: ex ? ex.dir : state.defaults.user,
    desktop: true, startMenu: true, startup: false, launch: true,
  };
  if (!ex) {
    acts.append(button('Install', 'primary', () => start(), { id: 'w-go' }), button('Customize', 'ghost', openCustomize));
    $('w-fine').textContent = `Installs ${scopeText('user')} · about ${state.sizeMb} MB · no admin rights needed`;
  } else {
    $('w-existing').hidden = false;
    $('w-ex-title').textContent = `Echo Volume ${ex.version} is installed`;
    $('w-ex-sub').textContent = `${scopeText(ex.scope)[0].toUpperCase()}${scopeText(ex.scope).slice(1)} · ${ex.dir}`;
    const label = state.compare > 0 ? `Upgrade to ${state.version}` : state.compare === 0 ? 'Repair' : `Reinstall ${state.version}`;
    acts.append(
      button(label, 'primary', () => start(), { admin: needsAdmin(opts), id: 'w-go' }),
      button('Options', 'ghost', openCustomize),
      button('Uninstall', 'ghost', async () => { await api.uninstallExisting(); }),
    );
    $('w-fine').textContent = state.compare < 0 ? `A newer version is installed; this puts ${state.version} back.`
      : ex.kind === 'legacy' ? 'The old version is removed first. Your sign-in, playlists and settings are kept.'
        : 'Your sign-in, playlists and settings are kept.';
  }
  show('s-welcome', 'w-go');
}

// ---------- customize ----------
function openCustomize() {
  const ex = state.existing;
  document.querySelectorAll('input[name=scope]').forEach((r) => { r.checked = r.value === opts.scope; r.disabled = !!ex; });
  $('c-dir').value = opts.dir; $('c-browse').disabled = !!ex;
  $('c-dir-hint').textContent = ex ? 'An existing install is replaced where it is.' : `About ${state.sizeMb} MB`;
  $('c-desktop').checked = opts.desktop; $('c-start').checked = opts.startMenu; $('c-startup').checked = opts.startup; $('c-launch').checked = opts.launch;
  $('c-err').textContent = '';
  syncGo();
  show('s-custom', 'c-go');
}
function readCustomize() {
  opts.scope = document.querySelector('input[name=scope]:checked').value;
  opts.dir = $('c-dir').value;
  opts.desktop = $('c-desktop').checked; opts.startMenu = $('c-start').checked; opts.startup = $('c-startup').checked; opts.launch = $('c-launch').checked;
}
function syncGo() {
  readCustomize();
  setLabel($('c-go'), state.existing ? (state.compare > 0 ? 'Upgrade' : state.compare === 0 ? 'Repair' : 'Reinstall') : 'Install', needsAdmin(opts));
}
document.querySelectorAll('input[name=scope]').forEach((r) => r.addEventListener('change', () => {
  // The default folder follows the scope, unless one was picked
  if ($('c-dir').value === state.defaults.user || $('c-dir').value === state.defaults.machine) $('c-dir').value = state.defaults[r.value];
  syncGo();
}));
$('c-browse').onclick = async () => {
  try { const d = await api.chooseFolder($('c-dir').value); if (d) { $('c-dir').value = d; $('c-err').textContent = ''; } } catch (e) { $('c-err').textContent = clean(e); }
};
$('c-back').onclick = () => show('s-welcome', 'w-go');
$('c-form').onsubmit = (e) => { e.preventDefault(); readCustomize(); start(); };

// ---------- install ----------
async function start() {
  if (needsAdmin(opts)) {
    const go = current.querySelector('.btn.primary');
    const was = [...go.childNodes]; go.disabled = true; go.textContent = 'Waiting for approval…';
    let ok = false;
    try { ok = await api.elevate(opts); } catch (e) { $('c-err').textContent = clean(e); }
    if (!ok) { go.disabled = false; go.replaceChildren(...was); if (current.id === 's-welcome') $('w-fine').textContent = 'Administrator approval is needed to install for everyone on this PC.'; }
    return; // the elevated copy takes over
  }
  $('p-title').textContent = state.existing ? (state.compare > 0 ? 'Upgrading Echo Volume' : 'Repairing Echo Volume') : 'Installing Echo Volume';
  resetProgress();
  show('s-progress');
  const r = await api.install(opts).catch((e) => ({ ok: false, error: clean(e) }));
  $('p-confirm').hidden = true;
  if (r.ok) return finished();
  showError(r);
}
function showError(r) {
  $('e-title').textContent = r.cancelled ? 'Installation cancelled' : r.code === 'DISK_SPACE' ? 'Not enough disk space' : 'Something went wrong';
  $('e-text').textContent = r.cancelled ? 'Nothing was installed.' : r.error || 'The installation did not finish.';
  $('e-sub').textContent = r.cancelled ? '' : 'Nothing was left half-installed: every change was undone.';
  $('e-retry').textContent = r.cancelled ? 'Start again' : 'Retry';
  show('s-error', 'e-retry');
}
$('e-retry').onclick = () => (state.existing || opts.dir !== state.defaults.user ? start() : renderWelcome());
$('e-log').onclick = () => api.openLog();
$('e-close').onclick = () => api.close();

// Progress: the ring and bar ease toward the real value (no fake movement)
const CIRC = 364.42;
let target = 0, shown = 0, raf = 0, lastT = 0;
function resetProgress() { target = shown = 0; paint(); $('p-status').textContent = 'Getting ready…'; $('p-detail').textContent = ' '; $('p-cancel').disabled = false; $('p-ring').classList.remove('spin'); }
function paint() {
  $('p-bar').style.setProperty('stroke-dashoffset', String(CIRC * (1 - shown)));
  $('p-line').style.setProperty('width', `${(shown * 100).toFixed(2)}%`);
  $('p-pct').textContent = String(Math.floor(shown * 100));
}
function tick(t) {
  const dt = Math.min(64, t - (lastT || t)); lastT = t;
  shown += (target - shown) * (reduced ? 1 : 1 - Math.exp(-dt / 140));
  if (Math.abs(target - shown) < 0.0005) shown = target;
  paint();
  raf = shown !== target ? requestAnimationFrame(tick) : 0;
}
const mb = (b) => (b / 1048576).toFixed(1);
let lastStatus = '';
api.onProgress((p) => {
  if (p.phase === 'ask-cancel') return askCancel();
  if (p.phase === 'uninstall') return uninstallProgress(p);
  if (p.text && p.text !== lastStatus) { $('p-status').textContent = p.text; lastStatus = p.text; }
  $('p-ring').classList.toggle('spin', p.percent == null);
  if (p.percent != null) { target = p.percent; if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); } }
  $('p-detail').textContent = p.bytes != null ? `${mb(p.bytes)} MB of ${mb(p.total)} MB · ${p.file || ''}` : ' ';
  $('p-cancel').disabled = p.cancellable === false;
  if (p.cancellable === false) $('p-confirm').hidden = true;
});
function askCancel() {
  if (current?.id !== 's-progress' || $('p-cancel').disabled) return;
  $('p-confirm').hidden = false; $('p-keep').focus();
}
$('p-cancel').onclick = askCancel;
$('p-keep').onclick = () => { $('p-confirm').hidden = true; $('p-cancel').focus(); };
$('p-stop').onclick = async () => { $('p-confirm').hidden = true; $('p-cancel').disabled = true; await api.cancel(); };

// ---------- done ----------
let autoTimer = 0;
function finished() {
  target = 1; shown = 1; paint();
  const verb = state.existing ? (state.compare > 0 ? 'updated' : 'repaired') : 'ready';
  $('d-title').textContent = verb === 'ready' ? 'Echo Volume is ready' : `Echo Volume ${state.version} is ${verb}`;
  show('s-done', 'd-launch');
  confetti();
  if (opts.launch) { // open it by itself after a moment, unless the person does something first
    let n = 4;
    const step = () => {
      if (--n <= 0) return api.launchApp();
      $('d-auto').textContent = `Opening Echo Volume in ${n}… `;
      const stay = document.createElement('button'); stay.className = 'link'; stay.type = 'button'; stay.textContent = 'Stay here';
      stay.onclick = stopAuto; $('d-auto').append(stay);
      autoTimer = setTimeout(step, 1000);
    };
    autoTimer = setTimeout(step, 600);
  }
}
function stopAuto() { clearTimeout(autoTimer); autoTimer = 0; $('d-auto').textContent = ''; $('d-launch').focus(); }
$('d-launch').onclick = () => { stopAuto(); api.launchApp(); };
$('d-close').onclick = () => { stopAuto(); api.close(); };

function confetti() {
  if (reduced) return;
  const c = $('confetti'), ctx = c.getContext('2d'), dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr; ctx.scale(dpr, dpr);
  const W = c.clientWidth, H = c.clientHeight, colors = ['#2cc3f0', '#7be3ff', '#ffffff', '#8b9cff', '#46e0b0', '#ffd166'];
  const parts = Array.from({ length: 110 }, (_, i) => {
    const left = i % 2 === 0, a = 0.3 + Math.random() * 0.7, v = 7 + Math.random() * 7; // a: angle from straight up
    return { x: left ? 40 : W - 40, y: H - 30, vx: (left ? 1 : -1) * Math.sin(a) * v, vy: -Math.cos(a) * v - 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, c: colors[i % colors.length] };
  });
  const t0 = performance.now();
  (function frame(t) {
    const age = (t - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.28; p.vx *= 0.99; p.vy *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 1.4) / 0.8);
      ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (age < 2.3) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// ---------- uninstall ----------
function renderUninstall() {
  const u = state.uninstall;
  $('ttitle').textContent = 'Uninstall Echo Volume';
  document.title = 'Uninstall Echo Volume';
  $('u-version').textContent = `Version ${state.version}`;
  $('u-where').textContent = `Installed ${scopeText(u.scope)} in ${u.dir}`;
  $('u-data-hint').textContent = `Amazon and SmartThings sign-in, playlists, favourites, scenes, birthdays and settings (${u.dataDir}).`;
  show('s-uconfirm', 'u-cancel');
}
$('u-cancel').onclick = () => api.close();
$('u-go').onclick = async () => {
  $('p-title').textContent = 'Uninstalling Echo Volume';
  $('p-cancel').hidden = true;
  resetProgress();
  show('s-progress');
  const removeData = $('u-data').checked;
  const r = await api.uninstall({ removeData }).catch((e) => ({ ok: false, error: clean(e) }));
  if (!r.ok) {
    $('e-title').textContent = 'Uninstall did not finish'; $('e-text').textContent = r.error; $('e-sub').textContent = '';
    $('e-retry').onclick = () => $('u-go').onclick(); show('s-error', 'e-retry'); return;
  }
  $('ud-text').textContent = (removeData ? 'Your data was deleted too.' : 'Your sign-in and settings were kept, in case you install it again.')
    + (r.dry ? ' (Development run: nothing was actually deleted.)' : '');
  show('s-udone', 'ud-close');
};
function uninstallProgress(p) {
  $('p-status').textContent = p.text;
  target = p.percent; if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); }
}
$('ud-close').onclick = () => api.close();

// ---------- window, keyboard ----------
$('btnMin').onclick = () => api.minimize();
$('btnClose').onclick = () => api.close();
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('p-confirm').hidden) return $('p-keep').click();
  if (current?.id === 's-custom') return $('c-back').click();
  if (autoTimer) stopAuto();
});
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- start ----------
(async () => {
  try {
    state = await api.getState();
  } catch (e) {
    $('e-title').textContent = 'Setup can\'t start'; $('e-text').textContent = clean(e); $('e-sub').textContent = '';
    $('e-retry').hidden = true; show('s-error', 'e-log'); return;
  }
  if (state.mode === 'uninstall') return renderUninstall();
  renderWelcome();
  if (state.auto) { opts = { ...opts, ...state.auto }; start(); } // the elevated copy: carry on where the other left off
})();
