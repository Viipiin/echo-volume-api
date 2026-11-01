// Echo Volume: the Activity screen. What the app was asked to do, what it sent to Amazon and what happened
// (server.js + activity-log.js keep it, 30 days). Problems first: things that ran but didn't do what was meant
// ("I couldn't find…", nothing started), and failures. Updates live while open (server-sent "log" events).
(() => {
  const { esc, icon } = window.UI;
  const enc = encodeURIComponent;
  const SOURCES = { pc: 'This PC', phone: 'Phone', desktop: 'Desktop tray', api: 'API', scene: 'Scene', schedule: 'Schedule', mood: 'Mood', queue: 'Queue', amazon: 'Amazon', system: 'System' };
  const STATUS = { ok: ['OK', 'check'], problem: ['Problem', 'info'], failed: ['Failed', 'close'], running: ['Running', 'refresh'] };
  const S = { filter: 'issues', source: '', q: '', entries: [], open: new Set(), kids: {}, more: false, summary: null, amazon: null };
  try { S.filter = localStorage.getItem('actFilter') || 'issues'; } catch {}
  let qTimer = null;

  const keyQ = () => (typeof key !== 'undefined' && key ? `&key=${enc(key)}` : '');
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const day = (at) => {
    const d = new Date(at), t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((t - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  };
  const secs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
  const params = (before) => `?top=1&limit=60${S.filter === 'issues' ? '&status=issues' : ''}${S.source ? `&source=${enc(S.source)}` : ''}${S.q ? `&q=${enc(S.q)}` : ''}${before ? `&before=${before}` : ''}`;

  function shell() {
    $('activityTab').innerHTML = `
      <div class="card xcard act-head">
        <div class="top"><span class="name">Activity</span><span class="kind" id="actSum"></span></div>
        <p class="kind">Everything Echo Volume was asked to do, what it sent to Amazon and what happened, kept for 30 days.
          <b>Problem</b> means it ran but didn't do what was meant (Alexa said “I couldn't find…”, nothing started); <b>Failed</b> means an error.</p>
        <div class="act-gate" id="actGate"></div>
        <div class="act-filters">
          <span class="seg" role="group" aria-label="Show"><button type="button" data-f="issues">Problems</button><button type="button" data-f="all">All</button></span>
          <select id="actSource" aria-label="From">${['', ...Object.keys(SOURCES)].map((s) => `<option value="${s}">${s ? esc(SOURCES[s]) : 'From anywhere'}</option>`).join('')}</select>
          <input type="search" id="actQ" placeholder="Search: phrase, Echo, error…" aria-label="Search the activity" />
          <span class="spacer"></span>
          <a class="btn sm" id="actExport" download>${icon('arrow-down', 'sm')}Export</a>
          <button type="button" class="btn sm quiet" id="actClear">${icon('trash', 'sm')}Clear</button>
        </div>
      </div>
      <div class="card xcard"><div class="alist act-list" id="actList"><div class="empty small">Loading…</div></div></div>
      <div class="card xcard">
        <details id="actReadsBox"><summary>Background reads from Amazon (last 24 hours)</summary>
          <p class="kind">Status checks the pages and the server make (what's playing, volumes…), counted per endpoint. “Shared” are requests answered by one already on its way.</p>
          <div id="actReads"><div class="empty small">Loading…</div></div></details>
      </div>`;
    $('activityTab').querySelector('.act-filters .seg').onclick = (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      S.filter = b.dataset.f; try { localStorage.setItem('actFilter', S.filter); } catch {}
      load();
    };
    $('actSource').onchange = (e) => { S.source = e.target.value; load(); };
    $('actQ').oninput = (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); load(); }, 300); };
    $('actExport').href = `/api/activity/export${keyQ().replace('&', '?')}`;
    $('actClear').onclick = async () => {
      if (!(await UI.confirm('Clear the whole activity log?', { ok: 'Clear', danger: true }))) return;
      try { await api('/activity/clear', {}); load(); } catch (err) { UI.toast('Activity', err.message, true); }
    };
    $('actReadsBox').ontoggle = () => { if ($('actReadsBox').open) loadReads(); };
    $('actList').onclick = onListClick;
  }

  async function load(more) {
    if (!$('actList')) shell();
    $('activityTab').querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('cur', b.dataset.f === S.filter));
    try {
      const before = more ? S.entries.at(-1)?.at : null;
      const r = await api('/activity' + params(before));
      S.entries = more ? S.entries.concat(r.entries) : r.entries;
      S.more = r.entries.length === 60;
      S.summary = r.summary; S.amazon = r.amazon;
      render();
      for (const id of S.open) loadKids(id);
    } catch (err) { $('actList').innerHTML = `<div class="empty small">${esc(err.message)}</div>`; }
  }

  function render() {
    const s = S.summary;
    if (s) $('actSum').innerHTML = `Last 24 h: ${s.total} · <span class="act-c problem">${s.problem} problem${s.problem === 1 ? '' : 's'}</span> · <span class="act-c failed">${s.failed} failed</span>${s.throttles ? ` · ${s.throttles} throttled` : ''}`;
    const a = S.amazon;
    if (a) {
      const slow = a.throttledUntil && a.throttledUntil > Date.now();
      $('actGate').className = 'act-gate' + (slow ? ' slow' : '');
      $('actGate').innerHTML = `${icon(slow ? 'info' : 'check', 'sm')}<span>Amazon requests: commands ${a.gapMs / 1000}s apart${slow ? `, slowed until ${time(a.throttledUntil)} (Amazon was throttling)` : ''}${a.waitingCommands ? ` · ${a.waitingCommands} waiting` : ''}</span>`;
    }
    if (!S.entries.length) {
      $('actList').innerHTML = `<div class="empty small">${S.filter === 'issues' ? 'No problems. Everything that ran did what it was meant to.' : 'Nothing yet.'}</div>`;
      return;
    }
    let last = '';
    $('actList').innerHTML = S.entries.map((e) => {
      const d = day(e.at), head = d !== last ? `<div class="act-day">${esc(d)}</div>` : '';
      last = d;
      return head + row(e);
    }).join('') + (S.more ? '<button type="button" class="btn sm more" data-more>Load older</button>' : '');
  }

  function row(e, child) {
    const [label, ic] = STATUS[e.status] || STATUS.ok;
    const open = S.open.has(e.id);
    const said = e.alexa?.said ? `<div class="act-said">Alexa: “${esc(e.alexa.said)}”</div>` : '';
    const firstNote = !open && e.status !== 'ok' && (e.error || e.notes?.at(-1)) ? `<div class="act-why">${esc(e.error || e.notes.at(-1))}</div>` : '';
    return `<div class="act-row ${esc(e.status)}${child ? ' child' : ''}${open ? ' open' : ''}" data-id="${esc(e.id)}">
      <button type="button" class="act-line" aria-expanded="${open}">
        <span class="act-st" title="${label}">${icon(ic, 'sm')}</span>
        <span class="act-main"><span class="act-title">${esc(e.title)}</span>
          <span class="act-sub">${time(e.at)} · ${esc(SOURCES[e.source] || e.source)}${e.device ? ` · ${esc(e.device)}` : ''}${e.ms != null ? ` · ${secs(e.ms)}` : ''}</span>
          ${said}${firstNote}</span>
        <span class="act-badge ${esc(e.status)}">${label}</span>
      </button>
      ${open ? details(e) : ''}
    </div>`;
  }

  function details(e) {
    const kids = S.kids[e.id];
    const bits = [];
    if (e.alexa) bits.push(`<div class="act-k">Alexa heard</div><div>“${esc(e.alexa.heard || '…')}”</div><div class="act-k">Alexa said</div><div>${e.alexa.said ? `“${esc(e.alexa.said)}”` : '<span class="muted">nothing (no spoken reply)</span>'}</div>`);
    if (e.error) bits.push(`<div class="act-k">Error</div><div class="act-err">${esc(e.error)}</div>`);
    if (e.notes?.length) bits.push(`<div class="act-k">What happened</div><div>${e.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>`);
    if (e.detail && Object.keys(e.detail).length) bits.push(`<div class="act-k">Asked</div><div class="act-kv">${kv(e.detail)}</div>`);
    if (e.result && Object.keys(e.result).length) bits.push(`<div class="act-k">Answer</div><div class="act-kv">${kv(e.result)}</div>`);
    if (e.calls?.length) {
      bits.push(`<div class="act-k">Sent to Amazon</div><div class="act-calls">${e.calls.map((c) => `<div class="act-call${c.error ? ' bad' : ''}">
        <span class="act-ck">${c.kind === 'command' ? 'Command' : c.shared ? 'Read (shared)' : 'Read'}</span><code>${esc(c.path)}</code>
        <span class="muted">${c.waited > 100 ? `waited ${secs(c.waited)} · ` : ''}${secs(c.ms)}</span>${c.error ? `<span class="act-err">${esc(c.error)}</span>` : ''}</div>`).join('')}
        ${e.moreCalls ? `<div class="muted">+${e.moreCalls} more</div>` : ''}</div>`);
    }
    const steps = kids === undefined ? '<div class="empty small">Loading steps…</div>'
      : kids.length ? `<div class="act-kids">${kids.map((k) => row(k, true)).join('')}</div>` : '';
    return `<div class="act-detail">${bits.length ? `<div class="act-grid">${bits.join('')}</div>` : ''}${steps}</div>`;
  }
  const kv = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== '' && v !== undefined)
    .map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`).join('');

  async function loadKids(id) {
    try {
      const r = await api(`/activity/${enc(id)}`);
      S.kids[id] = r.children;
      const idx = S.entries.findIndex((x) => x.id === id);
      if (idx >= 0) S.entries[idx] = r.entry;
    } catch { S.kids[id] = []; }
    if (!$('activityTab').closest('section').hidden) render();
  }

  function onListClick(e) {
    if (e.target.closest('[data-more]')) return load(true);
    const line = e.target.closest('.act-line'); if (!line) return;
    const id = line.closest('.act-row').dataset.id;
    if (S.open.has(id)) S.open.delete(id); else { S.open.add(id); if (!(id in S.kids)) loadKids(id); }
    render();
  }

  async function loadReads() {
    try {
      const buckets = await api('/activity/reads?hours=24');
      const by = {};
      for (const b of buckets) {
        const t = (by[b.path] ||= { path: b.path, count: 0, shared: 0, errors: 0, totalMs: 0, maxMs: 0 });
        t.count += b.count; t.shared += b.shared || 0; t.errors += b.errors; t.totalMs += b.totalMs; t.maxMs = Math.max(t.maxMs, b.maxMs);
      }
      const rows = Object.values(by).sort((a, b) => b.count - a.count);
      $('actReads').innerHTML = rows.length ? `<div class="act-reads"><div class="act-rh">Endpoint</div><div class="act-rh">Requests</div><div class="act-rh">Shared</div><div class="act-rh">Errors</div><div class="act-rh">Avg</div>
        ${rows.map((r) => `<code>${esc(r.path)}</code><div>${r.count}</div><div>${r.shared}</div><div class="${r.errors ? 'act-err' : ''}">${r.errors}</div><div>${secs(Math.round(r.totalMs / Math.max(1, r.count + r.shared)))}</div>`).join('')}</div>`
        : '<div class="empty small">No reads in the last 24 hours.</div>';
    } catch (err) { $('actReads').innerHTML = `<div class="empty small">${esc(err.message)}</div>`; }
  }

  // Live: entries added or changed while the screen is open. New top-level entries that fit the filter go on top;
  // changes to ones shown (or to steps of an open one) are redrawn.
  let liveTimer = null;
  window.onLogEvent = (d) => {
    if (!$('actList') || $('activityTab').closest('section').hidden) return;
    let redraw = false, reload = false;
    for (const e of d.entries || []) {
      const i = S.entries.findIndex((x) => x.id === e.id);
      if (i >= 0) { S.entries[i] = e; redraw = true; continue; }
      if (e.parent && S.kids[e.parent]) {
        const k = S.kids[e.parent].findIndex((x) => x.id === e.id);
        if (k >= 0) S.kids[e.parent][k] = e; else S.kids[e.parent].push(e);
        redraw = true; continue;
      }
      if (!e.parent) reload = true;
    }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => (reload ? load() : redraw && render()), reload ? 400 : 100);
  };

  window.tabLoaders.activity = load;
})();
