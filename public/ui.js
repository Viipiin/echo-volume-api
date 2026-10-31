// Echo Volume: behaviour for the components in ui.css, shared by every page as window.UI.
// Sliders show their fill, sheets trap focus and close on Esc, confirm() is a themed sheet, toasts and popover menus.
// No page logic here: shell.js (main page) and each page's own script use these.
(() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="/icons.svg#${esc(name)}"/></svg>`;

  // ---------- range sliders: the filled part of the track follows the value (also when code sets .value) ----------
  function fill(el) {
    if (el?.type !== 'range') return;
    const min = el.min === '' ? 0 : +el.min, max = el.max === '' ? 100 : +el.max;
    el.style.setProperty('--val', `${max > min ? ((+el.value - min) / (max - min)) * 100 : 0}%`);
  }
  const valueProp = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    ...valueProp,
    set(v) { valueProp.set.call(this, v); if (this.type === 'range') fill(this); },
  });
  document.addEventListener('input', (e) => fill(e.target), true);
  const fillAll = (root = document) => root.querySelectorAll('input[type=range]').forEach(fill);
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) (n.matches('input[type=range]') ? fill(n) : fillAll(n));
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') fillAll(); else document.addEventListener('DOMContentLoaded', () => fillAll());

  // ---------- toasts ----------
  function toast(title, body, err) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.setAttribute('role', err ? 'alert' : 'status');
    t.innerHTML = `<div><b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}</div>`;
    box.append(t);
    setTimeout(() => t.classList.add('out'), 4500);
    setTimeout(() => t.remove(), 5000);
    return t;
  }

  // ---------- sheets: modal, focus trapped, Esc / scrim click close, the rest of the page inert ----------
  // content: an element or an HTML string. Returns { el (the .sheet), close(value), done: Promise<value> }.
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function sheet(content, { title = '', wide = false, label } = {}) {
    const before = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" ${title ? 'aria-labelledby="sheetTitle"' : `aria-label="${esc(label || 'Dialog')}"`}>
      ${title ? `<div class="sheet-head"><h2 id="sheetTitle" tabindex="-1">${esc(title)}</h2><button type="button" class="btn icon quiet round" data-close aria-label="Close">${icon('close')}</button></div>` : ''}
      <div class="sheet-body"></div></div>`;
    const el = scrim.firstElementChild, body = el.querySelector('.sheet-body');
    if (typeof content === 'string') body.innerHTML = content; else if (content) body.append(content);
    const others = [...document.body.children].filter((c) => c !== scrim && !c.inert);
    let resolve, closed = false;
    const done = new Promise((r) => { resolve = r; });
    function close(value = null) {
      if (closed) return; closed = true;
      others.forEach((c) => { c.inert = false; });
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.remove('open');
      setTimeout(() => scrim.remove(), reduced() ? 0 : 320);
      before?.focus?.({ preventScroll: true });
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });
    el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    others.forEach((c) => { c.inert = true; });
    requestAnimationFrame(() => {
      scrim.classList.add('open');
      (el.querySelector('[autofocus]') || el.querySelector('.sheet-body ' + FOCUSABLE) || el.querySelector('h2') || el).focus({ preventScroll: true });
    });
    return { el, close, done };
  }

  // A themed replacement for window.confirm(): resolves true / false
  function confirm(message, { ok = 'OK', cancel = 'Cancel', danger = false, title = '' } = {}) {
    const s = sheet(`<p>${esc(message)}</p><div class="sheet-foot">
      <button type="button" class="btn" data-v="0">${esc(cancel)}</button>
      <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-v="1" autofocus>${esc(ok)}</button></div>`, { title, label: message });
    s.el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) s.close(b.dataset.v === '1'); });
    return s.done.then((v) => v === true);
  }

  // ---------- popover menu next to a button: items [{ label, value, icon, checked }] → Promise<value|null> ----------
  function menu(anchor, items) {
    document.querySelectorAll('.popover').forEach((p) => p.remove());
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = items.map((it, i) => `<button type="button" role="menuitemradio" aria-checked="${!!it.checked}" data-i="${i}">
      ${it.icon ? icon(it.icon, 'sm') : ''}<span>${esc(it.label)}</span>${it.checked ? `<span class="spacer"></span>${icon('check', 'sm')}` : ''}</button>`).join('');
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
    return new Promise((resolve) => {
      const btns = [...pop.querySelectorAll('button')];
      const finish = (v) => { pop.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); anchor.focus({ preventScroll: true }); resolve(v); };
      const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) finish(null); };
      const key = (e) => {
        const i = btns.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      };
      pop.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) finish(items[+b.dataset.i].value); });
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', key, true);
      (btns.find((b) => b.getAttribute('aria-checked') === 'true') || btns[0])?.focus();
    });
  }

  window.UI = { esc, icon, fill, fillAll, toast, sheet, confirm, menu, reduced };
})();
