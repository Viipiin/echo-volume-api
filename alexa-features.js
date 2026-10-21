// More Alexa features, mounted at /api by server.js (after the login check):
// live updates, notifications, alarms/timers/reminders, announcements with sounds, one-tap Alexa, stop everything,
// Do Not Disturb, equalizer, Echo Show screen, Bluetooth, Alexa lists, voice history, smart home, radio, scenes, birthdays & anniversaries
// and phone access. `ctx` carries the helpers server.js already has.
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

module.exports = function features(ctx) {
  const {
    alexa, p, sequence, resolveDevice, groupMembers, groupMember, commandDevice, textCommand, speakers, musicDevice,
    musicItem, art, store, saveStore, events, CFG, httpErr, wrap, volumeCache, nowCache, syncLan, isLocal, lanKey, musicCountry,
  } = ctx;
  const router = express.Router();
  const asSequence = (startNode) => ({ '@type': 'com.amazon.alexa.behaviors.model.Sequence', startNode });
  // Speaker groups can't run commands themselves: use a member Echo
  const realDevice = (dev) => (dev.deviceFamily === 'WHA' ? groupMember(dev) : dev);
  // "device" as a list of Echos: one Echo, a group's members, or "all"
  const targets = (input) => {
    const dev = input === 'all' ? null : resolveDevice(input);
    const devs = dev ? groupMembers(dev) || [dev] : speakers();
    if (!devs.length) throw httpErr(503, 'No Echo online');
    return devs;
  };
  const echoOnly = (input) => {
    const d = resolveDevice(input);
    if (d.deviceFamily === 'WHA') throw httpErr(400, 'Pick an Echo, not a speaker group');
    return d;
  };
  const text = (v, n) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

  // ---------- Live updates: Amazon's push connection → server-sent events to every open page ----------
  const clients = new Set();
  function broadcast(type, data = {}) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }
  const pushConnected = () => !!alexa.isWsMqttConnected?.();
  router.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ push: pushConnected() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();
  events.on('theme', (theme) => broadcast('theme', { theme }));

  function hookPush() {
    const media = (d) => {
      if (d.deviceSerialNumber) delete nowCache[d.deviceSerialNumber];
      broadcast('media', { serial: d.deviceSerialNumber || null });
      songCheck(d.deviceSerialNumber || store.musicDevice);
    };
    const handlers = {
      'ws-volume-change': (d) => {
        volumeCache[d.deviceSerialNumber] = { v: d.volume, at: Date.now() };
        broadcast('volume', { serial: d.deviceSerialNumber, volume: d.volume, muted: !!d.isMuted });
      },
      'ws-media-change': media,
      'ws-audio-player-state-change': media,
      'ws-media-queue-change': media,
      'ws-now-playing-updated': () => media({}), // carries no device: refresh whatever is shown
      'ws-notification-change': () => refreshAlertsSoon(),
      'ws-todo-change': (d) => broadcast('lists', { listId: d.listId }),
      'ws-bluetooth-state-change': (d) => broadcast('bluetooth', { serial: d.deviceSerialNumber }),
      'ws-equilizer-state-change': (d) => broadcast('eq', { serial: d.deviceSerialNumber, bass: d.bass, mid: d.midrange, treble: d.treble }),
      'ws-device-activity': (d) => broadcast('activity', historyItem(d)),
      'ws-connect': () => broadcast('push', { connected: true }),
      'ws-disconnect': () => broadcast('push', { connected: false }),
    };
    for (const [name, fn] of Object.entries(handlers)) {
      alexa.on(name, (d) => { try { fn(d || {}); } catch (e) { console.log(`Push update ${name} failed:`, e.message); } });
    }
  }

  // All Echo volumes in one request (instead of one per Echo) to start with
  async function seedVolumes() {
    const r = await p((cb) => alexa.getAllDeviceVolumes(cb)).catch(() => null);
    for (const v of r?.volumes || []) {
      if (typeof v.speakerVolume === 'number') volumeCache[v.dsn] = { v: v.speakerVolume, at: Date.now() };
    }
  }

  // ---------- Notifications: timers/alarms going off, song changes (desktop app and browser) ----------
  router.get('/notify', (_req, res) => res.json(store.notify));
  router.post('/notify', (req, res) => {
    for (const k of ['alerts', 'songs']) if (typeof req.body?.[k] === 'boolean') store.notify[k] = req.body[k];
    saveStore();
    res.json(store.notify);
  });
  function notify(kind, data) { // kind: 'alert' | 'song'
    if (!store.notify[kind === 'alert' ? 'alerts' : 'songs']) return;
    events.emit(kind, data); // desktop app: Windows notification
    broadcast(kind, data); // open pages
  }
  const lastSong = {};
  let songTimer = null;
  function songCheck(serial) {
    if (!store.notify.songs || !serial || serial !== store.musicDevice) return;
    clearTimeout(songTimer);
    songTimer = setTimeout(async () => {
      const i = (await p((cb) => alexa.getPlayerInfo(serial, cb)).catch(() => null))?.playerInfo;
      const title = i?.infoText?.title;
      if (!title || i.state !== 'PLAYING' || lastSong[serial] === title) return;
      lastSong[serial] = title;
      notify('song', {
        title: `♪ ${title}`,
        body: [i.infoText?.subText1, alexa.serialNumbers[serial]?.accountName].filter(Boolean).join(' · '),
        artwork: i.mainArt?.url || null,
      });
    }, 1500);
  }

  // ---------- Alarms, timers and reminders ----------
  // Listed and removed through Amazon's notifications API; created by voice ("set a timer for 10 minutes"),
  // which Alexa handles better than the library's half-finished create calls.
  let alertsRaw = [], alertsAt = 0, alertTimeouts = [], alertsTimer = null;
  const ALERT_TYPES = { Alarm: 'alarm', MusicAlarm: 'alarm', Timer: 'timer', Reminder: 'reminder' };
  const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // Amazon's repeat patterns: P1D daily, XXXX-WD weekdays, XXXX-WE weekends, XXXX-WXX-1..7 one weekday (1 = Monday)
  function repeatDays(n) {
    const pat = n.recurringPattern;
    if (pat === 'P1D') return [0, 1, 2, 3, 4, 5, 6];
    if (pat === 'XXXX-WD') return [1, 2, 3, 4, 5];
    if (pat === 'XXXX-WE') return [0, 6];
    const one = /^XXXX-WXX-([1-7])$/.exec(pat || '');
    if (one) return [+one[1] % 7];
    const by = n.rRuleData?.byWeekDays;
    if (Array.isArray(by) && by.length) return by.map((d) => DAY_CODES[String(d).slice(0, 2).toUpperCase()]).filter((d) => d != null);
    return pat ? [0, 1, 2, 3, 4, 5, 6] : null;
  }
  const repeatLabel = (days) => {
    if (!days) return '';
    const k = [...days].sort().join('');
    return { '0123456': 'Every day', 12345: 'Weekdays', '06': 'Weekends' }[k] || days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ');
  };
  // Next time a repeating alarm rings (its alarmTime is often the first occurrence, in the past)
  function nextRing(at, time, days) {
    if (at && at > Date.now()) return at;
    if (!time || !days?.length) return at || null;
    const [h, m] = time.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      d.setHours(h, m, 0, 0);
      if (d.getTime() > Date.now() && days.includes(d.getDay())) return d.getTime();
    }
    return at || null;
  }
  function normAlert(n) {
    const type = ALERT_TYPES[n.type];
    if (!type) return null;
    const dev = alexa.serialNumbers[n.deviceSerialNumber];
    const a = {
      id: n.id, type, status: n.status, device: n.deviceSerialNumber,
      // The Alexa phone app is listed by Amazon as "This Device"
      deviceName: !dev || dev.deviceFamily === 'VOX' ? 'Alexa app' : dev.accountName,
      label: n.reminderLabel || n.timerLabel || n.alarmLabel || '',
    };
    if (type === 'timer') {
      a.duration = n.originalDurationInMillis || null;
      a.remaining = n.remainingTime ?? null;
      a.at = n.status === 'ON' && n.remainingTime != null ? alertsAt + n.remainingTime : null; // paused: no end time
    } else {
      const days = type === 'alarm' ? repeatDays(n) : null;
      // Alarms come with alarmTime 0 and only a local date + time (the Echo's time zone, taken to be this PC's)
      const at = n.alarmTime || (n.originalDate && n.originalTime ? new Date(`${n.originalDate}T${n.originalTime.slice(0, 8)}`).getTime() : null);
      a.time = n.originalTime ? n.originalTime.slice(0, 5) : null;
      a.repeat = repeatLabel(days);
      a.at = type === 'alarm' ? nextRing(at, a.time, days) : at;
    }
    return a;
  }
  const alertList = () => alertsRaw.map(normAlert).filter(Boolean).sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity));
  async function refreshAlerts() {
    const r = await p((cb) => alexa.getNotifications(false, cb));
    alertsRaw = r?.notifications || [];
    alertsAt = Date.now();
    scheduleAlerts();
    broadcast('alerts');
  }
  function refreshAlertsSoon(ms = 2000) {
    clearTimeout(alertsTimer);
    alertsTimer = setTimeout(() => refreshAlerts().catch((e) => console.log('Alarms & timers refresh failed:', e.message)), ms);
  }
  // A notification on the PC when a timer or alarm goes off (the Echo rings as usual)
  function scheduleAlerts() {
    alertTimeouts.forEach(clearTimeout);
    alertTimeouts = [];
    const now = Date.now();
    for (const a of alertList()) {
      if (a.type === 'reminder' || a.status !== 'ON' || !a.at || a.at <= now || a.at - now > 24 * 3600 * 1000) continue;
      alertTimeouts.push(setTimeout(() => notify('alert', {
        title: a.type === 'timer' ? `⏱ ${a.label ? `${a.label} timer` : 'Timer'} done` : `⏰ ${a.label || 'Alarm'}`,
        body: `On ${a.deviceName}`,
      }), a.at - now));
    }
  }

  router.get('/alerts', wrap(async (_req, res) => {
    if (Date.now() - alertsAt > 30000) await refreshAlerts();
    res.json({ now: Date.now(), alerts: alertList() });
  }));

  const time12 = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
  };
  const spokenDuration = (min) => {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`].filter(Boolean).join(' ');
  };
  const validTime = (t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t || '');
  const REPEAT = { daily: ' every day', weekdays: ' every weekday', weekends: ' every weekend' };

  // { type: timer, minutes, label } | { type: alarm, time: "07:30", repeat: daily|weekdays|weekends }
  // | { type: reminder, text, time + day (today|tomorrow) or minutes }
  router.post('/alerts', wrap(async (req, res) => {
    const b = req.body || {};
    const dev = realDevice(resolveDevice(b.device));
    let say;
    if (b.type === 'timer') {
      const minutes = Number(b.minutes);
      if (!(minutes >= 1 && minutes <= 24 * 60)) throw httpErr(400, 'A timer can be 1 minute to 24 hours');
      const label = text(b.label, 40);
      say = `set a ${label ? `${label} ` : ''}timer for ${spokenDuration(minutes)}`;
    } else if (b.type === 'alarm') {
      if (!validTime(b.time)) throw httpErr(400, 'Pick a time for the alarm');
      say = `set ${REPEAT[b.repeat] ? 'a repeating alarm' : 'an alarm'} for ${time12(b.time)}${REPEAT[b.repeat] || ''}`;
    } else if (b.type === 'reminder') {
      const what = text(b.text, 120);
      if (!what) throw httpErr(400, 'What should Alexa remind you about?');
      if (Number(b.minutes) > 0) say = `remind me to ${what} in ${spokenDuration(Number(b.minutes))}`;
      else if (validTime(b.time)) say = `remind me to ${what} ${b.day === 'tomorrow' ? 'tomorrow ' : ''}at ${time12(b.time)}`;
      else throw httpErr(400, 'Pick a time for the reminder');
    } else throw httpErr(400, '"type" must be timer, alarm or reminder');
    await textCommand(dev, say);
    refreshAlertsSoon(4000);
    res.json({ device: dev.accountName, said: say });
  }));

  const rawAlert = (id) => {
    const n = alertsRaw.find((x) => x.id === id);
    if (!n) throw httpErr(404, 'Not found any more. Refresh the list.');
    return n;
  };
  router.post('/alerts/delete', wrap(async (req, res) => {
    const n = rawAlert(req.body?.id);
    await p((cb) => alexa.deleteNotification(n, cb));
    alertsRaw = alertsRaw.filter((x) => x !== n);
    scheduleAlerts();
    broadcast('alerts');
    refreshAlertsSoon(3000);
    res.json({ deleted: true });
  }));
  router.post('/alerts/toggle', wrap(async (req, res) => {
    const n = rawAlert(req.body?.id);
    if (ALERT_TYPES[n.type] !== 'alarm') throw httpErr(400, 'Only alarms can be switched on or off');
    await p((cb) => alexa.changeNotification(n, !!req.body?.on, cb));
    refreshAlertsSoon(1500);
    res.json({ on: !!req.body?.on });
  }));

  // ---------- Announcements (optionally with a sound first), sound effects ----------
  let soundsCache = null;
  router.get('/sounds', wrap(async (_req, res) => {
    if (!soundsCache) {
      const list = await p((cb) => alexa.getRoutineSoundList(cb));
      soundsCache = (Array.isArray(list) ? list : []).filter((s) => s.availability === 'AVAILABLE')
        .map((s) => ({ id: s.id, name: s.displayName, category: s.providerData?.categoryDisplayName || 'Other' }));
    }
    res.json(soundsCache);
  }));
  const validSound = (id) => /^[\w.-]{1,120}$/.test(id || '');
  const soundNode = (id, devs) => {
    const nodes = devs.map((d) => alexa.createSequenceNode('sound', id, d.serialNumber));
    return nodes.length === 1 ? nodes[0] : { '@type': 'com.amazon.alexa.behaviors.model.ParallelNode', nodesToExecute: nodes };
  };
  router.post('/sound', wrap(async (req, res) => {
    if (!validSound(req.body?.id)) throw httpErr(400, '"id" (from /api/sounds) is required');
    const devs = targets(req.body?.device);
    await sequence(devs[0].serialNumber, asSequence(soundNode(req.body.id, devs)));
    res.json({ played: req.body.id, devices: devs.map((d) => d.accountName) });
  }));

  // "announcement" = chime + text (shown on Echo Show screens); "speak" = Alexa just says it (one Echo).
  // device: an Echo, a speaker group, or "all"; sound: a sound effect to play first.
  router.post('/announce', wrap(async (req, res) => {
    const msg = text(req.body?.text, 250);
    if (!msg) throw httpErr(400, '"text" is required');
    const devs = targets(req.body?.device);
    const mode = req.body?.mode === 'speak' && devs.length === 1 ? 'speak' : 'announcement';
    const node = alexa.createSequenceNode(mode, msg, mode === 'speak' ? devs[0].serialNumber : devs.map((d) => d.serialNumber));
    // The library tags these German ("de-DE") and titles the on-screen card "ioBroker"
    if (mode === 'speak') node.operationPayload.locale = CFG.lang;
    else Object.assign(node.operationPayload.content[0], { locale: CFG.lang, display: { title: 'Echo Volume', body: msg } });
    const start = validSound(req.body?.sound)
      ? { '@type': 'com.amazon.alexa.behaviors.model.SerialNode', nodesToExecute: [soundNode(req.body.sound, devs), node] }
      : node;
    await sequence(devs[0].serialNumber, asSequence(start));
    res.json({ mode, devices: devs.map((d) => d.accountName), text: msg });
  }));

  // ---------- One-tap Alexa, stop everything ----------
  const ACTIONS = ['weather', 'traffic', 'flashbriefing', 'goodmorning', 'calendarToday', 'calendarTomorrow', 'joke', 'funfact', 'singasong', 'tellstory'];
  router.post('/alexa/do', wrap(async (req, res) => {
    const action = req.body?.action;
    if (!ACTIONS.includes(action)) throw httpErr(400, `"action" must be one of: ${ACTIONS.join(', ')}`);
    const d = realDevice(commandDevice(req.body?.device));
    const node = alexa.createSequenceNode(action, null, d.serialNumber);
    node.operationPayload.locale = CFG.lang; // the library would tag it German
    await sequence(d.serialNumber, asSequence(node));
    res.json({ action, device: d.accountName });
  }));
  router.post('/stop-all', wrap(async (_req, res) => {
    const d = speakers()[0];
    if (!d) throw httpErr(503, 'No Echo online');
    await sequence(d.serialNumber, asSequence(alexa.createSequenceNode('deviceStopAll', null, d.serialNumber)));
    for (const k of Object.keys(nowCache)) delete nowCache[k];
    res.json({ stopped: true });
  }));

  // ---------- Per-Echo settings: Do Not Disturb, equalizer, screen, Bluetooth ----------
  router.get('/dnd', wrap(async (_req, res) => {
    const r = await p((cb) => alexa.getDoNotDisturb(cb));
    res.json(Object.fromEntries((r?.doNotDisturbDeviceStatusList || []).map((d) => [d.deviceSerialNumber, !!d.enabled])));
  }));
  router.post('/dnd', wrap(async (req, res) => {
    const enabled = !!req.body?.enabled;
    const devs = targets(req.body?.device);
    await Promise.all(devs.map((d) => p((cb) => alexa.setDoNotDisturb(d.serialNumber, enabled, cb))));
    broadcast('dnd');
    res.json({ enabled, devices: devs.map((d) => d.accountName) });
  }));

  router.get('/eq', wrap(async (req, res) => {
    const d = echoOnly(req.query.device);
    const [eq, range] = await Promise.all([
      p((cb) => alexa.getEqualizerSettings(d.serialNumber, cb)),
      p((cb) => alexa.getEqualizerRange(d.serialNumber, cb)).catch(() => null),
    ]);
    res.json({ device: d.accountName, bass: eq?.bass ?? 0, mid: eq?.mid ?? 0, treble: eq?.treble ?? 0, min: range?.min ?? -6, max: range?.max ?? 6 });
  }));
  router.post('/eq', wrap(async (req, res) => {
    const d = echoOnly(req.body?.device);
    const v = (k) => Math.max(-6, Math.min(6, Math.round(Number(req.body?.[k]) || 0)));
    await p((cb) => alexa.setEqualizerSettings(d.serialNumber, v('bass'), v('mid'), v('treble'), cb));
    res.json({ device: d.accountName, bass: v('bass'), mid: v('mid'), treble: v('treble') });
  }));

  // Echo Show screen on/off. Amazon's settings API doesn't support the screen on the Echo Show 8, so it goes by
  // voice. (Brightness can't be set either way: Alexa answers "use the brightness slider".)
  router.post('/screen', wrap(async (req, res) => {
    const d = echoOnly(req.body?.device);
    if (typeof req.body?.on !== 'boolean') throw httpErr(400, '"on" (true or false) is required');
    const say = `turn ${req.body.on ? 'on' : 'off'} the screen`;
    await textCommand(d, say);
    res.json({ device: d.accountName, said: say });
  }));

  router.get('/bluetooth', wrap(async (_req, res) => {
    const r = await p((cb) => alexa.getBluetooth(false, cb));
    const online = new Set(speakers().map((d) => d.serialNumber));
    res.json((r?.bluetoothStates || []).filter((s) => online.has(s.deviceSerialNumber)).map((s) => ({
      serial: s.deviceSerialNumber,
      name: alexa.serialNumbers[s.deviceSerialNumber]?.accountName || s.deviceSerialNumber,
      paired: (s.pairedDeviceList || []).map((b) => ({ name: b.friendlyName, address: b.address, connected: !!b.connected })),
    })));
  }));
  router.post('/bluetooth/connect', wrap(async (req, res) => {
    const d = echoOnly(req.body?.device);
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(req.body?.address || '')) throw httpErr(400, '"address" (from /api/bluetooth) is required');
    await p((cb) => alexa.connectBluetooth(d.serialNumber, req.body.address, cb));
    res.json({ device: d.accountName, connecting: req.body.address });
  }));
  router.post('/bluetooth/disconnect', wrap(async (req, res) => {
    const d = echoOnly(req.body?.device);
    await p((cb) => alexa.disconnectBluetooth(d.serialNumber, null, cb));
    res.json({ device: d.accountName, disconnected: true });
  }));

  // ---------- Alexa lists (shopping, to-do) ----------
  const LIST_NAMES = { SHOP: 'Shopping', SHOPPING_LIST: 'Shopping', TODO: 'To-do', TO_DO: 'To-do' };
  const listsUrl = `https://www.${CFG.amazonPage}/alexashoppinglists/api/v2/lists`;
  router.get('/lists', wrap(async (_req, res) => {
    const lists = await p((cb) => alexa.getLists(cb));
    res.json(await Promise.all((Array.isArray(lists) ? lists : []).map(async (l) => {
      const id = l.listId || l.itemId || l.id;
      const items = await p((cb) => alexa.getListItems(id, {}, cb)).catch(() => []);
      return {
        id, name: LIST_NAMES[l.name] || l.name,
        items: (items || []).map((i) => ({ id: i.id, value: i.value, completed: !!i.completed, version: i.version })),
      };
    })));
  }));
  router.post('/lists/:id/items', wrap(async (req, res) => {
    const value = text(req.body?.value, 200);
    if (!value) throw httpErr(400, '"value" is required');
    await p((cb) => alexa.addListItem(req.params.id, { value }, cb));
    broadcast('lists', { listId: req.params.id });
    res.json({ added: value });
  }));
  // The library's update builds a broken URL ("?version =") and insists on a new name; this sends only what changed
  router.post('/lists/:id/items/:item', wrap(async (req, res) => {
    const { completed, value, version } = req.body || {};
    if (!version) throw httpErr(400, '"version" is required');
    const update = [];
    if (typeof completed === 'boolean') update.push({ type: 'itemStatus', value: completed ? 'COMPLETE' : 'ACTIVE' });
    if (text(value, 200)) update.push({ type: 'itemName', value: text(value, 200) });
    if (!update.length) throw httpErr(400, 'Nothing to change');
    const url = `${listsUrl}/${encodeURIComponent(req.params.id)}/items/${encodeURIComponent(req.params.item)}?version=${encodeURIComponent(version)}`;
    await p((cb) => alexa.httpsGet(url, cb, { method: 'PUT', data: JSON.stringify({ itemAttributesToUpdate: update, itemAttributesToRemove: [] }) }));
    broadcast('lists', { listId: req.params.id });
    res.json({ updated: true });
  }));
  router.post('/lists/:id/items/:item/delete', wrap(async (req, res) => {
    if (!req.body?.version) throw httpErr(400, '"version" is required');
    await p((cb) => alexa.deleteListItem(req.params.id, req.params.item, { version: req.body.version }, cb));
    broadcast('lists', { listId: req.params.id });
    res.json({ deleted: true });
  }));

  // ---------- Voice history: what Alexa heard, and on which Echo ----------
  function historyItem(r) {
    return {
      at: r.creationTimestamp || r.data?.timestamp || null,
      device: r.name || r.data?.device?.deviceName || alexa.serialNumbers[r.deviceSerialNumber]?.accountName || '',
      serial: r.deviceSerialNumber || null,
      text: r.description?.summary || '',
      response: r.alexaResponse || '',
      intent: r.data?.intent || '',
      domain: r.data?.domain || '',
    };
  }
  router.get('/history', wrap(async (req, res) => {
    const hours = Math.max(1, Math.min(24 * 7, Number(req.query.hours) || 24));
    const r = await p((cb) => alexa.getCustomerHistoryRecords({ startTime: Date.now() - hours * 3600000, endTime: Date.now() + 60000, forceRequest: true }, cb));
    res.json((Array.isArray(r) ? r : []).map(historyItem).filter((h) => h.text || h.response));
  }));

  // ---------- Smart home: lights, plugs and switches connected to Alexa ----------
  const ops = (e) => e.supportedOperations || [];
  router.get('/smarthome/devices', wrap(async (_req, res) => {
    const list = await p((cb) => alexa.getSmarthomeEntities(cb));
    const devs = (Array.isArray(list) ? list : []).filter((e) => ops(e).includes('turnOn') && ops(e).includes('turnOff'));
    if (!devs.length) return res.json([]);
    const r = await p((cb) => alexa.querySmarthomeDevices(devs.map((e) => e.id), 'ENTITY', cb)).catch(() => null);
    const state = {};
    for (const s of r?.deviceStates || []) {
      const caps = (s.capabilityStates || []).map((c) => { try { return JSON.parse(c); } catch { return {}; } });
      const get = (ns, name) => caps.find((c) => c.namespace === ns && c.name === name)?.value;
      state[s.entity?.entityId] = {
        power: get('Alexa.PowerController', 'powerState') ?? null,
        brightness: get('Alexa.BrightnessController', 'brightness') ?? null,
        reachable: get('Alexa.EndpointHealth', 'connectivity')?.value !== 'UNREACHABLE',
      };
    }
    res.json(devs.map((e) => ({
      id: e.id, name: e.displayName, kind: e.providerData?.deviceType || e.type || '',
      dimmable: ops(e).includes('setBrightness'), ...(state[e.id] || { power: null, brightness: null, reachable: null }),
    })));
  }));
  router.post('/smarthome/devices/:id', wrap(async (req, res) => {
    const action = req.body?.action;
    if (!['turnOn', 'turnOff', 'setBrightness'].includes(action)) throw httpErr(400, '"action" must be turnOn, turnOff or setBrightness');
    const params = action === 'setBrightness'
      ? { action, brightness: Math.max(0, Math.min(100, Math.round(Number(req.body.brightness) || 0))) } : { action };
    const r = await p((cb) => alexa.executeSmarthomeDeviceAction(req.params.id, params, 'ENTITY', cb));
    if (r?.errors?.length) throw httpErr(502, r.errors[0].message || r.errors[0].code || 'The device did not respond');
    res.json({ ok: true });
  }));

  // ---------- Radio: stations from the free Radio Browser directory, played through TuneIn ----------
  // (Amazon's own TuneIn search no longer answers; TuneIn playback by station name still works.)
  const RADIO_HOSTS = ['de1.api.radio-browser.info', 'all.api.radio-browser.info'];
  let radioTop = null; // { at, items } popular stations in the account's country
  async function radioSearch(params) {
    const qs = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', ...params });
    for (const host of RADIO_HOSTS) {
      try {
        const r = await fetch(`https://${host}/json/stations/search?${qs}`, { headers: { 'User-Agent': 'EchoVolume/1.0' }, signal: AbortSignal.timeout(8000) });
        if (r.ok) return await r.json();
      } catch {}
    }
    throw httpErr(502, 'The radio directory is not responding, try again');
  }
  const stationTiles = (list) => {
    const seen = new Set();
    return list.filter((s) => {
      const k = (s.name || '').trim().toLowerCase();
      return k && !seen.has(k) && seen.add(k);
    }).map((s) => ({
      type: 'radio', title: s.name.trim(),
      subtitle: [s.countrycode, (s.tags || '').split(',').filter(Boolean).slice(0, 2).join(', ')].filter(Boolean).join(' · ') || 'Radio',
      artwork: /^https:\/\//.test(s.favicon || '') ? s.favicon : null,
      query: s.name.trim(),
    }));
  };
  router.get('/radio', wrap(async (req, res) => {
    const q = text(req.query.q, 80);
    const limit = Math.max(1, Math.min(200, Math.round(Number(req.query.limit)) || 30));
    if (!q && radioTop && Date.now() - radioTop.at < 3600000 && radioTop.items.length >= limit) return res.json(radioTop.items.slice(0, limit));
    const items = stationTiles(await radioSearch(q ? { name: q, limit: String(limit) } : { countrycode: musicCountry, limit: String(limit) }));
    if (!q) radioTop = { at: Date.now(), items };
    res.json(items);
  }));

  // ---------- Apple Podcasts: browse Apple's free catalog; Alexa plays a show or its latest episode ----------
  // (Alexa can't start an older episode by name: "I couldn't find … on Apple Podcasts". From the latest episode,
  // ⏮ goes back one episode at a time.)
  async function fetchJson(url, timeout = 10000) {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw httpErr(502, `Apple returned ${r.status}`);
    return r.json();
  }
  const podcastTile = (id, title, author, genre, artwork) => ({
    type: 'podcast', id: String(id), title, subtitle: [author, genre].filter(Boolean).join(' · '), artwork, query: title,
  });
  let podTop = null; // { at, items }
  router.get('/podcasts/top', wrap(async (req, res) => {
    const limit = Math.max(1, Math.min(100, Math.round(Number(req.query.limit)) || 30));
    if (!podTop || Date.now() - podTop.at > 3600000 || podTop.items.length < limit) {
      const url = `https://rss.marketingtools.apple.com/api/v2/${musicCountry.toLowerCase()}/podcasts/top/${Math.max(limit, 50)}/podcasts.json`;
      let feed;
      for (let i = 0; !feed; i++) { // the same flaky chart feed as the music charts: retry a hung request
        try { feed = (await fetchJson(url, 6000)).feed; } catch (e) { if (i === 2) throw httpErr(502, 'Apple podcast charts are not responding, try a search'); }
      }
      podTop = { at: Date.now(), items: (feed.results || []).map((r) => podcastTile(r.id, r.name, r.artistName, r.genres?.[0]?.name, art(r.artworkUrl100, 600))) };
    }
    res.json(podTop.items.slice(0, limit));
  }));
  router.get('/podcasts/search', wrap(async (req, res) => {
    const q = text(req.query.q, 100);
    if (!q) throw httpErr(400, '"q" is required');
    const limit = Math.max(1, Math.min(200, Math.round(Number(req.query.limit)) || 30));
    const { results = [] } = await fetchJson(`https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${limit}&country=${musicCountry}&term=${encodeURIComponent(q)}`);
    res.json(results.map((r) => podcastTile(r.collectionId, r.collectionName, r.artistName, r.primaryGenreName, r.artworkUrl600 || art(r.artworkUrl100, 600))));
  }));
  router.get('/podcasts/:id/episodes', wrap(async (req, res) => {
    if (!/^\d{1,15}$/.test(req.params.id)) throw httpErr(400, 'Unknown podcast');
    const { results = [] } = await fetchJson(`https://itunes.apple.com/lookup?id=${req.params.id}&entity=podcastEpisode&limit=40&country=${musicCountry}`);
    const show = results.find((r) => r.kind === 'podcast') || {};
    res.json({
      podcast: podcastTile(req.params.id, show.collectionName || '', show.artistName, show.primaryGenreName, show.artworkUrl600 || null),
      episodes: results.filter((r) => r.kind === 'podcast-episode').map((r) => ({
        title: r.trackName, released: r.releaseDate || null,
        minutes: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 60000) : null,
        summary: text((r.shortDescription || r.description || '').replace(/<[^>]+>/g, ' '), 280),
      })),
    });
  }));
  // { device, podcast: "show name", latest: true|false, item: the tile (for recently played) }
  router.post('/podcasts/play', wrap(async (req, res) => {
    const show = text(req.body?.podcast, 150);
    if (!show) throw httpErr(400, '"podcast" (the show name) is required');
    const dev = musicDevice(req.body?.device);
    const say = `play ${req.body?.latest === false ? '' : 'the latest episode of '}${show} on apple podcasts`;
    if (dev.deviceFamily === 'WHA') await textCommand(groupMember(dev), `${say} on ${dev.accountName}`);
    else await textCommand(dev, say);
    delete nowCache[dev.serialNumber];
    try {
      const item = musicItem({ ...req.body?.item, type: 'podcast', title: req.body?.item?.title || show, query: show });
      store.recent = [item, ...store.recent.filter((r) => r.query !== item.query)].slice(0, 30);
      saveStore();
    } catch {}
    res.json({ device: dev.accountName, said: say });
  }));

  // ---------- Scenes: several actions in one tap, optionally on a schedule ----------
  const STEP_TYPES = ['volume', 'music', 'pause', 'resume', 'sleep', 'tv', 'dnd', 'screen', 'announce', 'routine', 'sound', 'alexa', 'stopall', 'wait'];
  function cleanScene(s) {
    const name = text(s?.name, 60);
    if (!name) throw httpErr(400, 'Give the scene a name');
    const steps = (Array.isArray(s.steps) ? s.steps : []).slice(0, 30).map((st) => {
      if (!STEP_TYPES.includes(st?.type)) throw httpErr(400, `Unknown step "${st?.type}"`);
      const out = { type: st.type };
      for (const k of ['device', 'query', 'provider', 'action', 'value', 'text', 'id']) if (st[k] != null && st[k] !== '') out[k] = text(st[k], 250);
      for (const k of ['level', 'minutes', 'seconds']) if (st[k] != null && st[k] !== '' && !isNaN(st[k])) out[k] = Number(st[k]);
      if (typeof st.on === 'boolean') out.on = st.on;
      return out;
    });
    if (!steps.length) throw httpErr(400, 'Add at least one step');
    const sch = s.schedule;
    const schedule = sch?.enabled && /^([01]\d|2[0-3]):[0-5]\d$/.test(sch.time || '')
      ? { enabled: true, time: sch.time, days: (Array.isArray(sch.days) ? sch.days : []).map(Number).filter((d) => d >= 0 && d <= 6) }
      : null;
    return { id: /^[\w-]{4,40}$/.test(s.id || '') ? s.id : crypto.randomUUID(), name, steps, schedule };
  }
  router.get('/scenes', (_req, res) => res.json(store.scenes));
  router.post('/scenes', wrap(async (req, res) => {
    const sc = cleanScene(req.body?.scene);
    const i = store.scenes.findIndex((x) => x.id === sc.id);
    if (i >= 0) store.scenes[i] = sc; else store.scenes.push(sc);
    saveStore();
    res.json(sc);
  }));
  router.post('/scenes/:id/delete', (req, res) => {
    store.scenes = store.scenes.filter((x) => x.id !== req.params.id);
    saveStore();
    res.json({ deleted: true });
  });
  router.post('/scenes/:id/run', (req, res) => {
    const sc = store.scenes.find((x) => x.id === req.params.id);
    if (!sc) return res.status(404).json({ error: 'Scene not found' });
    runScene(sc, 'run');
    res.json({ started: sc.name });
  });

  // Each step calls this server's own API, so a scene does exactly what the matching button does
  async function self(method, url, body) {
    const r = await fetch(`http://127.0.0.1:${CFG.port}/api${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const STEP = {
    volume: (s) => self('POST', '/volume', { device: s.device, level: (s.level ?? 5) * 10 }),
    music: (s) => self('POST', '/music/play', { device: s.device, query: s.query, provider: s.provider }),
    pause: (s) => self('POST', '/music/pause', { device: s.device }),
    resume: (s) => self('POST', '/music/play', { device: s.device }),
    sleep: (s) => self('POST', '/music/sleep', { device: s.device, minutes: s.minutes ?? 30 }),
    dnd: (s) => self('POST', '/dnd', { device: s.device || 'all', enabled: s.on !== false }),
    screen: (s) => self('POST', '/screen', { device: s.device, on: s.on !== false }),
    announce: (s) => self('POST', '/announce', { device: s.device || 'all', text: s.text }),
    routine: (s) => self('POST', '/routines/run', { id: s.id, device: s.device }),
    sound: (s) => self('POST', '/sound', { device: s.device || 'all', id: s.id }),
    alexa: (s) => self('POST', '/alexa/do', { device: s.device, action: s.action }),
    stopall: () => self('POST', '/stop-all', {}),
    wait: (s) => new Promise((r) => setTimeout(r, Math.max(1, Math.min(600, s.seconds || 5)) * 1000)),
    tv: async (s) => { // SmartThings when connected, else through Alexa (power and volume only)
      const st = (await self('GET', '/st/auth/status').catch(() => ({}))).connected;
      if (s.action === 'on' || s.action === 'off') return st ? self('POST', '/st/tv/power', { on: s.action === 'on' }) : self('POST', `/tv/${s.action}`, {});
      if (s.action === 'volume') return self('POST', st ? '/st/tv/volume' : '/tv/volume', { level: s.level ?? 20 });
      if (s.action === 'mute' || s.action === 'unmute') return self('POST', `${st ? '/st' : ''}/tv/${s.action}`, {});
      if (s.action === 'app' && st) return self('POST', '/st/tv/app', { appName: s.value });
      throw new Error(`TV "${s.action}" needs SmartThings`);
    },
  };
  const runningScenes = new Set();
  async function runScene(sc, why) {
    if (runningScenes.has(sc.id)) return;
    runningScenes.add(sc.id);
    console.log(`Scene "${sc.name}" (${why})`);
    const errors = [];
    broadcast('scene', { id: sc.id, name: sc.name, status: 'running', step: 0, total: sc.steps.length });
    for (const [i, st] of sc.steps.entries()) {
      try { await STEP[st.type](st); } catch (e) { errors.push(`step ${i + 1} (${st.type}): ${e.message}`); }
      broadcast('scene', { id: sc.id, name: sc.name, status: 'running', step: i + 1, total: sc.steps.length });
    }
    runningScenes.delete(sc.id);
    if (errors.length) console.log(`Scene "${sc.name}":`, errors.join('; '));
    broadcast('scene', { id: sc.id, name: sc.name, status: errors.length ? 'error' : 'done', errors });
  }
  // Scheduled scenes: checked every 15s, each runs once per scheduled minute (only while Echo Volume runs)
  const lastRun = {};
  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const key = `${now.toDateString()} ${hhmm}`;
    for (const sc of store.scenes) {
      const s = sc.schedule;
      if (!s?.enabled || s.time !== hhmm || (s.days.length && !s.days.includes(now.getDay())) || lastRun[sc.id] === key) continue;
      lastRun[sc.id] = key;
      runScene(sc, 'schedule');
    }
  }, 15000).unref();

  // ---------- Birthdays & anniversaries: announced on the day at a set time (only while Echo Volume runs) ----------
  // An Alexa reminder can't change its words each year, so "34th birthday" is worked out here and announced.
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const isLeap = (y) => new Date(y, 1, 29).getMonth() === 1;
  // The day it falls on in year y (29 February is kept on 28 February in other years)
  const onYear = (c, y) => new Date(y, c.month - 1, c.month === 2 && c.day === 29 && !isLeap(y) ? 28 : c.day);
  function nextDate(c) {
    const today = midnight();
    const d = onYear(c, today.getFullYear());
    return d < today ? onYear(c, today.getFullYear() + 1) : d;
  }
  const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
  // With a year: "Vipin is celebrating 34th birthday today."; without: "It's Vipin's birthday today."
  function celebrationText(c, on) {
    const n = c.year ? on.getFullYear() - c.year : 0;
    const what = c.type === 'anniversary' ? 'anniversary' : 'birthday';
    const plural = /\s(and|&)\s/i.test(c.name); // "Vipin and Priya are celebrating…"
    const said = n > 0 ? `${c.name} ${plural ? 'are' : 'is'} celebrating ${ordinal(n)} ${what} today.` : `It's ${possessive(c.name)} ${what} today.`;
    return `${said} Happy ${what}, ${c.name}!`;
  }
  function cleanCelebration(b) {
    const name = text(b?.name, 60);
    if (!name) throw httpErr(400, 'Whose birthday or anniversary is it?');
    const month = Number(b.month), day = Number(b.day);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= new Date(2000, month, 0).getDate())) throw httpErr(400, 'Pick the day and month');
    const thisYear = new Date().getFullYear();
    const year = b.year == null || b.year === '' ? null : Number(b.year);
    if (year != null && !(Number.isInteger(year) && year >= 1900 && year <= thisYear)) throw httpErr(400, `The year should be 1900 to ${thisYear}, or left empty`);
    if (year && month === 2 && day === 29 && !isLeap(year)) throw httpErr(400, `${year} had no 29 February`);
    return { id: /^[\w-]{4,40}$/.test(b.id || '') ? b.id : crypto.randomUUID(), type: b.type === 'anniversary' ? 'anniversary' : 'birthday', name, month, day, year };
  }
  const celebrationView = (c) => {
    const d = nextDate(c);
    return { ...c, next: ymd(d), days: Math.round((d - midnight()) / 864e5), says: celebrationText(c, d) };
  };
  const celebrationList = () => ({ settings: store.celebrate, items: store.celebrations.map(celebrationView).sort((x, y) => x.days - y.days) });
  router.get('/celebrations', (_req, res) => res.json(celebrationList()));
  router.post('/celebrations', wrap(async (req, res) => {
    const c = cleanCelebration(req.body);
    const i = store.celebrations.findIndex((x) => x.id === c.id);
    if (i >= 0) store.celebrations[i] = c; else store.celebrations.push(c);
    if (i >= 0) delete store.celebrated[c.id]; // a changed date may fall today
    saveStore();
    res.json(celebrationList());
  }));
  router.post('/celebrations/settings', wrap(async (req, res) => {
    const b = req.body || {}, s = store.celebrate;
    if (b.time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) throw httpErr(400, 'Pick a time');
    if (b.device != null && b.device !== 'all') resolveDevice(b.device); // throws for an unknown Echo
    if (b.sound && !validSound(b.sound)) throw httpErr(400, 'Unknown sound');
    if (typeof b.enabled === 'boolean') s.enabled = b.enabled;
    for (const k of ['time', 'device', 'sound']) if (b[k] != null) s[k] = String(b[k]);
    saveStore();
    res.json(celebrationList());
  }));
  router.post('/celebrations/:id/delete', (req, res) => {
    store.celebrations = store.celebrations.filter((x) => x.id !== req.params.id);
    delete store.celebrated[req.params.id];
    saveStore();
    res.json(celebrationList());
  });
  const announceCelebration = (c, on, device) => self('POST', '/announce', {
    device: device || store.celebrate.device || 'all', text: celebrationText(c, on), sound: store.celebrate.sound || undefined,
  });
  // Preview: says now what will be said on the next one
  router.post('/celebrations/:id/test', wrap(async (req, res) => {
    const c = store.celebrations.find((x) => x.id === req.params.id);
    if (!c) throw httpErr(404, 'Not found any more');
    res.json(await announceCelebration(c, nextDate(c), req.body?.device));
  }));
  // Checked every 15s: from the set time until 10 pm (later if the time is later), so a PC switched on after the
  // set time still announces it that day. Each one once a day; a failed one is retried a minute later.
  let celebrating = false, celebrateRetry = 0;
  setInterval(async () => {
    const s = store.celebrate, now = new Date();
    if (!s.enabled || celebrating || Date.now() < celebrateRetry) return;
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < s.time || hhmm > (s.time > '22:00' ? '23:59' : '22:00')) return;
    const today = ymd(now);
    const due = store.celebrations.filter((c) => ymd(nextDate(c)) === today && store.celebrated[c.id] !== today);
    if (!due.length) return;
    celebrating = true;
    for (const c of due) {
      try {
        await announceCelebration(c, now);
        store.celebrated[c.id] = today;
        saveStore();
        console.log(`Announced: ${celebrationText(c, now)}`);
        notify('alert', { title: c.type === 'anniversary' ? '💐 Anniversary today' : '🎂 Birthday today', body: celebrationText(c, now) });
      } catch (e) {
        console.log(`Announcing "${c.name}" failed:`, e.message);
        celebrateRetry = Date.now() + 60000;
        break;
      }
    }
    celebrating = false;
  }, 15000).unref();

  // ---------- Phone access (same Wi-Fi): addresses, key and QR code; only shown on this PC ----------
  function lanAddresses() {
    const key = CFG.apiKey || store.phone.key;
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
        const virtual = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|vpn|tailscale|zerotier|loopback/i.test(name);
        out.push({ name, ip: a.address, url: `http://${a.address}:${CFG.port}/?key=${encodeURIComponent(key)}`, virtual });
      }
    }
    return out.sort((x, y) => x.virtual - y.virtual);
  }
  const lanInfo = () => ({ enabled: !!lanKey(), fromEnv: !!CFG.apiKey, addresses: lanKey() ? lanAddresses() : [] });
  const pcOnly = (req, res, next) => (isLocal(req) ? next() : res.status(403).json({ error: 'Only available on the PC running Echo Volume' }));
  router.get('/lan', pcOnly, (_req, res) => res.json(lanInfo()));
  router.post('/lan', pcOnly, (req, res) => {
    store.phone.enabled = !!req.body?.enabled;
    if (store.phone.enabled && !store.phone.key) store.phone.key = crypto.randomBytes(12).toString('base64url');
    if (req.body?.newKey) store.phone.key = crypto.randomBytes(12).toString('base64url'); // phones need the new link
    saveStore();
    syncLan();
    res.json(lanInfo());
  });
  router.get('/lan/qr', pcOnly, wrap(async (req, res) => {
    const url = String(req.query.url || '');
    if (!lanKey() || !lanAddresses().some((a) => a.url === url)) throw httpErr(400, 'Unknown address');
    res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }));
  }));

  function onReady() {
    hookPush();
    seedVolumes();
    refreshAlerts().catch((e) => console.log('Alarms & timers:', e.message));
    setInterval(() => refreshAlerts().catch(() => {}), 10 * 60 * 1000).unref();
  }

  return { router, onReady };
};
