// Echo Volume: the countdown card in the bottom-right corner, for the last seconds before a timer, alarm or
// reminder ends, and then while it rings. Used by the app (extras.js gives it the alarms & timers list) and by the
// desktop app's corner window (countdown.html, shown over other windows while the app is hidden or in the back).
//
//   const cd = Countdown.create({ api, lead: 20, onChange(count, heightPx) {} });
//   cd.update(alerts); // the /api/alerts list, its "at" times already on this device's clock
//   cd.setLead(seconds); // 0 = off
//
// Fixed to the window (not the page), so scrolling never moves it. Each card: a ring that drains as the seconds go,
// the name, where it rings, and Cancel (one that doesn't repeat: a timer, a one-time alarm or reminder); once it
// rings, Stop (on that Echo). ✕ dismisses it here only.
(function () {
  const RING_MS = 90000; // how long a card stays up once it rings (unless stopped or dismissed)
  const GONE_MS = 3000; // gone from the list this long after it rang: stopped on the Echo, so the card goes too
  const R = 21, C = 2 * Math.PI * R;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n) => (window.UI?.icon ? window.UI.icon(n, 'sm') : '');
  const time12 = (hhmm) => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  };
  const title = (a) => (a.type === 'timer' ? (a.label ? `${a.label} timer` : 'Timer')
    : a.type === 'alarm' ? (a.label || `Alarm ${time12(a.time)}`.trim()) : (a.label || 'Reminder'));
  const canStop = (a) => a.deviceName !== 'Alexa app';

  function create({ api, lead = 20, onChange = () => {} }) {
    let leadMs = lead * 1000, list = [], wake = null, tick = null;
    const cards = new Map(); // alert id → { a, el, phase, busy }
    // Dismissed here: id → the end time it had (a timer's end time moves a second or so between refreshes; a
    // repeating alarm's next ring is a day or more later, and gets its own card)
    const dismissed = new Map();
    const isDismissed = (a) => dismissed.has(a.id) && Math.abs(dismissed.get(a.id) - a.at) < 60000;
    const dismiss = (k) => { const c = cards.get(k); if (c) dismissed.set(k, c.a.at); };

    const stack = document.createElement('div');
    stack.className = 'cd-stack';
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'Ending soon');
    const live = document.createElement('div'); // said once per card (appears, starts ringing), not every second
    live.className = 'cd-sr'; live.setAttribute('aria-live', 'assertive');
    stack.append(live);
    document.body.append(stack);

    stack.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const k = b.closest('.cd-card')?.dataset.key, c = cards.get(k); if (!c || c.busy) return;
      const { a } = c, act = b.dataset.act;
      if (act === 'dismiss') { dismiss(k); return remove(k); }
      c.busy = true; b.disabled = true;
      try {
        if (act === 'stop') await api('/alerts/stop', { device: a.device });
        else if (a.type === 'alarm') await api('/alerts/toggle', { id: a.id, on: false }); // a one-time alarm: off, still in the list
        else await api('/alerts/delete', { id: a.id });
        dismiss(k); remove(k);
      } catch (err) {
        c.busy = false; b.disabled = false;
        const s = c.el.querySelector('.cd-sub'); if (s) { s.textContent = err.message || 'Didn\'t work'; s.classList.add('err'); }
      }
    });

    function card(k, a) {
      const el = document.createElement('div');
      el.className = `cd-card cd-${a.type}`;
      el.dataset.key = k;
      el.innerHTML = `
        <div class="cd-ring" aria-hidden="true">
          <svg viewBox="0 0 48 48"><circle class="cd-trk" cx="24" cy="24" r="${R}"/><circle class="cd-arc" cx="24" cy="24" r="${R}" stroke-dasharray="${C.toFixed(2)}"/></svg>
          <span class="cd-num"></span><span class="cd-bell">${icon(a.type === 'timer' ? 'timer' : a.type === 'alarm' ? 'alarm' : 'bell')}</span>
        </div>
        <div class="cd-body">
          <div class="cd-title">${esc(title(a))}</div>
          <div class="cd-sub"></div>
          <div class="cd-act"></div>
        </div>
        <button type="button" class="cd-x" data-act="dismiss" aria-label="Dismiss">${icon('close') || '×'}</button>`;
      return el;
    }
    function setPhase(c, phase) {
      if (c.phase === phase) return;
      c.phase = phase;
      const { a, el } = c;
      el.dataset.phase = phase;
      const sub = el.querySelector('.cd-sub');
      sub.classList.remove('err');
      sub.textContent = phase === 'ringing' ? `Ringing on ${a.deviceName}` : `${a.type === 'timer' ? 'Ends' : 'Rings'} on ${a.deviceName}`;
      const btns = phase === 'ringing'
        ? (canStop(a) ? `<button type="button" class="btn sm danger" data-act="stop">${icon('stop')}Stop</button>` : '')
        : (!a.repeating ? `<button type="button" class="btn sm" data-act="cancel">Cancel</button>` : '');
      el.querySelector('.cd-act').innerHTML = btns;
      live.textContent = phase === 'ringing' ? `${title(a)} ringing on ${a.deviceName}` : `${title(a)} ${a.type === 'timer' ? 'ends' : 'rings'} in ${Math.ceil((a.at - Date.now()) / 1000)} seconds`;
    }
    function draw(c, now) {
      const left = c.a.at - now;
      setPhase(c, left > 0 ? 'ending' : 'ringing');
      const frac = left > 0 ? Math.max(0, Math.min(1, left / leadMs)) : 1;
      c.el.querySelector('.cd-arc').style.strokeDashoffset = (C * (1 - frac)).toFixed(2);
      const s = Math.max(0, Math.ceil(left / 1000));
      c.el.querySelector('.cd-num').textContent = s;
      c.el.classList.toggle('warn', left > 0 && s <= 10 && s > 5);
      c.el.classList.toggle('hot', left > 0 && s <= 5);
    }
    function remove(k) {
      const c = cards.get(k); if (!c) return;
      cards.delete(k);
      c.el.classList.add('out');
      setTimeout(() => { c.el.remove(); changed(); }, 220);
      changed();
    }
    function changed() {
      document.documentElement.classList.toggle('cd-on', cards.size > 0);
      const h = cards.size ? Math.ceil(stack.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--cd-h', `${h}px`);
      onChange(cards.size, h);
    }

    // Which alerts get a card now, and when to look next
    function run() {
      clearTimeout(wake); wake = null;
      const now = Date.now();
      const want = new Map();
      if (leadMs > 0) {
        for (const a of list) {
          if (a.status !== 'ON' || !a.at) continue;
          if (!isDismissed(a) && now >= a.at - leadMs && now < a.at + RING_MS) want.set(a.id, a);
        }
      }
      for (const [k, c] of cards) {
        const w = want.get(k);
        if (w && Math.abs(w.at - c.a.at) < 60000) { c.a = w; continue; }
        if (w) { remove(k); continue; } // the same alarm's next ring: a fresh card below
        const rang = now >= c.a.at, inList = list.some((x) => x.id === k && x.status === 'ON');
        // Kept while it rings even when Amazon has already dropped it from the list, unless that was a while
        // after it rang (stopped on the Echo); before it rings, gone from the list = cancelled elsewhere
        if (leadMs > 0 && rang && now < c.a.at + RING_MS && (inList || now - c.a.at < GONE_MS)) continue;
        remove(k);
      }
      for (const [k, a] of want) {
        if (cards.has(k) && !cards.get(k).el.classList.contains('out')) continue;
        const c = { a, el: card(k, a), phase: null, busy: false };
        cards.set(k, c);
        stack.append(c.el);
      }
      for (const c of cards.values()) draw(c, now);
      changed();
      if (cards.size) { if (!tick) tick = setInterval(run, 250); return; }
      clearInterval(tick); tick = null;
      // Nothing showing: wake up when the next one comes within reach (checked again at least every 10 minutes)
      const next = Math.min(...list.filter((a) => a.status === 'ON' && a.at && a.at - leadMs > now).map((a) => a.at - leadMs));
      if (leadMs > 0 && Number.isFinite(next)) wake = setTimeout(run, Math.min(next - now + 50, 600000));
    }

    return {
      update(alerts) { list = Array.isArray(alerts) ? alerts : []; run(); },
      setLead(seconds) { leadMs = Math.max(0, Number(seconds) || 0) * 1000; run(); },
      get count() { return cards.size; },
    };
  }

  window.Countdown = { create };
})();
