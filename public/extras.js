// Echo Volume: tabs, live updates and the newer features: alarms & timers, Alexa lists, scenes, more Alexa
// (one-tap, sound effects, voice history), smart home, per-Echo settings, birthdays & anniversaries, notifications and phone access.
// Loaded after the main script; uses its helpers ($, api, esc, key, devices, playable, deviceOptions, showVol, …).
(() => {
  const isApp = document.documentElement.classList.contains('app');
  const speakerList = () => playable().filter((d) => d.family !== 'WHA');
  const whenDevices = () => new Promise((resolve) => {
    const check = () => (devices.length ? resolve() : setTimeout(check, 200));
    check();
  });
  const enc = encodeURIComponent;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtClock = (hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  const fmtDay = (ms) => {
    const d = new Date(ms), today = new Date(), tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
  };
  const fmtLeft = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  };
  const statusIn = (id) => (t, err) => {
    const s = $(id); if (!s) return;
    s.textContent = t; s.classList.toggle('err', !!err);
    if (!err && t) setTimeout(() => { if (s.textContent === t) s.textContent = ''; }, 5000);
  };

  // ---------- Toasts (messages in the corner) ----------
  function toast(title, body, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
    $('toasts').append(t);
    setTimeout(() => t.classList.add('out'), 4500);
    setTimeout(() => t.remove(), 5000);
  }

  // ---------- Tabs ----------
  const tabLoaders = {}; // tab -> loads its data each time it's opened
  let tab = 'home';
  function showTab(name) {
    if (!document.querySelector(`section.tab[data-tab="${name}"]`)) name = 'home';
    tab = name;
    document.querySelectorAll('section.tab').forEach((s) => { s.hidden = s.dataset.tab !== name; });
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('cur', b.dataset.tab === name));
    try { localStorage.setItem('tab', name); } catch {}
    tabLoaders[name]?.();
  }
  $('tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };

  // ---------- Stop all ----------
  $('stopAll').onclick = async () => {
    $('stopAll').disabled = true;
    try { await api('/stop-all', {}); toast('Stopped', 'Audio stopped on every Echo'); setTimeout(refreshNow, 1500); }
    catch (e) { toast('Stop all', e.message, true); }
    finally { $('stopAll').disabled = false; }
  };

  // ---------- Echo card badges: Do Not Disturb, running timer ----------
  let dnd = {}, alerts = [];
  function decorateCards() {
    document.querySelectorAll('#grid .card[data-serial]').forEach((c) => {
      const serial = c.dataset.serial;
      let b = c.querySelector('.badges');
      if (!b) { b = document.createElement('div'); b.className = 'badges'; c.querySelector('.top').after(b); }
      const next = alerts.filter((a) => a.device === serial && a.type === 'timer' && a.status === 'ON' && a.at).sort((x, y) => x.at - y.at)[0];
      b.innerHTML = (dnd[serial] ? '<span class="badge">🌙 Do Not Disturb</span>' : '')
        + (next ? `<span class="badge timer" data-at="${next.at}">⏱ ${esc(next.label || 'Timer')} <span>${fmtLeft(next.at - Date.now())}</span></span>` : '');
      b.hidden = !b.innerHTML;
    });
  }
  window.decorateCards = decorateCards; // the main script calls it after drawing the cards
  setInterval(() => {
    document.querySelectorAll('[data-at] > span, .countdown[data-at]').forEach((s) => {
      const at = +(s.dataset.at || s.parentElement.dataset.at);
      s.textContent = fmtLeft(at - Date.now());
    });
  }, 1000);
  async function loadDnd() {
    try { dnd = await api('/dnd'); decorateCards(); if (tab === 'settings') markDnd(); } catch {}
  }

  // ---------- Live updates (server-sent events from Amazon's push connection) ----------
  const live = document.createElement('span');
  live.className = 'live'; live.hidden = true; live.title = 'Changes from Amazon arrive instantly';
  live.textContent = '● Live';
  document.querySelector('header .conn').after(live);
  let nowTimer = null;
  const refreshNowSoon = () => { clearTimeout(nowTimer); nowTimer = setTimeout(refreshNow, 600); };
  function connectLive() {
    const es = new EventSource('/api/events' + (key ? `?key=${enc(key)}` : ''));
    const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data || '{}')); } catch {} });
    on('hello', (d) => { live.hidden = !d.push; });
    on('push', (d) => { live.hidden = !d.connected; });
    on('volume', (d) => { if (!pending[d.serial] && !timers[d.serial]) showVol(d.serial, d.volume); });
    on('media', (d) => { if (!d.serial || d.serial === musicTarget()) refreshNowSoon(); });
    on('alerts', () => loadAlerts());
    on('dnd', () => loadDnd());
    on('lists', () => { if (tab === 'lists') loadLists(); });
    on('eq', (d) => showEq(d.serial, d));
    on('bluetooth', () => { if (tab === 'settings') loadBluetooth(); });
    on('activity', (d) => addHistory(d));
    on('scene', (d) => sceneProgress(d));
    on('theme', (d) => applyTheme(d.theme));
    on('alert', (d) => notifyHere(d, false));
    on('song', (d) => notifyHere(d, true));
    es.onerror = () => { es.close(); live.hidden = true; setTimeout(connectLive, 5000); };
  }
  // Timer/alarm and song notifications: the desktop app shows Windows notifications itself; a browser tab in the
  // background shows one if allowed (Settings); a visible page shows a toast
  function notifyHere(n, isSong) {
    if (!isApp && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(n.title, { body: n.body, icon: n.artwork || '/icon.png', silent: isSong });
    } else if (!document.hidden) toast(n.title, n.body);
  }

  // ---------- Alarms, timers and reminders ----------
  const alStatus = statusIn('alStatus');
  function timersTab() {
    $('timersTab').innerHTML = `
      <div class="card xcard">
        <div class="top"><span class="name">New</span><span class="kind">Set by voice on the chosen Echo, like saying it to Alexa</span></div>
        <form class="xform" id="alForm">
          <span class="seg" id="alType">
            <button type="button" data-t="timer" class="cur">Timer</button><button type="button" data-t="alarm">Alarm</button><button type="button" data-t="reminder">Reminder</button>
          </span>
          <select id="alDevice" aria-label="On which Echo"></select>
          <span class="grp" data-for="timer">
            <input type="number" id="alH" min="0" max="23" placeholder="0" aria-label="Hours" class="num" /> h
            <input type="number" id="alM" min="0" max="59" placeholder="10" aria-label="Minutes" class="num" /> min
            <input id="alLabel" maxlength="40" placeholder="Name (optional, e.g. tea)" aria-label="Timer name" />
          </span>
          <span class="grp" data-for="alarm" hidden>
            <input type="time" id="alTime" aria-label="Alarm time" />
            <select id="alRepeat" aria-label="Repeat"><option value="">Once</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekends">Weekends</option></select>
          </span>
          <span class="grp" data-for="reminder" hidden>
            <input id="alText" maxlength="120" placeholder="Remind me to…" aria-label="Reminder" />
            <select id="alDay" aria-label="When"><option value="today">Today at</option><option value="tomorrow">Tomorrow at</option><option value="in">In (minutes)</option></select>
            <input type="time" id="alRTime" aria-label="Reminder time" />
            <input type="number" id="alRMin" min="1" max="1440" placeholder="30" aria-label="In how many minutes" class="num" hidden />
          </span>
          <button class="go" type="submit">Set</button>
        </form>
        <div class="status" id="alStatus"></div>
      </div>
      <div class="card xcard"><div class="top"><span class="name">Timers</span></div><div class="alist" id="alTimers"></div></div>
      <div class="card xcard"><div class="top"><span class="name">Alarms</span>
        <label class="toggle"><input type="checkbox" id="alShowOff" /> Show switched-off alarms</label></div><div class="alist" id="alAlarms"></div></div>
      <div class="card xcard"><div class="top"><span class="name">Reminders</span></div><div class="alist" id="alReminders"></div></div>`;
    let type = 'timer';
    $('alType').onclick = (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      type = b.dataset.t;
      $('alType').querySelectorAll('button').forEach((x) => x.classList.toggle('cur', x === b));
      document.querySelectorAll('#alForm [data-for]').forEach((g) => { g.hidden = g.dataset.for !== type; });
    };
    $('alDay').onchange = () => { const inMin = $('alDay').value === 'in'; $('alRMin').hidden = !inMin; $('alRTime').hidden = inMin; };
    const soon = new Date(Date.now() + 3600000);
    $('alTime').value = $('alRTime').value = `${pad(soon.getHours())}:00`;
    $('alForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = { type, device: $('alDevice').value };
      if (type === 'timer') Object.assign(body, { minutes: (+$('alH').value || 0) * 60 + (+$('alM').value || 0), label: $('alLabel').value });
      if (type === 'alarm') Object.assign(body, { time: $('alTime').value, repeat: $('alRepeat').value });
      if (type === 'reminder') {
        Object.assign(body, { text: $('alText').value });
        if ($('alDay').value === 'in') body.minutes = +$('alRMin').value; else Object.assign(body, { time: $('alRTime').value, day: $('alDay').value });
      }
      const btn = e.submitter; if (btn) btn.disabled = true;
      alStatus('Asking Alexa…');
      try {
        const r = await api('/alerts', body);
        alStatus(`Said “${r.said}” on ${r.device}`);
        if (type === 'reminder') $('alText').value = '';
        if (type === 'timer') $('alLabel').value = '';
      } catch (err) { alStatus(err.message, true); }
      finally { if (btn) btn.disabled = false; }
    };
    $('alShowOff').onchange = renderAlerts;
    for (const id of ['alTimers', 'alAlarms', 'alReminders']) $(id).onclick = alertAction;
    whenDevices().then(() => {
      $('alDevice').innerHTML = deviceOptions(speakerList());
      if (speakerList().some((d) => d.serial === musicTarget())) $('alDevice').value = musicTarget();
    });
  }
  async function loadAlerts() {
    try {
      const r = await api('/alerts');
      const skew = Date.now() - r.now; // the server's clock vs this device's
      alerts = r.alerts.map((a) => ({ ...a, at: a.at && a.at + skew }));
      decorateCards();
      if ($('alTimers')) renderAlerts();
    } catch (e) { if ($('alTimers')) alStatus(e.message, true); }
  }
  function renderAlerts() {
    const row = (a, main, sub, actions) => `<div class="arow" data-id="${esc(a.id)}">
      <div class="amain">${main}</div><div class="asub">${sub}</div><div class="aact">${actions}</div></div>`;
    const del = '<button data-act="delete" title="Delete" aria-label="Delete">✕</button>';
    const tm = alerts.filter((a) => a.type === 'timer' && a.status !== 'OFF');
    $('alTimers').innerHTML = tm.length ? tm.map((a) => row(a,
      `<b class="countdown" ${a.at ? `data-at="${a.at}"` : ''}>${a.at ? fmtLeft(a.at - Date.now()) : 'Paused'}</b> ${esc(a.label || 'Timer')}`,
      esc(a.deviceName), `<button data-act="delete">Cancel</button>`)).join('') : '<div class="empty small">No timers running.</div>';
    const showOff = $('alShowOff').checked;
    const al = alerts.filter((a) => a.type === 'alarm' && (showOff || a.status !== 'OFF'));
    const offCount = alerts.filter((a) => a.type === 'alarm' && a.status === 'OFF').length;
    $('alAlarms').innerHTML = al.length ? al.map((a) => row(a,
      `<b>${a.time ? fmtClock(a.time) : '–'}</b> ${esc(a.label || '')}`,
      `${esc(a.repeat || (a.at ? fmtDay(a.at) : ''))} · ${esc(a.deviceName)}`,
      `<label class="switch" title="On / off"><input type="checkbox" data-act="toggle" ${a.status === 'ON' ? 'checked' : ''} aria-label="Alarm on" /><span></span></label>${del}`)).join('')
      : `<div class="empty small">No alarms${offCount && !showOff ? ` on (${offCount} switched off)` : ''}.</div>`;
    const rm = alerts.filter((a) => a.type === 'reminder' && a.status === 'ON');
    const shown = allReminders ? rm : rm.slice(0, 10);
    $('alReminders').innerHTML = rm.length ? shown.map((a) => row(a,
      esc(a.label || 'Reminder'),
      `${a.at ? `${fmtDay(a.at)}${a.time ? `, ${fmtClock(a.time)}` : ''}` : ''} · ${esc(a.deviceName)}`, del)).join('')
      + (rm.length > 10 ? `<button type="button" class="more" data-act="more">${allReminders ? 'Show fewer' : `Show all ${rm.length}`}</button>` : '')
      : '<div class="empty small">No reminders.</div>';
  }
  let allReminders = false;
  async function alertAction(e) {
    const t = e.target.closest('[data-act]'); if (!t) return;
    if (t.dataset.act === 'more') { allReminders = !allReminders; return renderAlerts(); }
    const id = t.closest('.arow').dataset.id;
    const a = alerts.find((x) => x.id === id);
    try {
      if (t.dataset.act === 'toggle') { await api('/alerts/toggle', { id, on: t.checked }); alStatus(t.checked ? 'Alarm on' : 'Alarm off'); }
      if (t.dataset.act === 'delete') {
        if (a?.type !== 'timer' && !confirm(`Delete this ${a?.type || 'item'}${a?.label ? ` “${a.label}”` : ''}?`)) return;
        await api('/alerts/delete', { id });
        alerts = alerts.filter((x) => x.id !== id);
        renderAlerts(); decorateCards();
      }
    } catch (err) { alStatus(err.message, true); loadAlerts(); }
  }
  tabLoaders.timers = () => { if (!$('alForm')) timersTab(); loadAlerts(); };

  // ---------- Alexa lists ----------
  const liStatus = statusIn('liStatus');
  let lists = [];
  async function loadLists() {
    if (!$('listsTab').firstChild) $('listsTab').innerHTML = '<div class="empty">Loading…</div>';
    try { lists = await api('/lists'); renderLists(); }
    catch (e) { $('listsTab').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function renderLists() {
    const open = new Set([...document.querySelectorAll('#listsTab details[open]')].map((d) => d.dataset.list));
    $('listsTab').innerHTML = `<div class="status" id="liStatus"></div>` + (lists.length ? lists.map((l) => {
      const active = l.items.filter((i) => !i.completed), done = l.items.filter((i) => i.completed);
      const item = (i) => `<li data-item="${esc(i.id)}" data-version="${esc(i.version)}">
        <label><input type="checkbox" ${i.completed ? 'checked' : ''} aria-label="Done" /><span>${esc(i.value)}</span></label>
        <button data-act="delete" title="Delete" aria-label="Delete ${esc(i.value)}">✕</button></li>`;
      return `<div class="card xcard" data-list="${esc(l.id)}">
        <div class="top"><span class="name">${esc(l.name)}</span><span class="kind">${active.length} to do</span></div>
        <form class="xform addform"><input maxlength="200" placeholder="Add to ${esc(l.name)}…" aria-label="New item" /><button class="go" type="submit">Add</button></form>
        <ul class="items">${active.map(item).join('') || '<li class="empty small">Nothing on this list.</li>'}</ul>
        ${done.length ? `<details data-list="${esc(l.id)}" ${open.has(l.id) ? 'open' : ''}><summary>Done (${done.length})</summary><ul class="items done">${done.map(item).join('')}</ul></details>` : ''}
      </div>`;
    }).join('') : '<div class="empty">No Alexa lists.</div>');
  }
  $('listsTab').addEventListener('submit', async (e) => {
    e.preventDefault();
    const listId = e.target.closest('[data-list]').dataset.list, input = e.target.querySelector('input');
    const value = input.value.trim(); if (!value) return;
    input.value = '';
    try { await api(`/lists/${enc(listId)}/items`, { value }); liStatus(`Added “${value}”`); setTimeout(loadLists, 800); }
    catch (err) { liStatus(err.message, true); input.value = value; }
  });
  $('listsTab').addEventListener('change', async (e) => {
    if (e.target.type !== 'checkbox') return;
    const li = e.target.closest('li'), listId = e.target.closest('[data-list]').dataset.list;
    try { await api(`/lists/${enc(listId)}/items/${enc(li.dataset.item)}`, { completed: e.target.checked, version: +li.dataset.version }); }
    catch (err) { liStatus(err.message, true); }
    loadLists();
  });
  $('listsTab').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act="delete"]'); if (!b) return;
    const li = b.closest('li'), listId = b.closest('[data-list]').dataset.list;
    try { await api(`/lists/${enc(listId)}/items/${enc(li.dataset.item)}/delete`, { version: +li.dataset.version }); li.remove(); }
    catch (err) { liStatus(err.message, true); }
    loadLists();
  });
  tabLoaders.lists = loadLists;

  // ---------- Scenes ----------
  const scStatus = statusIn('scStatus');
  let scenes = [], routines = null, sounds = null, editing = null;
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_LONG = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ALEXA_DO = { weather: 'Weather', traffic: 'Traffic', flashbriefing: 'News (flash briefing)', goodmorning: 'Good morning',
    calendarToday: "Today's calendar", calendarTomorrow: "Tomorrow's calendar", joke: 'A joke', funfact: 'A fun fact', singasong: 'Sing a song', tellstory: 'A story' };
  const STEPS = {
    volume: ['Echo volume', ['device', 'level']],
    music: ['Play music', ['device', 'query', 'provider']],
    pause: ['Pause music', ['device']],
    resume: ['Resume music', ['device']],
    sleep: ['Sleep timer', ['device', 'minutes']],
    tv: ['TV', ['tvaction']],
    dnd: ['Do Not Disturb', ['deviceAll', 'on']],
    screen: ['Echo Show screen', ['show', 'on']],
    announce: ['Announcement', ['deviceAll', 'text']],
    routine: ['Alexa routine', ['routine', 'device']],
    sound: ['Sound effect', ['deviceAll', 'sound']],
    alexa: ['Alexa plays…', ['device', 'action']],
    stopall: ['Stop all audio', []],
    wait: ['Wait', ['seconds']],
  };
  const opts = (pairs, cur) => pairs.map(([v, t]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const devPairs = (list) => list.map((d) => [d.serial, d.name + (d.family === 'WHA' ? ' (group)' : '')]);
  function field(name, s) {
    switch (name) {
      case 'device': return `<select data-f="device" aria-label="Echo">${opts(devPairs(playable()), s.device)}</select>`;
      case 'deviceAll': return `<select data-f="device" aria-label="Echo">${opts([['all', 'All Echos'], ...devPairs(playable())], s.device || 'all')}</select>`;
      case 'show': return `<select data-f="device" aria-label="Echo Show">${opts(devPairs(speakerList().filter((d) => d.family === 'KNIGHT')), s.device)}</select>`;
      case 'level': return `<label>Volume <input type="number" data-f="level" min="0" max="10" value="${esc(s.level ?? 4)}" class="num" /></label>`;
      case 'query': return `<input data-f="query" placeholder="Song, album, artist or station" value="${esc(s.query || '')}" />`;
      case 'provider': return `<select data-f="provider" aria-label="From">${opts([['APPLE_MUSIC', 'Apple Music'], ['TUNEIN', 'TuneIn radio']], s.provider || 'APPLE_MUSIC')}</select>`;
      case 'minutes': return `<select data-f="minutes" aria-label="Pause after">${opts([[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours']], s.minutes ?? 30)}</select>`;
      case 'on': return `<select data-f="on" aria-label="On or off">${opts([['true', 'On'], ['false', 'Off']], s.on === false ? 'false' : 'true')}</select>`;
      case 'text': return `<input data-f="text" maxlength="250" placeholder="What Alexa says" value="${esc(s.text || '')}" />`;
      case 'routine': return `<select data-f="id" aria-label="Routine">${opts((routines || []).map((r) => [r.id, r.name]), s.id)}</select>`;
      case 'sound': return `<select data-f="id" aria-label="Sound">${opts((sounds || []).map((x) => [x.id, `${x.name} (${x.category})`]), s.id)}</select>`;
      case 'action': return `<select data-f="action" aria-label="What">${opts(Object.entries(ALEXA_DO), s.action)}</select>`;
      case 'seconds': return `<label><input type="number" data-f="seconds" min="1" max="600" value="${esc(s.seconds ?? 5)}" class="num" /> seconds</label>`;
      case 'tvaction': return `<select data-f="action" class="tvact" aria-label="TV action">${opts([['on', 'Turn on'], ['off', 'Turn off'], ['volume', 'Set volume'], ['mute', 'Mute'], ['unmute', 'Unmute'], ['app', 'Open app']], s.action || 'on')}</select>
        <input type="number" data-f="level" min="0" max="100" placeholder="0–100" value="${esc(s.level ?? '')}" class="num tvlevel" ${s.action === 'volume' ? '' : 'hidden'} aria-label="TV volume" />
        <input data-f="value" placeholder="App name, e.g. YouTube" value="${esc(s.value || '')}" class="tvapp" ${s.action === 'app' ? '' : 'hidden'} aria-label="App name" />`;
      default: return '';
    }
  }
  const stepRow = (s) => `<div class="step" data-type="${s.type}"><b>${esc(STEPS[s.type][0])}</b>
    <span class="fields">${STEPS[s.type][1].map((f) => field(f, s)).join('')}</span>
    <span class="sbtn"><button type="button" data-mv="-1" aria-label="Move up">↑</button><button type="button" data-mv="1" aria-label="Move down">↓</button><button type="button" data-rm aria-label="Remove step">✕</button></span></div>`;
  function readStep(row) {
    const s = { type: row.dataset.type };
    row.querySelectorAll('[data-f]').forEach((f) => {
      if (f.hidden) return;
      const k = f.dataset.f;
      s[k] = k === 'on' ? f.value === 'true' : ['level', 'minutes', 'seconds'].includes(k) ? (f.value === '' ? undefined : +f.value) : f.value;
    });
    return s;
  }
  const stepText = (s) => {
    const dev = (serial) => (serial === 'all' ? 'all Echos' : devices.find((d) => d.serial === serial)?.name || '');
    switch (s.type) {
      case 'volume': return `${dev(s.device)} volume ${s.level}`;
      case 'music': return `Play “${s.query}”${s.provider === 'TUNEIN' ? ' (radio)' : ''} on ${dev(s.device)}`;
      case 'pause': return `Pause ${dev(s.device)}`;
      case 'resume': return `Resume ${dev(s.device)}`;
      case 'sleep': return `Sleep timer ${s.minutes} min`;
      case 'tv': return s.action === 'volume' ? `TV volume ${s.level}` : s.action === 'app' ? `TV: open ${s.value}` : `TV ${s.action}`;
      case 'dnd': return `Do Not Disturb ${s.on === false ? 'off' : 'on'} (${dev(s.device || 'all')})`;
      case 'screen': return `${dev(s.device)} screen ${s.on === false ? 'off' : 'on'}`;
      case 'announce': return `Announce “${s.text}”`;
      case 'routine': return `Routine: ${routines?.find((r) => r.id === s.id)?.name || 'routine'}`;
      case 'sound': return `Sound: ${sounds?.find((x) => x.id === s.id)?.name || s.id}`;
      case 'alexa': return ALEXA_DO[s.action] || s.action;
      case 'stopall': return 'Stop all audio';
      case 'wait': return `Wait ${s.seconds}s`;
      default: return s.type;
    }
  };
  const scheduleText = (sc) => (sc.schedule?.enabled
    ? `${sc.schedule.days?.length && sc.schedule.days.length < 7 ? sc.schedule.days.map((d) => DAY_LONG[d]).join(', ') : 'Every day'} at ${fmtClock(sc.schedule.time)}` : '');
  async function loadScenes() {
    try {
      [scenes] = await Promise.all([api('/scenes'), routines ? null : api('/routines').then((r) => { routines = r; }).catch(() => { routines = []; }),
        sounds ? null : api('/sounds').then((r) => { sounds = r; }).catch(() => { sounds = []; })]);
      await whenDevices();
      renderScenes();
    } catch (e) { $('scenesTab').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function renderScenes() {
    if (editing) return; // don't wipe an open editor
    $('scenesTab').innerHTML = `
      <div class="card xcard"><div class="top"><span class="name">Scenes</span>
        <span class="sbtns">${scenes.length ? '' : '<button id="scExamples">Add examples</button>'}<button class="go" id="scNew">New scene</button></span></div>
        <p class="kind">A scene does several things in one tap, e.g. “Movie time”: TV on, Echos down to 3, open YouTube. Scenes can also run on a schedule while Echo Volume is running.</p>
        <div class="status" id="scStatus"></div>
      </div>
      ${scenes.map((sc) => `<div class="card xcard scene" data-id="${esc(sc.id)}">
        <div class="top"><span class="name">${esc(sc.name)}</span><span class="kind">${esc(scheduleText(sc))}</span></div>
        <p class="steps">${sc.steps.map((s) => esc(stepText(s))).join(' <span class="arrow">→</span> ')}</p>
        <div class="sbtns"><button class="go" data-sc="run">▶ Run</button><button data-sc="edit">Edit</button><button data-sc="delete">Delete</button>
          <span class="kind progress" data-progress="${esc(sc.id)}"></span></div>
      </div>`).join('')}`;
    $('scNew').onclick = () => editScene({ name: '', steps: [{ type: 'volume', device: speakerList()[0]?.serial, level: 4 }], schedule: null });
    if ($('scExamples')) $('scExamples').onclick = addExamples;
  }
  function editScene(sc) {
    editing = sc;
    const days = new Set(sc.schedule?.days || []);
    $('scenesTab').innerHTML = `<div class="card xcard editor">
      <div class="top"><span class="name">${sc.id ? 'Edit scene' : 'New scene'}</span></div>
      <input id="scName" maxlength="60" placeholder="Scene name, e.g. Movie time" value="${esc(sc.name)}" aria-label="Scene name" />
      <div id="scSteps">${sc.steps.map(stepRow).join('')}</div>
      <div class="sbtns"><select id="scAddType" aria-label="Step to add">${opts(Object.entries(STEPS).map(([k, v]) => [k, v[0]]))}</select><button type="button" id="scAdd">+ Add step</button></div>
      <div class="sched"><label class="toggle"><input type="checkbox" id="scSched" ${sc.schedule?.enabled ? 'checked' : ''} /> Run automatically at</label>
        <input type="time" id="scTime" value="${esc(sc.schedule?.time || '22:00')}" aria-label="Time" />
        <span class="days" id="scDays">${DAYS.map((d, i) => `<button type="button" data-day="${i}" class="${days.has(i) ? 'cur' : ''}" title="${DAY_LONG[i]}">${d}</button>`).join('')}</span>
        <small class="kind">No days picked = every day</small></div>
      <div class="sbtns"><button class="go" id="scSave">Save</button><button id="scCancel">Cancel</button></div>
      <div class="status" id="scStatus"></div></div>`;
    $('scAdd').onclick = () => {
      const type = $('scAddType').value;
      $('scSteps').insertAdjacentHTML('beforeend', stepRow({ type, device: musicTarget() }));
    };
    $('scSteps').onclick = (e) => {
      const row = e.target.closest('.step'); if (!row) return;
      if (e.target.closest('[data-rm]')) row.remove();
      const mv = e.target.closest('[data-mv]');
      if (mv) {
        const sib = +mv.dataset.mv < 0 ? row.previousElementSibling : row.nextElementSibling;
        if (sib) +mv.dataset.mv < 0 ? sib.before(row) : sib.after(row);
      }
    };
    $('scSteps').onchange = (e) => { // TV: volume and app name boxes only when needed
      if (!e.target.classList.contains('tvact')) return;
      const row = e.target.closest('.step');
      row.querySelector('.tvlevel').hidden = e.target.value !== 'volume';
      row.querySelector('.tvapp').hidden = e.target.value !== 'app';
    };
    $('scDays').onclick = (e) => { const b = e.target.closest('[data-day]'); if (b) b.classList.toggle('cur'); };
    $('scCancel').onclick = () => { editing = null; renderScenes(); };
    $('scSave').onclick = async () => {
      const scene = {
        id: sc.id, name: $('scName').value,
        steps: [...$('scSteps').children].map(readStep),
        schedule: { enabled: $('scSched').checked, time: $('scTime').value, days: [...$('scDays').querySelectorAll('.cur')].map((b) => +b.dataset.day) },
      };
      try {
        await api('/scenes', { scene });
        editing = null;
        scenes = await api('/scenes');
        renderScenes();
        scStatus(`Saved “${scene.name}”`);
      } catch (e) { scStatus(e.message, true); }
    };
  }
  async function addExamples() {
    const show = speakerList().find((d) => d.family === 'KNIGHT')?.serial || speakerList()[0]?.serial;
    const music = musicTarget() || show;
    const examples = [
      { name: 'Movie time', steps: [{ type: 'tv', action: 'on' }, { type: 'wait', seconds: 8 }, ...speakerList().map((d) => ({ type: 'volume', device: d.serial, level: 3 })), { type: 'tv', action: 'app', value: 'YouTube' }] },
      { name: 'Bedtime', steps: [{ type: 'sleep', device: music, minutes: 30 }, { type: 'dnd', device: 'all', on: true }, { type: 'screen', device: show, on: false }] },
    ];
    try {
      for (const scene of examples) await api('/scenes', { scene });
      scenes = await api('/scenes');
      renderScenes();
      scStatus('Added two examples: edit them to suit you');
    } catch (e) { scStatus(e.message, true); }
  }
  $('scenesTab').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sc]'); if (!b) return;
    const sc = scenes.find((x) => x.id === b.closest('.scene').dataset.id); if (!sc) return;
    if (b.dataset.sc === 'edit') return editScene(JSON.parse(JSON.stringify(sc)));
    if (b.dataset.sc === 'delete') {
      if (!confirm(`Delete the scene “${sc.name}”?`)) return;
      await api(`/scenes/${enc(sc.id)}/delete`, {}).catch((err) => scStatus(err.message, true));
      scenes = scenes.filter((x) => x.id !== sc.id);
      return renderScenes();
    }
    if (b.dataset.sc === 'run') api(`/scenes/${enc(sc.id)}/run`, {}).catch((err) => scStatus(err.message, true));
  });
  function sceneProgress(d) {
    const p = document.querySelector(`[data-progress="${CSS.escape(d.id)}"]`);
    const text = d.status === 'running' ? `Running ${d.step}/${d.total}…` : d.status === 'done' ? 'Done ✓' : `Finished with problems: ${d.errors.join('; ')}`;
    if (p) { p.textContent = text; p.classList.toggle('err', d.status === 'error'); }
    if (d.status === 'done' || d.status === 'error') {
      if (tab !== 'scenes') toast(`Scene “${d.name}”`, d.status === 'done' ? 'Done' : d.errors.join('; '), d.status === 'error');
      if (p && d.status === 'done') setTimeout(() => { if (p.textContent === text) p.textContent = ''; }, 6000);
    }
  }
  tabLoaders.scenes = loadScenes;

  // ---------- More Alexa: one-tap, sound effects, voice history ----------
  const axStatus = statusIn('axStatus');
  let history = [];
  function alexaTab() {
    $('alexaTab').innerHTML = `
      <div class="card xcard"><div class="top"><span class="name">One tap</span>
        <label class="kind">On <select id="axDevice" aria-label="On which Echo"></select></label></div>
        <div class="chips" id="axDo">${Object.entries(ALEXA_DO).map(([k, v]) => `<button type="button" data-do="${k}">${esc(v)}</button>`).join('')}</div>
        <div class="status" id="axStatus"></div></div>
      <div class="card xcard"><div class="top"><span class="name">Sound effects</span>
        <span class="mopts"><label class="kind">On <select id="sfDevice" aria-label="On which Echo"></select></label>
        <label class="kind">Kind <select id="sfCat" aria-label="Kind of sound"></select></label></span></div>
        <div class="chips" id="sfList"><span class="kind">Loading…</span></div></div>
      <div class="card xcard"><div class="top"><span class="name">Voice history</span>
        <span class="sbtns"><span class="kind">What Alexa heard in the last 24 hours</span><button id="vhRefresh">Refresh</button></span></div>
        <div class="alist" id="vhList"><div class="empty small">Loading…</div></div></div>`;
    whenDevices().then(() => {
      $('axDevice').innerHTML = deviceOptions(playable());
      $('sfDevice').innerHTML = '<option value="all">All Echos</option>' + deviceOptions(playable());
      if (playable().some((d) => d.serial === musicTarget())) $('axDevice').value = musicTarget();
    });
    $('axDo').onclick = async (e) => {
      const b = e.target.closest('[data-do]'); if (!b) return;
      b.disabled = true;
      try { const r = await api('/alexa/do', { device: $('axDevice').value, action: b.dataset.do }); axStatus(`${ALEXA_DO[r.action]} on ${r.device}`); }
      catch (err) { axStatus(err.message, true); }
      finally { b.disabled = false; }
    };
    $('sfCat').onchange = renderSounds;
    $('sfList').onclick = async (e) => {
      const b = e.target.closest('[data-sound]'); if (!b) return;
      b.disabled = true;
      try { await api('/sound', { device: $('sfDevice').value, id: b.dataset.sound }); } catch (err) { toast('Sound', err.message, true); }
      finally { b.disabled = false; }
    };
    $('vhRefresh').onclick = loadHistory;
  }
  async function loadSounds() {
    if (!sounds) sounds = await api('/sounds').catch(() => []);
    const cats = [...new Set(sounds.map((s) => s.category))].sort();
    if ($('sfCat') && !$('sfCat').options.length) { $('sfCat').innerHTML = opts(cats.map((c) => [c, c])); renderSounds(); }
    // Announcements can start with a sound
    if ($('annSound').options.length <= 1) {
      $('annSound').insertAdjacentHTML('beforeend', cats.map((c) => `<optgroup label="${esc(c)}">${sounds.filter((s) => s.category === c).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</optgroup>`).join(''));
    }
  }
  function renderSounds() {
    const list = sounds.filter((s) => s.category === $('sfCat').value);
    $('sfList').innerHTML = list.map((s) => `<button type="button" data-sound="${esc(s.id)}">${esc(s.name)}</button>`).join('') || '<span class="kind">No sounds.</span>';
  }
  async function loadHistory() {
    try { history = await api('/history'); renderHistory(); }
    catch (e) { if ($('vhList')) $('vhList').innerHTML = `<div class="empty small">${esc(e.message)}</div>`; }
  }
  function renderHistory() {
    if (!$('vhList')) return;
    $('vhList').innerHTML = history.length ? history.slice(0, 50).map((h) => `<div class="arow">
      <div class="amain">“${esc(h.text || '…')}”</div>
      <div class="asub">${h.at ? new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''} · ${esc(h.device)}${h.response ? ` · Alexa: ${esc(h.response)}` : ''}</div></div>`).join('')
      : '<div class="empty small">Nothing in the last 24 hours.</div>';
  }
  function addHistory(h) {
    if (!h?.text && !h?.response) return;
    history = [h, ...history.filter((x) => x.at !== h.at)];
    if (tab === 'alexa') renderHistory();
  }
  tabLoaders.alexa = () => { if (!$('axDo')) alexaTab(); loadSounds(); loadHistory(); };

  // ---------- Smart home ----------
  const shStatus = statusIn('shStatus');
  async function loadSmarthome() {
    if (!$('smarthomeTab').firstChild) $('smarthomeTab').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const list = await api('/smarthome/devices');
      $('smarthomeTab').innerHTML = `<div class="card xcard"><div class="top"><span class="name">Smart home</span><button id="shRefresh">Refresh</button></div>
        <p class="kind">Devices connected to Alexa that can be switched on and off: lights, plugs, switches, TVs. Devices you add in the Alexa app appear here.${list.length && list.every((d) => /^(TV|Built-in Alexa)\b/.test(d.kind)) ? ' So far your account only has a TV, which can be listed twice: once through its maker’s skill and once through its built-in Alexa.' : ''}</p>
        <div class="status" id="shStatus"></div></div>
        <div class="grid">${list.map((d) => `<div class="card shdev" data-id="${esc(d.id)}">
          <div class="top"><span class="name">${esc(d.name)}</span><span class="kind">${esc(d.kind)}</span></div>
          ${d.power === 'ON' ? '<div class="shstate on">On</div>' : d.power === 'OFF' ? '<div class="shstate">Off</div>'
            : d.reachable === false ? '<div class="shstate dim">Off or not reachable</div>' : '<div class="shstate dim">Doesn’t report whether it’s on</div>'}
          <div class="row2"><button data-sh="turnOn" class="${d.power === 'ON' ? 'on' : ''}">On</button><button data-sh="turnOff" class="${d.power === 'OFF' ? 'on' : ''}">Off</button></div>
          ${d.dimmable ? `<label class="kind">Brightness <input type="range" min="0" max="100" value="${esc(d.brightness ?? 50)}" data-sh="setBrightness" /></label>` : ''}
        </div>`).join('')}</div>`;
      $('shRefresh').onclick = loadSmarthome;
    } catch (e) { $('smarthomeTab').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  async function smartAction(id, action, brightness) {
    try { await api(`/smarthome/devices/${enc(id)}`, { action, brightness }); shStatus('Done'); setTimeout(loadSmarthome, 1500); }
    catch (e) { shStatus(e.message === 'ENDPOINT_UNREACHABLE' ? 'The device is not reachable (switched off at the wall, or offline)' : e.message, true); }
  }
  $('smarthomeTab').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sh]'); if (!b) return;
    smartAction(b.closest('.shdev').dataset.id, b.dataset.sh);
  });
  $('smarthomeTab').addEventListener('change', (e) => {
    if (e.target.dataset.sh !== 'setBrightness') return;
    smartAction(e.target.closest('.shdev').dataset.id, 'setBrightness', +e.target.value);
  });
  tabLoaders.smarthome = loadSmarthome;

  // ---------- Settings: per Echo (Do Not Disturb, equalizer, screen, Bluetooth), notifications, phone access ----------
  const seStatus = statusIn('seStatus');
  function settingsTab() {
    const echos = speakerList();
    $('settingsTab').innerHTML = `
      <div class="status" id="seStatus"></div>
      <div class="card xcard"><div class="top"><span class="name">All Echos</span></div>
        <div class="sbtns"><span class="kind">Do Not Disturb</span><button data-dndall="true">On for all</button><button data-dndall="false">Off for all</button></div></div>
      <div class="grid">${echos.map((d) => `<div class="card xcard echoset" data-serial="${esc(d.serial)}">
        <div class="top"><span class="name">${esc(d.name)}</span><span class="kind">${esc(KIND[d.family] || d.family)}</span></div>
        <label class="toggle setrow"><span>🌙 Do Not Disturb</span><span class="switch"><input type="checkbox" data-dnd aria-label="Do Not Disturb" /><span></span></span></label>
        <div class="eq">${['bass', 'mid', 'treble'].map((k) => `<label><span>${k === 'mid' ? 'Mid' : k[0].toUpperCase() + k.slice(1)}</span>
          <input type="range" min="-6" max="6" step="1" value="0" data-eq="${k}" aria-label="${k}" /><b data-eqv="${k}">0</b></label>`).join('')}
          <button data-eqreset>Reset equalizer</button></div>
        ${d.family === 'KNIGHT' ? `<div class="sbtns"><span class="kind">Screen</span><button data-screen="false">Turn off</button><button data-screen="true">Turn on</button></div>` : ''}
        <div class="bt" data-bt><span class="kind">Bluetooth: loading…</span></div>
      </div>`).join('')}</div>
      <div class="card xcard" id="celebCard"><div class="top"><span class="name">Birthdays & anniversaries</span></div><div id="celebBody"><span class="kind">Loading…</span></div></div>
      <div class="card xcard"><div class="top"><span class="name">Notifications</span></div>
        <label class="toggle setrow"><span>When a timer or alarm goes off</span><span class="switch"><input type="checkbox" data-notify="alerts" /><span></span></span></label>
        <label class="toggle setrow"><span>When the song changes (Echo music is playing on)</span><span class="switch"><input type="checkbox" data-notify="songs" /><span></span></span></label>
        <p class="kind">${isApp ? 'Shown as Windows notifications.' : 'Shown in this page, and as browser notifications while it is in the background.'}</p>
        ${!isApp && 'Notification' in window && Notification.permission !== 'granted' ? '<button id="nfAllow">Allow browser notifications</button>' : ''}</div>
      <div class="card xcard" id="phoneCard"><div class="top"><span class="name">Phone access</span></div><div id="phoneBody"><span class="kind">Loading…</span></div></div>`;
    loadEq(echos);
    markDnd();
    loadBluetooth();
    api('/notify').then((n) => document.querySelectorAll('[data-notify]').forEach((c) => { c.checked = !!n[c.dataset.notify]; })).catch(() => {});
    loadPhone();
    loadCelebrations();
    if ($('nfAllow')) $('nfAllow').onclick = () => Notification.requestPermission().then((p) => { if (p === 'granted') $('nfAllow').remove(); });
  }
  function markDnd() {
    document.querySelectorAll('.echoset').forEach((c) => { c.querySelector('[data-dnd]').checked = !!dnd[c.dataset.serial]; });
  }
  function showEq(serial, eq) {
    const c = document.querySelector(`.echoset[data-serial="${CSS.escape(serial || '')}"]`); if (!c) return;
    for (const k of ['bass', 'mid', 'treble']) {
      if (eq[k] == null) continue;
      const r = c.querySelector(`[data-eq="${k}"]`);
      if (document.activeElement !== r) r.value = eq[k];
      c.querySelector(`[data-eqv="${k}"]`).textContent = eq[k] > 0 ? `+${eq[k]}` : eq[k];
    }
  }
  function loadEq(echos) {
    for (const d of echos) api(`/eq?device=${enc(d.serial)}`).then((eq) => showEq(d.serial, eq)).catch(() => {});
  }
  async function loadBluetooth() {
    try {
      const list = await api('/bluetooth');
      document.querySelectorAll('.echoset').forEach((c) => {
        const bt = list.find((x) => x.serial === c.dataset.serial);
        const box = c.querySelector('[data-bt]');
        if (!bt?.paired.length) { box.innerHTML = '<span class="kind">Bluetooth: nothing paired</span>'; return; }
        box.innerHTML = `<span class="kind">Bluetooth</span>${bt.paired.map((b) => `<div class="btrow"><span>${esc(b.name)}</span>
          ${b.connected ? '<span class="badge">Connected</span><button data-btoff>Disconnect</button>' : `<button data-bton="${esc(b.address)}">Connect</button>`}</div>`).join('')}`;
      });
    } catch {}
  }
  const eqTimers = {};
  $('settingsTab').addEventListener('input', (e) => {
    const k = e.target.dataset.eq; if (!k) return;
    const c = e.target.closest('.echoset');
    c.querySelector(`[data-eqv="${k}"]`).textContent = +e.target.value > 0 ? `+${e.target.value}` : e.target.value;
    clearTimeout(eqTimers[c.dataset.serial]);
    eqTimers[c.dataset.serial] = setTimeout(() => sendEq(c), 400);
  });
  async function sendEq(c) {
    const v = (k) => +c.querySelector(`[data-eq="${k}"]`).value;
    try { await api('/eq', { device: c.dataset.serial, bass: v('bass'), mid: v('mid'), treble: v('treble') }); }
    catch (e) { seStatus(e.message, true); }
  }
  $('settingsTab').addEventListener('change', async (e) => {
    const t = e.target, c = t.closest('.echoset');
    try {
      if (t.matches('[data-dnd]')) {
        await api('/dnd', { device: c.dataset.serial, enabled: t.checked });
        dnd[c.dataset.serial] = t.checked; decorateCards();
      }
      if (t.dataset.notify) await api('/notify', { [t.dataset.notify]: t.checked });
      if (t.id === 'phoneOn') renderPhone(await api('/lan', { enabled: t.checked }));
    } catch (err) { seStatus(err.message, true); if (t.type === 'checkbox') t.checked = !t.checked; }
  });
  $('settingsTab').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const c = b.closest('.echoset');
    try {
      if (b.dataset.dndall) {
        await api('/dnd', { device: 'all', enabled: b.dataset.dndall === 'true' });
        seStatus(`Do Not Disturb ${b.dataset.dndall === 'true' ? 'on' : 'off'} for all Echos`);
        loadDnd();
      }
      if (b.hasAttribute('data-eqreset')) { c.querySelectorAll('[data-eq]').forEach((r) => { r.value = 0; }); showEq(c.dataset.serial, { bass: 0, mid: 0, treble: 0 }); await sendEq(c); }
      if (b.dataset.screen) { await api('/screen', { device: c.dataset.serial, on: b.dataset.screen === 'true' }); seStatus(`Screen ${b.dataset.screen === 'true' ? 'on' : 'off'}`); }
      if (b.dataset.bton) { b.disabled = true; await api('/bluetooth/connect', { device: c.dataset.serial, address: b.dataset.bton }); seStatus('Connecting…'); setTimeout(loadBluetooth, 4000); }
      if (b.hasAttribute('data-btoff')) { b.disabled = true; await api('/bluetooth/disconnect', { device: c.dataset.serial }); seStatus('Disconnected'); setTimeout(loadBluetooth, 3000); }
      if (b.id === 'phoneNewKey') {
        if (!confirm('Make a new key? Phones using the old link stop working until they open the new one.')) return;
        renderPhone(await api('/lan', { enabled: true, newKey: true }));
      }
    } catch (err) { seStatus(err.message, true); b.disabled = false; }
  });
  async function loadPhone() {
    try { renderPhone(await api('/lan')); }
    catch (e) { $('phoneBody').innerHTML = `<span class="kind">${esc(e.message)}</span>`; } // e.g. opened on the phone itself
  }
  function renderPhone(info) {
    const a = info.addresses?.[0];
    $('phoneBody').innerHTML = `
      <label class="toggle setrow"><span>Use Echo Volume from phones on the same Wi-Fi</span>
        <span class="switch"><input type="checkbox" id="phoneOn" ${info.enabled ? 'checked' : ''} ${info.fromEnv ? 'disabled' : ''} /><span></span></span></label>
      ${info.fromEnv ? '<p class="kind">On, using API_KEY from .env.</p>' : ''}
      ${info.enabled && a ? `<div class="phone">
        <img src="/api/lan/qr?url=${enc(a.url)}" alt="QR code for ${esc(a.url)}" width="180" height="180" />
        <div><p>Scan this with the phone's camera, or open:</p><p><code>${esc(a.url)}</code></p>
          ${info.addresses.length > 1 ? `<p class="kind">Other addresses of this PC: ${info.addresses.slice(1).map((x) => `${esc(x.ip)} (${esc(x.name)})`).join(', ')}</p>` : ''}
          <p class="kind">Then use the browser's “Add to Home screen” to open it like an app. The link contains the key: share it only with people you trust.
          The first time, Windows may ask whether to allow Echo Volume on private networks: allow it.</p>
          ${info.fromEnv ? '' : '<button id="phoneNewKey">Make a new key</button>'}</div></div>` : info.enabled ? '<p class="kind">This PC has no network address right now.</p>' : ''}`;
  }
  tabLoaders.settings = async () => { await whenDevices(); settingsTab(); };

  // ---------- Birthdays & anniversaries (in Settings): announced on the day ----------
  const ceStatus = statusIn('ceStatus');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let celeb = { settings: {}, items: [] }, celebEdit = null;
  async function loadCelebrations() {
    try {
      [celeb] = await Promise.all([api('/celebrations'), sounds ? null : api('/sounds').then((r) => { sounds = r; }).catch(() => { sounds = []; })]);
      renderCelebrations();
    } catch (e) { $('celebBody').innerHTML = `<span class="kind">${esc(e.message)}</span>`; }
  }
  const celebWhen = (c) => (c.days === 0 ? 'Today' : c.days === 1 ? 'Tomorrow' : `In ${c.days} days`);
  const celebDate = (c) => `${c.day} ${MONTHS[c.month - 1].slice(0, 3)}${c.year ? ` ${c.year}` : ''}`;
  function renderCelebrations() {
    if (!$('celebBody')) return;
    const s = celeb.settings, e = celebEdit || { type: 'birthday', name: '', day: '', month: '', year: '' };
    $('celebBody').innerHTML = `
      <label class="toggle setrow"><span>Announce them on the day</span><span class="switch"><input type="checkbox" id="ceOn" ${s.enabled ? 'checked' : ''} /><span></span></span></label>
      <div class="xform">
        <label class="kind">At <input type="time" id="ceTime" value="${esc(s.time || '09:00')}" aria-label="Announcement time" /></label>
        <select id="ceDevice" aria-label="On which Echo">${opts([['all', 'All Echos'], ...devPairs(playable())], s.device || 'all')}</select>
        <select id="ceSound" aria-label="Sound first">${opts([['', 'No sound first'], ...(sounds || []).map((x) => [x.id, `${x.name} (${x.category})`])], s.sound || '')}</select>
      </div>
      <p class="kind">Said with the year: “Asha is celebrating 34th birthday today”; without it: “It's Asha's birthday today”.
        Only while Echo Volume is running: if the PC is off at that time, it's announced when Echo Volume starts, until 10 pm.</p>
      <form class="xform" id="ceForm">
        <span class="seg" id="ceType">${[['birthday', '🎂 Birthday'], ['anniversary', '💐 Anniversary']].map(([v, t]) => `<button type="button" data-t="${v}" class="${e.type === v ? 'cur' : ''}">${t}</button>`).join('')}</span>
        <input id="ceName" maxlength="60" placeholder="${e.type === 'anniversary' ? 'Who, e.g. Asha and Rohan' : 'Name, e.g. Asha'}" value="${esc(e.name)}" aria-label="Name" />
        <select id="ceDay" aria-label="Day">${opts([['', 'Day'], ...Array.from({ length: 31 }, (_, i) => [i + 1, i + 1])], e.day)}</select>
        <select id="ceMonth" aria-label="Month">${opts([['', 'Month'], ...MONTHS.map((m, i) => [i + 1, m])], e.month)}</select>
        <input type="number" id="ceYear" class="num" min="1900" max="${new Date().getFullYear()}" placeholder="Year" value="${esc(e.year ?? '')}" aria-label="Year (optional)" title="Year (optional): to say the age or how many years" />
        <button class="go" type="submit">${celebEdit?.id ? 'Save' : 'Add'}</button>${celebEdit?.id ? '<button type="button" id="ceCancel">Cancel</button>' : ''}
      </form>
      <div class="status" id="ceStatus"></div>
      <div class="alist celist">${celeb.items.length ? celeb.items.map((c) => `<div class="arow" data-id="${esc(c.id)}">
        <div class="amain">${c.type === 'anniversary' ? '💐' : '🎂'} <b>${esc(c.name)}</b> · ${esc(celebDate(c))}</div>
        <div class="asub">${esc(celebWhen(c))} · “${esc(c.says)}”</div>
        <div class="aact"><button data-ce="test" title="Say it now on the chosen Echo">▶ Preview</button><button data-ce="edit">Edit</button><button data-ce="delete" title="Delete" aria-label="Delete">✕</button></div>
      </div>`).join('') : '<div class="empty small">None yet. Add a birthday or anniversary above.</div>'}</div>`;
    let type = e.type;
    $('ceType').onclick = (ev) => {
      const b = ev.target.closest('[data-t]'); if (!b) return;
      type = b.dataset.t;
      $('ceType').querySelectorAll('button').forEach((x) => x.classList.toggle('cur', x === b));
      $('ceName').placeholder = type === 'anniversary' ? 'Who, e.g. Asha and Rohan' : 'Name, e.g. Asha';
    };
    const saveSettings = async (body) => {
      try { celeb = await api('/celebrations/settings', body); ceStatus('Saved'); }
      catch (err) { ceStatus(err.message, true); }
    };
    $('ceOn').onchange = () => saveSettings({ enabled: $('ceOn').checked });
    $('ceTime').onchange = () => $('ceTime').value && saveSettings({ time: $('ceTime').value });
    $('ceDevice').onchange = () => saveSettings({ device: $('ceDevice').value });
    $('ceSound').onchange = () => saveSettings({ sound: $('ceSound').value });
    if ($('ceCancel')) $('ceCancel').onclick = () => { celebEdit = null; renderCelebrations(); };
    $('ceForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const body = { id: celebEdit?.id, type, name: $('ceName').value, day: $('ceDay').value, month: $('ceMonth').value, year: $('ceYear').value };
      try {
        celeb = await api('/celebrations', body);
        celebEdit = null;
        renderCelebrations();
        ceStatus(`Saved ${body.name.trim()}`);
      } catch (err) { ceStatus(err.message, true); }
    };
    $('celebBody').querySelector('.alist').onclick = async (ev) => {
      const b = ev.target.closest('[data-ce]'); if (!b) return;
      const c = celeb.items.find((x) => x.id === b.closest('.arow').dataset.id); if (!c) return;
      if (b.dataset.ce === 'edit') { celebEdit = { ...c }; renderCelebrations(); return $('ceName').focus(); }
      try {
        if (b.dataset.ce === 'delete') {
          if (!confirm(`Delete ${c.name}'s ${c.type}?`)) return;
          celeb = await api(`/celebrations/${enc(c.id)}/delete`, {});
          if (celebEdit?.id === c.id) celebEdit = null;
          renderCelebrations();
        }
        if (b.dataset.ce === 'test') {
          b.disabled = true;
          const r = await api(`/celebrations/${enc(c.id)}/test`, {});
          ceStatus(`Announced on ${r.devices.join(', ')}`);
          b.disabled = false;
        }
      } catch (err) { ceStatus(err.message, true); b.disabled = false; }
    };
  }

  // ---------- Start ----------
  connectLive();
  whenDevices().then(() => { loadDnd(); loadAlerts(); });
  setInterval(() => { if (!document.hidden && tab === 'timers') loadAlerts(); }, 60000);
  let saved = 'home';
  try { saved = localStorage.getItem('tab') || 'home'; } catch {}
  showTab(saved);
})();
