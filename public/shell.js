// Echo Volume main page shell: screen transitions, the phone tab bar (+ More), the desktop title bar, the background
// pausing while the page is hidden, and broken artwork. Loaded last; extras.js owns the tabs (showTab, 'tabchange').
(() => {
  const root = document.documentElement;
  const BAR_TABS = ['home', 'moods', 'timers', 'scenes'];
  const label = (tab) => document.querySelector(`#tabs [data-tab="${tab}"] .l`)?.textContent || '';

  function onTab(tab, animate) {
    const sec = document.querySelector(`section.tab[data-tab="${tab}"]`);
    if (sec && animate && !UI.reduced()) { sec.classList.remove('screen-in'); void sec.offsetWidth; sec.classList.add('screen-in'); }
    document.querySelectorAll('#tabbar [data-tab]').forEach((b) => b.classList.toggle('cur', b.dataset.tab === tab));
    document.querySelector('#tabbar [data-more]').classList.toggle('cur', !BAR_TABS.includes(tab));
    $('tbPage').textContent = label(tab);
    document.title = tab === 'home' ? 'Echo Volume' : `${label(tab)} · Echo Volume`;
  }
  document.addEventListener('tabchange', (e) => onTab(e.detail, true));
  onTab(document.querySelector('#tabs .cur')?.dataset.tab || 'home', false); // the tab opened before this loaded

  // Phone tab bar: four tabs, the rest under More
  $('tabbar').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tab) return showTab(b.dataset.tab);
    const cur = document.querySelector('#tabs .cur')?.dataset.tab;
    const icons = { lists: 'list', alexa: 'alexa', smarthome: 'bulb', activity: 'activity', settings: 'settings' };
    const t = await UI.menu(b, Object.keys(icons).map((tab) => ({ value: tab, label: label(tab), icon: icons[tab], checked: tab === cur })));
    if (t) showTab(t);
  });

  // The slow background drift stops while nobody can see it (hidden tab, minimized or hidden window)
  const pause = () => root.classList.toggle('is-paused', document.hidden);
  document.addEventListener('visibilitychange', pause); pause();

  // Desktop app: the title bar dims while the window isn't focused, like Windows' own
  if (root.classList.contains('app')) {
    const dim = () => $('titlebar').classList.toggle('blur', !document.hasFocus());
    addEventListener('focus', dim); addEventListener('blur', dim); dim();
  }

  // Artwork that fails to load is removed, so the cover's letter shows (no inline onerror under the CSP)
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.cover')) e.target.remove(); }, true);
})();
