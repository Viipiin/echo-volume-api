// Echo Volume: the Moods screen. Suggestions for now, mood tiles by group (favourites first), a sheet to play one
// (Echo, intensity, language, vocals, healing frequency, volume, sleep), the mood playing now with its controls,
// editing moods, and the mood's colours in the page background while it plays. Live through the 'mood' event.
// Uses app.js helpers ($, api, esc, playable, musicTarget) and ui.js (UI.*).
(() => {
  const S = { data: null, now: null, sugg: null, edit: false, presets: [], help: '', loaded: false };
  const root = document.documentElement;
  const icon = UI.icon, enc = encodeURIComponent;
  const ENERGY = ['', 'Calm', 'Gentle', 'Steady', 'Lively', 'Energetic'];
  const SLEEP = [0, 15, 30, 45, 60, 90];
  const moodById = (id) => S.data?.moods.find((m) => m.id === id);
  const presetName = (id) => S.presets.find((p) => p.id === id)?.name || '';
  const devName = (serial) => devices.find((d) => d.serial === serial)?.name || '';
  const dots = (n) => `<span class="energy" aria-label="Energy ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  const tint = (el) => el.querySelectorAll('[data-a]').forEach((t) => { t.style.setProperty('--a', t.dataset.a); t.style.setProperty('--b', t.dataset.b); });

  // ---------- data ----------
  async function load() {
    try {
      const [data, sugg, now, pre] = await Promise.all([api('/moods'), api('/moods/suggest'), api('/moods/now'), S.presets.length ? null : api('/focus/presets')]);
      S.data = data; S.sugg = sugg; S.now = now.active ? now : null;
      if (pre) { S.presets = pre.presets; S.help = pre.help; }
      S.loaded = true;
      render(); ambience();
    } catch (e) { $('moodsTab').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  // Suggestions follow the clock
  setInterval(() => { if (S.loaded && !document.hidden) api('/moods/suggest').then((s) => { S.sugg = s; renderSuggest(); }).catch(() => {}); }, 5 * 60000);

  // ---------- screen ----------
  function tile(m, reason) {
    const on = S.now?.moodId === m.id;
    return `<div class="mood-cell" data-id="${esc(m.id)}">
      <button type="button" class="mood-tile${on ? ' on' : ''}" data-play="${esc(m.id)}" data-a="${esc(m.accent[0])}" data-b="${esc(m.accent[1])}" aria-label="${esc(m.name)}${on ? ', playing' : ''}">
        <span class="em" aria-hidden="true">${icon(m.icon || 'music')}</span><b>${esc(m.name)}</b>
        <small>${esc(reason || m.description || '')}</small>
        <span class="meta">${dots(m.energy)}${m.frequencyLayer ? `<span class="badge neutral" title="Healing frequency">${icon('wave')}${esc(presetName(m.frequencyLayer))}</span>` : ''}
          ${on ? '<span class="eqbars" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</span>
      </button>
      ${S.edit ? `<span class="mood-tools"><button type="button" class="btn icon sm round" data-edit="${esc(m.id)}" aria-label="Edit ${esc(m.name)}">${icon('edit', 'sm')}</button>
        <button type="button" class="btn icon sm round" data-del="${esc(m.id)}" aria-label="Delete ${esc(m.name)}">${icon('trash', 'sm')}</button></span>`
        : `<button type="button" class="mood-fav btn icon sm round quiet${m.favorite ? ' on' : ''}" data-fav="${esc(m.id)}" aria-pressed="${m.favorite}" aria-label="Favourite ${esc(m.name)}">${icon(m.favorite ? 'star-fill' : 'star', 'sm')}</button>`}
    </div>`;
  }
  function render() {
    const d = S.data; if (!d) return;
    const favs = d.moods.filter((m) => m.favorite);
    $('moodsTab').innerHTML = `
      <div class="card mood-now" id="moodNow" hidden></div>
      <div class="moods-head">
        <div><h2>Moods</h2><p class="muted small">Pick how you feel or what you're doing. Echo Volume keeps matching music playing on Apple Music.</p></div>
        <span class="spacer"></span>
        <label class="field inline"><span>Play on</span><select id="mdDevice" aria-label="Play moods on">${deviceOptions(playable())}</select></label>
        <button type="button" class="btn icon" id="mdInfo" aria-label="About moods and healing frequencies" title="About moods">${icon('info')}</button>
        <button type="button" class="btn${S.edit ? ' on' : ''}" id="mdEdit" aria-pressed="${S.edit}">${icon('edit', 'sm')}${S.edit ? 'Done' : 'Edit'}</button>
      </div>
      ${S.edit ? `<div class="card flat mood-editbar"><span class="muted small">Edit or delete moods, or add your own. Built-in moods can be put back as they were.</span><span class="spacer"></span>
        <button type="button" class="btn sm" id="mdReset">Reset built-ins</button><button type="button" class="btn sm primary" id="mdAdd">${icon('plus', 'sm')}Add mood</button></div>` : ''}
      <section class="mood-sec" aria-labelledby="mdSuggT"><h3 class="label" id="mdSuggT">Suggested for now</h3><div class="mood-grid" id="mdSugg"></div></section>
      ${favs.length ? `<section class="mood-sec" aria-labelledby="mdFavT"><h3 class="label" id="mdFavT">Favourites</h3><div class="mood-grid">${favs.map((m) => tile(m)).join('')}</div></section>` : ''}
      ${d.groups.map((g) => {
        const list = d.moods.filter((m) => m.group === g.id && !m.favorite);
        return list.length ? `<section class="mood-sec" aria-labelledby="mdG-${g.id}"><h3 class="label" id="mdG-${g.id}">${esc(g.name)}</h3><div class="mood-grid">${list.map((m) => tile(m)).join('')}</div></section>` : '';
      }).join('')}`;
    const sel = $('mdDevice');
    const want = S.now?.serial || musicTarget();
    if ([...sel.options].some((o) => o.value === want)) sel.value = want;
    tint($('moodsTab'));
    renderSuggest(); renderNow();
  }
  function renderSuggest() {
    const box = $('mdSugg'); if (!box || !S.sugg) return;
    box.innerHTML = S.sugg.suggestions.map((s) => { const m = moodById(s.moodId); return m ? tile(m, s.reason) : ''; }).join('');
    tint(box);
  }
  // The mood playing: name, phrase, tracks, sleep countdown, controls
  function renderNow() {
    const box = $('moodNow'); if (!box) return;
    const n = S.now;
    box.hidden = !n;
    document.querySelectorAll('#moodsTab .mood-tile').forEach((t) => {
      const on = n?.moodId === t.dataset.play;
      t.classList.toggle('on', on);
      t.querySelector('.eqbars')?.remove();
      if (on) t.querySelector('.meta').insertAdjacentHTML('beforeend', '<span class="eqbars" aria-hidden="true"><i></i><i></i><i></i></span>');
    });
    if (!n) return;
    const sel = $('mdDevice'); // "Play on" follows the Echo the mood is playing on
    if (sel && [...sel.options].some((o) => o.value === n.serial)) sel.value = n.serial;
    box.dataset.a = n.accent[0]; box.dataset.b = n.accent[1];
    box.style.setProperty('--a', n.accent[0]); box.style.setProperty('--b', n.accent[1]);
    box.innerHTML = `<span class="mn-em" aria-hidden="true">${icon(n.icon || 'music')}</span>
      <div class="mn-meta"><span class="label">Playing on ${esc(n.device)}</span><b>${esc(n.name)}</b>
        <span class="muted small">${n.layer === 'frequency' ? `${icon('wave', 'sm')} Healing frequency · ` : ''}“${esc(n.phrase || '')}”${n.tracks ? ` · track ${n.tracks}` : ''}</span>
        <span class="small mn-sleep" id="mnSleep"></span></div>
      <span class="eqbars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div class="mn-ctl">
        <button type="button" class="btn icon round" data-mn="track" aria-label="Next track" title="Next track">${icon('next')}</button>
        <button type="button" class="btn sm" data-mn="mix" title="Another search phrase for this mood">${icon('refresh', 'sm')}New mix</button>
        <button type="button" class="btn sm" data-mn="change">Change mood</button>
        <button type="button" class="btn sm danger-ghost" data-mn="stop">${icon('stop', 'sm')}Stop</button>
      </div>`;
    tickSleep();
  }
  function tickSleep() {
    const el = $('mnSleep'); if (!el) return;
    const left = S.now?.sleepAt ? Math.ceil((S.now.sleepAt - Date.now()) / 60000) : 0;
    el.innerHTML = left > 0 ? `${icon('sleep', 'sm')} Sleeps in ${left} min` : '';
  }
  setInterval(tickSleep, 15000);

  // The mood's colours tint the page background while it plays (Settings: off)
  function ambience() {
    const on = !!S.now && S.data?.prefs?.ambience !== false;
    root.classList.toggle('mood-on', on);
    root.style.setProperty('--mood-a', on ? S.now.accent[0] : '');
    root.style.setProperty('--mood-b', on ? S.now.accent[1] : '');
  }

  // ---------- live ----------
  // The play sheet waiting on /moods/play. The reply comes only after every step, and Amazon's "rate exceeded" retry
  // can hold any of them ~45 s. 'phrase' is sent just before the play command and 'start' once it played, so the
  // sheet closes on the first of those (or the reply); the server carries on either way.
  let pendingPlay = null;
  window.onMoodEvent = (d) => {
    S.now = d.active ? d : null;
    if (['phrase', 'start'].includes(d.event) && d.active && pendingPlay?.moodId === d.moodId && pendingPlay.serial === d.serial) { pendingPlay.close(); pendingPlay = null; }
    if (d.event === 'start' && d.active) UI.toast(d.name, `Playing on ${d.device}`);
    if (d.event === 'stop' && d.error) UI.toast(`${d.name || 'Mood'} stopped`, d.error, true);
    renderNow(); ambience();
  };

  // ---------- play sheet ----------
  function playSheet(m) {
    const s = S.data, last = s.last?.moodId === m.id ? s.last.opts : {};
    const o = {
      device: S.now?.serial || $('mdDevice')?.value || musicTarget(), intensity: last.intensity || m.energy, language: last.language || s.prefs.language,
      vocals: last.vocals || m.vocals, layer: 'frequencyLayer' in last ? last.frequencyLayer : m.frequencyLayer,
      volume: last.volume ?? m.defaultVolume, sleep: 'sleepMinutes' in last ? last.sleepMinutes || 0 : m.defaultSleepMinutes || 0,
    };
    const safe = S.presets.filter((p) => !p.headphonesOnly), hp = S.presets.filter((p) => p.headphonesOnly);
    const sleeps = [...new Set([...SLEEP, o.sleep])].sort((a, b) => a - b);
    const chip = (name, v, label, cur) => `<button type="button" class="chip" data-${name}="${esc(v)}" aria-pressed="${String(v) === String(cur)}">${label}</button>`;
    const body = document.createElement('form');
    body.className = 'mood-form';
    body.innerHTML = `
      <p class="muted">${esc(m.description || '')}</p>
      <div class="mf-row"><span class="label">Play on</span><div class="chips">${playable().map((d) => chip('dev', d.serial, `${d.family === 'WHA' ? icon('group', 'sm') : icon('speaker', 'sm')}${esc(d.name)}`, o.device)).join('')}</div></div>
      <div class="mf-row"><span class="label">Intensity <b class="mf-val" id="mfIntV">${ENERGY[o.intensity]}</b></span>
        <input type="range" class="slider" id="mfInt" min="1" max="5" step="1" value="${o.intensity}" aria-label="Intensity, calm to energetic" /></div>
      <div class="mf-row"><span class="label">Language</span><div class="chips">${[...(s.mixes || []), ...s.languages].map((l) => chip('lang', l.id, esc(l.name), o.language)).join('')}</div></div>
      <div class="mf-row"><span class="label">Vocals</span><span class="seg" role="group" aria-label="Vocals">${[['instrumental', 'Instrumental'], ['light', 'Light vocals'], ['any', 'Any']]
        .map(([v, t]) => `<button type="button" data-voc="${v}" class="${v === o.vocals ? 'cur' : ''}" aria-pressed="${v === o.vocals}">${t}</button>`).join('')}</span></div>
      <div class="mf-row"><div class="setrow"><span>Healing frequency<small>Mixed in every few tracks${m.frequencyRatio === 0 ? ' (all of it, for this mood)' : ''}</small></span>
        <label class="switch"><input type="checkbox" id="mfLayerOn" ${o.layer ? 'checked' : ''} aria-label="Healing frequency" /><span></span></label></div>
        <select class="input" id="mfLayer" aria-label="Frequency" ${o.layer ? '' : 'disabled'}>${safe.map((p) => `<option value="${esc(p.id)}" ${p.id === (o.layer || m.frequencyLayer || 'alpha') ? 'selected' : ''}>${esc(p.name)}${p.hz ? ` · ${esc(String(p.hz))} Hz` : ''} · ${esc(p.summary)}</option>`).join('')}
          <optgroup label="Headphones only (not on an Echo)">${hp.map((p) => `<option disabled>${esc(p.name)}</option>`).join('')}</optgroup></select>
        <p class="muted small mf-hint">${icon('headphones', 'sm')} Binaural beats need headphones; Echo speakers get isochronic tones, 432 / 528 Hz music, Solfeggio, bowls or Om.</p></div>
      <div class="mf-row"><span class="label">Volume <b class="mf-val" id="mfVolV">${o.volume}</b></span>
        <input type="range" class="slider" id="mfVol" min="0" max="10" step="1" value="${o.volume}" aria-label="Volume" /></div>
      <div class="mf-row"><span class="label">Sleep timer</span><div class="chips">${sleeps.map((v) => chip('sleep', v, v ? `${v} min` : 'Off', o.sleep)).join('')}</div></div>
      <div class="sheet-foot"><button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn primary" id="mfPlay">${icon('play', 'sm')}Play ${esc(m.name)}</button></div>`;
    const sh = UI.sheet(body, { title: m.name });
    const pick = (attr, el) => { body.querySelectorAll(`[data-${attr}]`).forEach((b) => b.setAttribute('aria-pressed', b === el)); };
    body.addEventListener('click', (e) => {
      const c = e.target.closest('[data-dev], [data-lang], [data-sleep]');
      if (c) { const a = ['dev', 'lang', 'sleep'].find((k) => c.dataset[k] != null); pick(a, c); }
      const v = e.target.closest('[data-voc]');
      if (v) body.querySelectorAll('[data-voc]').forEach((b) => { b.classList.toggle('cur', b === v); b.setAttribute('aria-pressed', b === v); });
    });
    body.querySelector('#mfInt').oninput = (e) => { body.querySelector('#mfIntV').textContent = ENERGY[e.target.value]; };
    body.querySelector('#mfVol').oninput = (e) => { body.querySelector('#mfVolV').textContent = e.target.value; };
    body.querySelector('#mfLayerOn').onchange = (e) => { body.querySelector('#mfLayer').disabled = !e.target.checked; };
    body.onsubmit = async (e) => {
      e.preventDefault();
      const val = (a) => body.querySelector(`[data-${a}][aria-pressed="true"]`)?.dataset[a];
      const req = {
        device: val('dev'), moodId: m.id, intensity: +body.querySelector('#mfInt').value, language: val('lang'),
        vocals: body.querySelector('[data-voc].cur')?.dataset.voc, volume: +body.querySelector('#mfVol').value,
        frequencyLayer: body.querySelector('#mfLayerOn').checked ? body.querySelector('#mfLayer').value : null, sleepMinutes: +val('sleep') || 0,
      };
      const btn = body.querySelector('#mfPlay');
      btn.classList.add('busy'); btn.disabled = true;
      pendingPlay = { moodId: m.id, serial: req.device, close: () => sh.close() };
      const slow = setTimeout(() => {
        const p = document.createElement('p');
        p.className = 'muted small mf-slow'; p.setAttribute('role', 'status');
        p.textContent = 'Alexa is taking a while (when Amazon is busy it retries within a minute). You can close this: it keeps going.';
        body.querySelector('.sheet-foot').before(p);
        p.scrollIntoView({ block: 'nearest', behavior: UI.reduced() ? 'auto' : 'smooth' });
      }, 4000);
      try {
        const r = await api('/moods/play', req);
        if (r.superseded || r.stopped) { sh.close(); return; } // replaced by another play, or stopped before it started
        S.now = r.now; S.data.last = { moodId: m.id, opts: r.now.opts };
        sh.close(); renderNow(); ambience();
        if ($('mDevice') && [...$('mDevice').options].some((x) => x.value === req.device)) $('mDevice').value = req.device; // the music card follows
        setTimeout(refreshNow, 4000);
      } catch (err) { UI.toast(`Couldn't start ${m.name}`, err.message, true); btn.classList.remove('busy'); btn.disabled = false; }
      finally { clearTimeout(slow); body.querySelector('.mf-slow')?.remove(); if (pendingPlay?.moodId === m.id) pendingPlay = null; }
    };
  }

  // ---------- edit sheet ----------
  function editSheet(m) {
    const d = S.data, isNew = !m;
    m = m || { name: '', icon: 'music', group: 'relax', description: '', energy: 3, vocals: 'any', defaultVolume: 3, defaultSleepMinutes: null, accent: ['#2cc3f0', '#3b4bd8'], frequencyLayer: null, phrases: {}, timeOfDay: [], days: 'any' };
    const body = document.createElement('form');
    body.className = 'mood-form';
    body.innerHTML = `
      <div class="mf-grid">
        <label class="field"><span>Name</span><input id="meName" maxlength="40" required value="${esc(m.name)}" /></label>
        <label class="field"><span>Group</span><select id="meGroup">${d.groups.map((g) => `<option value="${g.id}" ${g.id === m.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Vocals</span><select id="meVoc">${[['instrumental', 'Instrumental'], ['light', 'Light vocals'], ['any', 'Any']].map(([v, t]) => `<option value="${v}" ${v === m.vocals ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field mf-wide"><span>Description</span><input id="meDesc" maxlength="120" value="${esc(m.description || '')}" /></label>
        <label class="field"><span>Energy (1-5)</span><input id="meEnergy" type="number" min="1" max="5" value="${m.energy}" /></label>
        <label class="field"><span>Volume (0-10)</span><input id="meVol" type="number" min="0" max="10" value="${m.defaultVolume}" /></label>
        <label class="field"><span>Sleep after (min, empty = off)</span><input id="meSleep" type="number" min="0" max="600" value="${m.defaultSleepMinutes ?? ''}" /></label>
        <label class="field"><span>Healing frequency</span><select id="meLayer"><option value="">None</option>${S.presets.filter((p) => !p.headphonesOnly).map((p) => `<option value="${p.id}" ${p.id === m.frequencyLayer ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Colour 1</span><input id="meA" type="color" value="${esc(m.accent[0])}" /></label>
        <label class="field"><span>Colour 2</span><input id="meB" type="color" value="${esc(m.accent[1])}" /></label>
        <div class="field mf-wide"><span id="meIconL">Icon</span><div class="icon-pick" id="meIcon" role="radiogroup" aria-labelledby="meIconL">${d.icons.map((i) =>
          `<button type="button" role="radio" data-icon="${esc(i)}" aria-checked="${i === (m.icon || 'music')}" aria-label="${esc(i.replace(/-/g, ' '))}" title="${esc(i.replace(/-/g, ' '))}">${icon(i)}</button>`).join('')}</div></div>
      </div>
      <p class="label mf-ph">Search phrases, one per line <span class="muted">(artist, song, album or playlist names: Apple Music can't find descriptions like “happy songs”; add “|4” for a livelier one)</span></p>
      <div class="mf-grid">${d.languages.map((l) => `<label class="field"><span>${esc(l.name)}</span><textarea class="input" data-lang="${l.id}" rows="4">${esc((m.phrases[l.id] || []).join('\n'))}</textarea></label>`).join('')}</div>
      <div class="sheet-foot">${!isNew && m.builtIn && m.edited ? '<button type="button" class="btn quiet" id="meReset">Reset to built-in</button><span class="spacer"></span>' : ''}
        <button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${isNew ? 'Add mood' : 'Save'}</button></div>`;
    const sh = UI.sheet(body, { title: isNew ? 'New mood' : `Edit ${m.name}`, wide: true });
    const q = (id) => body.querySelector('#' + id);
    q('meIcon').onclick = (e) => { const b = e.target.closest('[data-icon]'); if (b) q('meIcon').querySelectorAll('[data-icon]').forEach((x) => x.setAttribute('aria-checked', x === b)); };
    if (q('meReset')) q('meReset').onclick = async () => { try { S.data = await api('/moods/reset', { id: m.id }); sh.close(); render(); } catch (err) { UI.toast('Reset', err.message, true); } };
    body.onsubmit = async (e) => {
      e.preventDefault();
      const phrases = {};
      body.querySelectorAll('textarea[data-lang]').forEach((t) => { phrases[t.dataset.lang] = t.value.split('\n').map((x) => x.trim()).filter(Boolean); });
      const mood = {
        id: isNew ? undefined : m.id, name: q('meName').value, icon: q('meIcon').querySelector('[aria-checked="true"]')?.dataset.icon, group: q('meGroup').value, vocals: q('meVoc').value,
        description: q('meDesc').value, energy: +q('meEnergy').value, defaultVolume: +q('meVol').value, defaultSleepMinutes: q('meSleep').value === '' ? null : +q('meSleep').value,
        frequencyLayer: q('meLayer').value || null, accent: [q('meA').value, q('meB').value], phrases, timeOfDay: m.timeOfDay, days: m.days,
      };
      try { await api('/moods', { mood }); sh.close(); await load(); UI.toast(isNew ? 'Mood added' : 'Mood saved', mood.name); }
      catch (err) { UI.toast('Couldn\'t save', err.message, true); }
    };
  }

  // ---------- info sheet ----------
  function infoSheet() {
    const body = document.createElement('div');
    body.innerHTML = `
      <p>Each mood is a set of search phrases. Echo Volume asks Alexa to play one on Apple Music, lets that mix play for a few
        tracks, then moves to another, so it never runs out. <b>Alexa plays by search phrase, so what you hear can vary.</b></p>
      <p class="muted small mf-p">It learns as you go: a mix you skip within 20 seconds comes up less, one you listen to or whose song you star comes up more.
        Mixes from the last 3 days are left out while there are others.</p>
      <h3 class="mf-h">Healing frequencies</h3>
      <div class="freq-list">${S.presets.map((p) => `<div class="freq"><b>${esc(p.name)}</b>${p.hz ? `<span class="badge neutral">${esc(String(p.hz))} Hz</span>` : ''}
        ${p.headphonesOnly ? `<span class="badge warn">${icon('headphones')}Headphones only</span>` : ''}<span class="muted small">${esc(p.summary)}</span></div>`).join('')}</div>
      <p class="muted small mf-p">${icon('headphones', 'sm')} ${esc(S.help)}</p>
      <div class="setrow"><span>Mood colours in the background<small>The page takes on the mood's colours while it plays</small></span>
        <label class="switch"><input type="checkbox" id="mfAmb" ${S.data?.prefs?.ambience !== false ? 'checked' : ''} aria-label="Mood colours in the background" /><span></span></label></div>`;
    UI.sheet(body, { title: 'About moods', wide: true });
    body.querySelector('#mfAmb').onchange = async (e) => {
      try { S.data.prefs = await api('/moods/prefs', { ambience: e.target.checked }); ambience(); } catch (err) { UI.toast('Settings', err.message, true); }
    };
  }

  // ---------- clicks ----------
  $('moodsTab').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.play) return playSheet(moodById(b.dataset.play));
    if (b.dataset.fav) {
      const m = moodById(b.dataset.fav);
      try { const r = await api('/moods/favorite', { moodId: m.id, on: !m.favorite }); S.data.favorites = r.favorites; S.data.moods.forEach((x) => { x.favorite = r.favorites.includes(x.id); }); render(); }
      catch (err) { UI.toast('Favourite', err.message, true); }
      return;
    }
    if (b.dataset.edit) return editSheet(moodById(b.dataset.edit));
    if (b.dataset.del) {
      const m = moodById(b.dataset.del);
      if (!(await UI.confirm(`Delete the mood “${m.name}”?${m.builtIn ? ' Built-in moods can be brought back with Reset built-ins.' : ''}`, { ok: 'Delete', danger: true }))) return;
      try { await api(`/moods/${enc(m.id)}/delete`, {}); await load(); } catch (err) { UI.toast('Delete', err.message, true); }
      return;
    }
    if (b.id === 'mdEdit') { S.edit = !S.edit; return render(); }
    if (b.id === 'mdAdd') return editSheet(null);
    if (b.id === 'mdInfo') return infoSheet();
    if (b.id === 'mdReset') {
      if (!(await UI.confirm('Put every built-in mood back as it was? Your own moods stay.', { ok: 'Reset' }))) return;
      try { S.data = await api('/moods/reset', {}); render(); } catch (err) { UI.toast('Reset', err.message, true); }
      return;
    }
    const mn = b.dataset.mn;
    if (!mn) return;
    try {
      if (mn === 'track') await api('/music/next', { device: S.now.serial });
      if (mn === 'mix') { b.classList.add('busy'); const r = await api('/moods/next', {}); S.now = r.now || S.now; renderNow(); }
      if (mn === 'stop') { await api('/moods/stop', {}); S.now = null; renderNow(); ambience(); }
      if (mn === 'change') document.querySelector('#moodsTab .mood-sec')?.scrollIntoView({ behavior: UI.reduced() ? 'auto' : 'smooth' });
    } catch (err) { UI.toast('Mood', err.message, true); b.classList.remove('busy'); }
  });

  document.addEventListener('devices', () => { if (S.loaded) render(); });
  window.tabLoaders.moods = load;
  if (document.querySelector('#tabs .cur')?.dataset.tab === 'moods') load(); // opened on Moods (before this loaded)
  // The background follows a mood started anywhere (tray, a scene, another device) from the start
  Promise.all([api('/moods/now'), api('/moods')]).then(([n, d]) => { S.now = n.active ? n : null; if (!S.data) S.data = d; ambience(); }).catch(() => {});
})();
