// Echo Volume: the Connect SmartThings page (smartthings.html). Sign in once; the server refreshes the token after that.
const $ = (id) => document.getElementById(id);
const key = new URLSearchParams(location.search).get('key') || '';
const api = (url, body) => fetch('/api/st' + url, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(key && { 'x-api-key': key }) },
  body: body && JSON.stringify(body),
}).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
const status = (t, cls) => { $('status').textContent = t; $('status').className = 'status ' + (cls || ''); };
// Same theme as the main page (saved on the server)
fetch('/api/ui', { headers: key ? { 'x-api-key': key } : {} }).then((r) => r.json())
  .then((s) => { if (['light', 'dark', 'midnight'].includes(s.theme)) document.documentElement.dataset.theme = s.theme; }).catch(() => {});

// Accepts the httpbin JSON, the redirect URL, or the bare code
function extract(text) {
  text = text.trim();
  try { const j = JSON.parse(text); if (j.args?.code) return { code: j.args.code, state: j.args.state }; } catch {}
  const m = text.match(/[?&"]code"?\s*[=:]\s*"?([A-Za-z0-9_-]+)/);
  const s = text.match(/[?&"]state"?\s*[=:]\s*"?([A-Za-z0-9_-]+)/);
  if (m) return { code: m[1], state: s?.[1] };
  return /^[A-Za-z0-9_-]{4,}$/.test(text) ? { code: text } : null;
}

async function init() {
  try {
    const s = await api('/auth/status');
    if (!s.configured) { $('intro').innerHTML = 'Not configured yet: set <code>ST_CLIENT_ID</code> and <code>ST_CLIENT_SECRET</code> in <code>.env</code>, then restart the server.'; return; }
    $('intro').textContent = s.connected ? 'SmartThings is connected. You can reconnect below if needed.' : 'Sign in once; the server keeps itself signed in after that.';
    if (s.connected) status('Connected', 'ok');
    $('steps').hidden = false;
    if (/Electron/.test(navigator.userAgent)) {
      // Desktop app: the sign-in window captures the code itself
      $('steps').querySelector('ol').innerHTML = '<li>Click <b>Open SmartThings sign-in</b>, sign in with your Samsung account and approve access.</li><li>The window closes and connects automatically.</li>';
      $('paste').hidden = true; $('connect').hidden = true;
    }
  } catch (e) { $('intro').textContent = e.message; }
}

$('open').onclick = async () => {
  try { window.open((await api('/auth/url')).url, '_blank', 'noopener'); status('Approve access in the new tab, then paste the result here.'); }
  catch (e) { status(e.message, 'err'); }
};
$('connect').onclick = async () => {
  const got = extract($('paste').value);
  if (!got) return status('Could not find a code in what you pasted.', 'err');
  status('Connecting…');
  try { await api('/auth/code', got); status('Connected. You can go back to Echo Volume.', 'ok'); $('paste').value = ''; }
  catch (e) { status(e.message, 'err'); }
};
init();
