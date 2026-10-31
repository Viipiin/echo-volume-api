// Style guide: theme switcher (?theme= too, for screenshots), swatches, icon list, demos of sheets, menus and toasts
(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  function setTheme(t) {
    if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
    $('sgTheme').querySelectorAll('button').forEach((b) => b.classList.toggle('cur', b.dataset.t === t));
  }
  setTheme(new URLSearchParams(location.search).get('theme') || 'midnight');
  $('sgTheme').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) setTheme(b.dataset.t); };
  $('sgMood').onclick = () => {
    const on = root.classList.toggle('mood-on');
    root.style.setProperty('--mood-a', on ? '#a78bfa' : '');
    root.style.setProperty('--mood-b', on ? '#ff7ab6' : '');
    $('sgMood').classList.toggle('on', on);
  };

  // Mood tiles carry their gradient as data attributes (no inline styles under the CSP)
  document.querySelectorAll('.mood-tile').forEach((t) => { t.style.setProperty('--a', t.dataset.a); t.style.setProperty('--b', t.dataset.b); });

  const TOKENS = ['--bg', '--bg-2', '--surface-1', '--surface-2', '--surface-3', '--surface-solid', '--line', '--line-2', '--text', '--muted', '--faint',
    '--accent', '--accent-2', '--accent-ink', '--accent-tint', '--danger', '--ok', '--warn', '--blob-1', '--blob-2', '--blob-3'];
  $('sgSwatches').innerHTML = TOKENS.map((t) => `<div class="sg-swatch"><i data-c="${t}"></i><span>${t}</span></div>`).join('');
  $('sgSwatches').querySelectorAll('[data-c]').forEach((i) => i.style.setProperty('background', `var(${i.dataset.c})`));

  fetch('/icons.svg').then((r) => r.text()).then((svg) => {
    const ids = [...svg.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]).filter((id) => id !== 'logo');
    $('sgIcons').innerHTML = ids.map((id) => `<div>${UI.icon(id)}<span>${id}</span></div>`).join('');
  });

  // Progress demo: eases toward a target that changes every few seconds
  let p = 0.2;
  const tick = () => { p = p > 0.9 ? 0.1 : p + 0.23; $('sgRing').style.setProperty('--p', p); $('sgBar').style.setProperty('--p', `${Math.round(p * 100)}%`); };
  tick(); setInterval(tick, 2500);

  $('sgToast').onclick = () => UI.toast('Playing on Sonu', 'Study · lofi study beats');
  $('sgToastErr').onclick = () => UI.toast('Couldn\'t start', 'Apple Music didn\'t start on Sonu', true);
  $('sgConfirm').onclick = async () => UI.toast('Answer', String(await UI.confirm('Delete the scene “Movie time”?', { ok: 'Delete', danger: true })));
  $('sgMenu').onclick = async (e) => {
    const cur = root.dataset.theme || 'system';
    const v = await UI.menu(e.currentTarget, [['system', 'Auto (match Windows)', 'Light or Midnight, following Windows'], ['light', 'Light', 'Bright and airy'],
      ['dark', 'Dark', 'Flat graphite, no glow'], ['midnight', 'Midnight', 'Deep navy with a cyan glow']]
      .map(([value, label, hint]) => ({ value, label, hint, swatch: value, checked: value === cur })));
    if (v) setTheme(v);
  };
  $('sgSheet').onclick = () => {
    const s = UI.sheet(`<p class="muted">Play on</p><div class="chips"><button class="chip" aria-pressed="true">Sonu</button><button class="chip" aria-pressed="false">Show 8 Hallway</button></div>
      <p class="muted sg-gap">Intensity</p><input type="range" class="slider" min="1" max="5" value="2" aria-label="Intensity" />
      <div class="sheet-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-close>Play</button></div>`, { title: 'Study' });
    s.el.addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) c.parentElement.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x === c)); });
  };
})();
