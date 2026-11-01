// Echo Volume: "What's new". After an update it opens once on each device (this PC, the desktop app, a phone) with
// the releases since the version that device last saw; any time from the menu link or Settings → About.
// The notes come from release-notes.js on the server (/api/release-notes); a new install has nothing to catch up on.
(() => {
  const { esc, icon } = window.UI;
  const SEEN = 'seenVersion';
  const TYPES = [['new', 'New', 'star'], ['improved', 'Improved', 'bolt'], ['fixed', 'Fixed', 'check']];
  const WHERE_TAB = { Activity: 'activity', Moods: 'moods', Scenes: 'scenes', Home: 'home', Settings: 'settings', 'Smart home': 'smarthome', Lists: 'lists', Alexa: 'alexa' };
  let data = null;

  const newer = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  const seen = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };
  const markSeen = () => { try { localStorage.setItem(SEEN, data.version); } catch {} decorate(); };
  const load = async () => (data ||= await api('/release-notes'));
  const date = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });

  function release(r, latest) {
    const groups = TYPES.map(([type, label, ic]) => {
      const items = r.items.filter((i) => i.type === type);
      return items.length ? `<div class="wn-group"><div class="wn-type ${type}">${icon(ic, 'sm')}${label}</div><ul>${items.map((i) => `<li>${esc(i.text)}${i.where
        ? ` ${i.where.split(/,\s*/).map((w) => (WHERE_TAB[w] ? `<button type="button" class="wn-where" data-go="${WHERE_TAB[w]}">${esc(w)}</button>` : `<span class="wn-where">${esc(w)}</span>`)).join('')}` : ''}</li>`).join('')}</ul></div>` : '';
    }).join('');
    return `<section class="wn-rel">
      <div class="wn-head"><span class="wn-ver">${esc(r.version)}</span>${latest ? '<span class="wn-badge">Installed</span>' : ''}<span class="wn-date">${esc(date(r.date))}</span></div>
      <p class="wn-headline">${esc(r.headline)}</p>${groups}</section>`;
  }

  // list: the releases to show (an update: the new ones; from the menu: all, newest open)
  async function show(list) {
    await load();
    const all = data.releases, shown = list || all;
    const body = document.createElement('div');
    body.className = 'wn';
    const older = all.filter((r) => !shown.includes(r));
    body.innerHTML = shown.map((r) => release(r, r.version === data.version)).join('')
      + (older.length ? `<details class="wn-older"><summary>Earlier versions</summary>${older.map((r) => release(r, false)).join('')}</details>` : '')
      + `<div class="sheet-foot"><button type="button" class="btn primary" data-close>Got it</button></div>`;
    const sh = UI.sheet(body, { title: list ? `What's new in Echo Volume ${data.version}` : "What's new", wide: true });
    body.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) { sh.close(); showTab(go.dataset.go); }
    });
    markSeen();
  }
  window.showWhatsNew = () => show(null);

  // Once after an update: the releases newer than what this device saw (or than the version updated from)
  async function check() {
    try { await load(); } catch { return; }
    decorate();
    const s = seen();
    if (s === data.version) return;
    const u = data.updated;
    const fresh = u && u.to === data.version && Date.now() - u.at < 30 * 86400000;
    if (!fresh) return markSeen(); // a new install, or an update long ago: nothing to announce
    const from = s && newer(s, u.from) ? s : u.from;
    const list = data.releases.filter((r) => newer(r.version, from) && !newer(r.version, data.version));
    if (!list.length) return markSeen();
    // Not over something else (a sheet already open, the page in the background)
    const free = () => !document.hidden && !document.querySelector('.scrim');
    for (let i = 0; i < 60 && !free(); i++) await new Promise((r) => setTimeout(r, 1000));
    if (free()) show(list);
  }

  // The menu link (wide screens) and Settings → About show the version, with a dot until it's been seen
  function decorate() {
    if (!data) return;
    const unseen = seen() !== data.version;
    let b = $('whatsNew');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button'; b.id = 'whatsNew'; b.className = 'btn quiet whatsnew';
      b.onclick = () => show(null);
      $('sideToggle').before(b);
    }
    b.innerHTML = `${icon('star')}<span class="l">What's new <small>v${esc(data.version)}</small></span>${unseen ? '<span class="wn-dot" aria-label="Not seen yet"></span>' : ''}`;
    b.title = document.querySelector('.shell.mini') ? `What's new in ${data.version}` : '';
    const v = $('aboutVersion');
    if (v) v.textContent = data.version;
  }

  // Settings → About: after the settings screen draws itself
  const settings = window.tabLoaders.settings;
  window.tabLoaders.settings = async () => {
    await settings?.();
    if ($('aboutCard')) return;
    $('settingsTab').insertAdjacentHTML('beforeend', `<div class="card xcard" id="aboutCard"><div class="top"><span class="name">About Echo Volume</span><span class="kind">Version <b id="aboutVersion">${esc(data?.version || '')}</b></span></div>
      <p class="kind">See what changed in this version and the ones before.</p>
      <div class="sbtns"><button type="button" id="aboutWhatsNew">${icon('star', 'sm')}What's new</button></div></div>`);
    $('aboutWhatsNew').onclick = () => show(null);
    load().then(decorate).catch(() => {});
  };

  check();
})();
