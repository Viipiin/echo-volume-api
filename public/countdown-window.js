// The desktop app's corner window (countdown.html): reads the alarms & timers list, keeps it fresh from the live
// updates, and lets countdown.js count down. Reports to desktop/main.js through the page title (see countdown.html).
(function () {
  const key = new URLSearchParams(location.search).get('key') || '';
  const api = (url, body) => fetch('/api' + url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-ev-client': 'app', ...(key && { 'x-api-key': key }) },
    body: body && JSON.stringify(body),
  }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });

  const cd = Countdown.create({ api, onChange: (n, h) => { document.title = `cd:${n}:${h}`; } });
  const theme = () => api('/ui').then((s) => {
    if (['light', 'dark', 'midnight'].includes(s.theme)) document.documentElement.dataset.theme = s.theme;
    else delete document.documentElement.dataset.theme;
  }).catch(() => {});
  const lead = () => api('/notify').then((n) => cd.setLead(n.countdown ?? 20)).catch(() => {});
  let loading = null;
  const load = () => (loading ||= api('/alerts').then((r) => {
    const skew = Date.now() - r.now; // the server's clock vs this one (the same PC, but kept like the app does)
    cd.update(r.alerts.map((a) => ({ ...a, at: a.at && a.at + skew })));
  }).catch(() => {}).finally(() => { loading = null; }));

  theme(); lead(); load();
  const es = new EventSource('/api/events' + (key ? `?key=${encodeURIComponent(key)}` : ''));
  es.addEventListener('alerts', load);
  es.addEventListener('theme', theme);
  // The app wakes this window (desktop/main.js) just before something ends: look again then
  window.wake = () => { lead(); load(); };
})();
