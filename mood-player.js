// Moods, mounted at /api by server.js: pick a mood and Echo Volume plays matching Apple Music on an Echo or speaker
// group, endlessly, like Surprise. Each phrase ("lofi study beats") starts an Apple Music mix; after a few tracks the
// next phrase takes over (a station list in server.js's queue), mixing in a healing-frequency phrase every few tracks
// when that's on. Everything Alexa is asked goes through server.js (setVolume, playMusic via the queue), so commands
// stay paced (COMMAND_GAP_MS).
//
// Learning: a phrase skipped within 20 s counts against it; one that played a whole track (or 3 minutes), or whose
// song was favourited, counts for it. Scores are kept per mood and phrase (±5), and fade by 10% a week.
// Phrases played in the last 3 days are left out while there are others.
const express = require('express');
const M = require('./moods');
const F = require('./focus-presets');

module.exports = function moodPlayer(ctx) {
  const { alexa, p, store, saveStore, events, httpErr, wrap, musicDevice, getVolume, setVolume, setSleep, playlistPlay, playlistStep, stopPlaylist, playerInfo } = ctx;
  const router = express.Router();
  const state = () => store.moods;
  const moods = () => M.resolveMoods(state());
  const mood = (id) => {
    const m = moods().find((x) => x.id === id);
    if (!m) throw httpErr(404, `Unknown mood "${id}". GET /api/moods lists them.`);
    return m;
  };
  const SKIP_MS = 20000, DONE_MS = 180000, VERIFY_MS = 12000, MAX_FAILS = 3, TRACKS_PER_PHRASE = 4, SETTLE_MS = 400, SEEN_MS = M.LIMITS.seenDays * 86400000;

  let cur = null; // the mood playing: { serial, device, mood, opts, item, startedAt, phraseAt, tracks, fails, ratio, layer, cadence }
  let gen = 0; // newer play requests win over older ones still waiting for the volume

  // ---------- phrases ----------
  const parse = (s) => { const [text, e] = s.split('|'); return { text, energy: Number(e) || null }; };
  const key = (m, text) => `${m.id}|${text}`;
  // Each phrase keeps its language, so a mix can take turns between them
  function pool(m, o) {
    const chosen = M.languagesOf(o.language);
    const langs = o.vocals === 'instrumental' ? ['instrumental'] : o.vocals === 'light' ? ['instrumental', ...chosen] : chosen;
    let list = langs.flatMap((l) => (m.phrases[l] || []).map((x) => ({ ...parse(x), lang: l })));
    if (!list.length) list = Object.entries(m.phrases).flatMap(([l, ps]) => ps.map((x) => ({ ...parse(x), lang: l }))); // nothing in that language: any
    return list.map((x) => ({ ...x, energy: x.energy || m.energy }));
  }
  const weighted = (items, w) => {
    const ws = items.map(w), total = ws.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
    return items.at(-1);
  };
  // Not the last few, not anything heard in the last 3 days (while there's something else); near the intensity,
  // and the better-liked ones more often. A mix first picks a language at random (not the last phrase's), so each
  // language gets an even share however many phrases it has.
  function pickMood(m, o, avoid, lastLang) {
    const s = state(), scores = s.scores[m.id] || {}, now = Date.now();
    const all = pool(m, o).filter((x) => !avoid.has(x.text));
    const fresh = all.filter((x) => !(now - (s.seen[key(m, x.text)] || 0) < SEEN_MS));
    let from = fresh.length ? fresh : (all.length ? all : pool(m, o)).sort((a, b) => (s.seen[key(m, a.text)] || 0) - (s.seen[key(m, b.text)] || 0)).slice(0, 3);
    if (M.languagesOf(o.language).length > 1) {
      const langs = [...new Set(from.map((x) => x.lang))];
      const turn = langs.length > 1 ? langs.filter((l) => l !== lastLang) : langs;
      const lang = turn[Math.floor(Math.random() * turn.length)];
      from = from.filter((x) => x.lang === lang);
    }
    return weighted(from, (x) => Math.exp((scores[x.text] || 0) / 2) * Math.exp(-((x.energy - o.intensity) ** 2) / 2));
  }
  function pickFrequency(layer, avoid) {
    const ps = F.preset(layer)?.phrases || [], left = ps.filter((t) => !avoid.has(t));
    return { text: weighted(left.length ? left : ps, () => 1) };
  }
  // The next few items of the list: mood phrases with a frequency phrase every `ratio` tracks (all frequency at 0)
  function makeItems(c, n) {
    const out = [], avoid = new Set((c.queued || []).slice(-3));
    for (let i = 0; i < n; i++) {
      const freqTurn = c.layer && (c.ratio === 0 || c.cadence === 'freq');
      const pick = freqTurn ? pickFrequency(c.layer, avoid) : pickMood(c.mood, c.opts, avoid, c.lastLang);
      if (pick.lang) c.lastLang = pick.lang;
      const tracks = freqTurn ? (c.ratio === 0 ? 3 : 1) : c.layer ? c.ratio : TRACKS_PER_PHRASE;
      out.push({ type: 'phrase', query: pick.text, title: pick.text, layer: freqTurn ? 'frequency' : 'mood', tracks });
      if (c.layer && c.ratio > 0) c.cadence = freqTurn ? 'mood' : 'freq';
      avoid.add(pick.text);
      (c.queued ||= []).push(pick.text);
    }
    return out;
  }

  // ---------- learning ----------
  function score(m, text, d) {
    const s = state(), now = Date.now();
    if (!s.scoresAt) s.scoresAt = now;
    const weeks = Math.floor((now - s.scoresAt) / (7 * 86400000));
    if (weeks > 0) { // fade old opinions
      for (const sc of Object.values(s.scores)) for (const k of Object.keys(sc)) { sc[k] *= 0.9 ** weeks; if (Math.abs(sc[k]) < 0.05) delete sc[k]; }
      s.scoresAt = now;
    }
    const sc = (s.scores[m.id] ||= {});
    sc[text] = Math.max(-5, Math.min(5, (sc[text] || 0) + d));
    const keys = Object.keys(sc);
    if (keys.length > M.LIMITS.phrasesPerMood) keys.sort((a, b) => Math.abs(sc[a]) - Math.abs(sc[b])).slice(0, keys.length - M.LIMITS.phrasesPerMood).forEach((k) => delete sc[k]);
  }
  // A phrase's turn is over: how did it go
  function finishPhrase(c, outcome) {
    if (!c?.item || c.item.layer !== 'mood' || c.item.finished) return;
    c.item.finished = true;
    const ms = Date.now() - c.phraseAt;
    const o = outcome || (c.tracks >= 2 || ms >= DONE_MS ? 'done' : 'stop');
    if (o === 'skip') score(c.mood, c.item.query, -1);
    if (o === 'done') score(c.mood, c.item.query, 0.5);
    const s = state();
    s.history.push({ m: c.mood.id, k: c.item.query, at: c.phraseAt, s: Math.round(ms / 1000), o });
    if (s.history.length > M.LIMITS.history) s.history.splice(0, s.history.length - M.LIMITS.history);
    saveStore();
  }

  // ---------- what plays now ----------
  function now(serial) {
    const c = cur;
    if (!c || (serial && c.serial !== serial)) return null;
    return {
      active: true, device: c.device, serial: c.serial, moodId: c.mood.id, name: c.mood.name, icon: c.mood.icon, accent: c.mood.accent,
      phrase: c.item?.query || null, layer: c.item?.layer || 'mood', startedAt: c.startedAt, tracks: c.tracks,
      sleepAt: c.sleepAt && c.sleepAt > Date.now() ? c.sleepAt : null, opts: c.opts,
    };
  }
  const emit = (event, extra = {}) => events.emit('mood', { event, ...(now() || { active: false }), ...extra });
  const emitStop = (c, reason) => events.emit('mood', { event: 'stop', active: false, serial: c.serial, device: c.device, moodId: c.mood.id, name: c.mood.name, reason, error: c.error || null });

  // Hooks for the queue (server.js), one set per mood started: they only act while that mood is the one playing
  // (a mood replaced by another on the same Echo must not end the new one)
  const hooksFor = (c) => ({
    onItem(run, item) {
      if (cur !== c) return;
      if (c.item && c.item !== item) finishPhrase(c);
      c.item = item; c.phraseAt = Date.now(); c.tracks = 0;
      if (item.layer === 'mood') { state().seen[key(c.mood, item.query)] = Date.now(); prune(); saveStore(); }
      emit('phrase');
      verify(c, item);
    },
    onTrack(run) {
      if (cur !== c) return;
      c.tracks = run.tracks;
      if (c.tracks === 2 && c.item?.layer === 'mood' && Date.now() - c.phraseAt < SKIP_MS) finishPhrase(c, 'skip'); // skipped on the Echo
      emit('track');
    },
    onEnd(_run, reason) {
      if (cur !== c) return;
      finishPhrase(c);
      cur = null;
      emitStop(c, reason);
    },
  });
  // Did Apple Music start? If not (no result, Apple Music not linked, the Echo went offline), try another phrase,
  // up to MAX_FAILS times in a row, then stop with a clear message.
  function verify(c, item) {
    setTimeout(async () => {
      if (cur !== c || c.item !== item) return;
      const i = await playerInfo(c.serial, true).catch(() => ({}));
      if (cur !== c || c.item !== item) return;
      const ok = i.state === 'PLAYING' && /apple/i.test(i.provider?.providerName || '');
      if (ok) { c.fails = 0; return; }
      if (i.state === 'PAUSED' && i.infoText?.title) return; // paused by someone: leave it
      c.fails = (c.fails || 0) + 1;
      (c.failed ||= []).push(item.query);
      item.finished = true; // not the phrase's fault as such: no score
      console.log(`Mood "${c.mood.name}": "${item.query}" didn't start (${i.state || 'no state'}${i.provider?.providerName ? `, ${i.provider.providerName}` : ''})`);
      if (c.fails >= MAX_FAILS) {
        // Most often Alexa answered "I couldn't find any …": Apple Music only finds artist, song, album and playlist names
        c.error = `Nothing started on ${c.device} for "${c.failed.slice(-MAX_FAILS).join('", "')}". If Alexa said "I couldn't find…", edit the mood's phrases to artist, song, album or playlist names. Otherwise check that the Echo is online and Apple Music is linked in the Alexa app (Settings → Music & Podcasts).`;
        return stopPlaylist(c.serial, 'error');
      }
      playlistStep(1).catch((e) => console.log('Mood: next phrase failed:', e.message));
    }, VERIFY_MS).unref?.();
  }
  function prune() {
    const s = state(), old = Date.now() - SEEN_MS;
    for (const [k, at] of Object.entries(s.seen)) if (at < old) delete s.seen[k];
  }

  // ---------- play ----------
  async function play(input) {
    const m = mood(input.moodId);
    const s = state();
    const dev = musicDevice(input.device);
    if (dev.online === false) throw httpErr(503, `${dev.accountName} is offline`);
    const layerIn = input.frequencyLayer === undefined ? m.frequencyLayer : input.frequencyLayer;
    const layer = layerIn && F.preset(layerIn) && !F.preset(layerIn).headphonesOnly ? layerIn : null;
    if (layerIn && F.preset(layerIn)?.headphonesOnly) throw httpErr(400, `${F.preset(layerIn).name} is binaural: headphones only. ${F.HELP}`);
    const opts = {
      intensity: Math.max(1, Math.min(5, Math.round(Number(input.intensity)) || m.energy)),
      language: M.languageOk(input.language) ? input.language : s.prefs.language,
      vocals: M.VOCALS.includes(input.vocals) ? input.vocals : m.vocals,
      frequencyLayer: layer,
      volume: input.volume == null || input.volume === '' ? m.defaultVolume : Math.max(0, Math.min(10, Math.round(Number(input.volume)))),
      sleepMinutes: input.sleepMinutes === undefined ? m.defaultSleepMinutes : Math.max(0, Math.min(600, Math.round(Number(input.sleepMinutes)) || 0)) || null,
    };
    if (!Number.isFinite(opts.volume)) throw httpErr(400, '"volume" is 0-10');
    // A second tap within a moment replaces this one before anything is sent; after the volume, only the latest
    // request goes on to play (Amazon answers bursts with "rate exceeded" and a ~50 s wait)
    const my = ++gen;
    const superseded = () => my !== gen && { superseded: true, device: dev.accountName, moodId: m.id };
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    if (superseded()) return superseded();
    // Volume first, so the music doesn't start loud; not sent when the Echo is already there
    if ((await getVolume(dev).catch(() => null)) !== opts.volume * 10) await setVolume(dev, opts.volume * 10);
    if (superseded()) return superseded();
    const ratio = m.frequencyRatio ?? s.prefs.freqRatio;
    const c = { serial: dev.serialNumber, device: dev.accountName, mood: m, opts, layer, ratio: layer ? ratio : null, cadence: 'mood', startedAt: Date.now(), tracks: 0, fails: 0 };
    const items = makeItems(c, 3);
    let adding = null;
    const more = () => (adding ||= Promise.resolve(makeItems(c, 3)).finally(() => { adding = null; }));
    const prev = cur;
    cur = c; // before stopping the old run: its hooks see they're no longer current and stay out
    if (prev) { finishPhrase(prev); emitStop(prev, 'replaced'); }
    stopPlaylist(); // whatever plays from here (a mix, a playlist, another mood) ends; this mood's run starts below
    try {
      await playlistPlay(dev, { id: null, items, more, station: true, mood: m.id, ...hooksFor(c) }, 0);
    } catch (e) {
      if (cur === c) { cur = null; stopPlaylist(dev.serialNumber, 'error'); }
      throw httpErr(502, `Couldn't start "${m.name}" on ${dev.accountName}: ${e.message || e}`);
    }
    // Stopped while Amazon held the play command (its "rate exceeded" retry can take ~50 s): the music starts anyway
    // when the retry lands, so pause it again. Replaced by another mood: that one's own play follows, nothing to do.
    if (cur !== c) {
      if (!cur) await p((cb) => alexa.sendCommand(dev.serialNumber, 'pause', null, cb)).catch(() => {});
      return { stopped: true, device: dev.accountName, moodId: m.id };
    }
    c.sleepAt = setSleep(dev, opts.sleepMinutes || 0);
    s.last = { moodId: m.id, serial: dev.serialNumber, opts, at: Date.now() };
    saveStore();
    emit('start', { notify: !!store.notify.moods });
    return { device: dev.accountName, moodId: m.id, playing: c.item?.query || items[0].query, sleepAt: c.sleepAt, now: now() };
  }
  async function next() {
    const c = cur;
    if (!c) throw httpErr(409, 'No mood is playing');
    if (Date.now() - c.phraseAt < SKIP_MS) finishPhrase(c, 'skip');
    await playlistStep(1);
    return { device: c.device, playing: cur?.item?.query || null, now: now() };
  }
  async function stop(pause = true) {
    gen++; // a start still waiting on the volume step gives up before playing
    const c = cur;
    if (!c) return { stopped: false };
    stopPlaylist(c.serial, 'stopped');
    if (pause) await p((cb) => alexa.sendCommand(c.serial, 'pause', null, cb)).catch(() => {});
    setSleep({ serialNumber: c.serial }, 0);
    return { stopped: true, device: c.device, moodId: c.mood.id };
  }

  // ---------- routes ----------
  const moodList = () => {
    const s = state();
    return { groups: M.GROUPS, languages: M.LANGUAGES, mixes: M.MIXES, icons: M.ICONS, moods: moods(), prefs: s.prefs, last: s.last, favorites: s.favorites };
  };
  router.get('/moods', (_req, res) => res.json(moodList()));
  router.get('/moods/suggest', (req, res) => {
    const at = req.query.at ? Date.parse(req.query.at) : Date.now();
    if (!Number.isFinite(at)) return res.status(400).json({ error: '"at" must be a date and time' });
    res.json(M.suggestMood(at, state(), moods()));
  });
  router.get('/moods/now', wrap(async (req, res) => {
    res.json(now(req.query.device ? musicDevice(req.query.device).serialNumber : null) || { active: false });
  }));
  router.post('/moods/play', wrap(async (req, res) => res.json(await play(req.body || {}))));
  router.post('/moods/next', wrap(async (_req, res) => res.json(await next())));
  router.post('/moods/stop', wrap(async (req, res) => res.json(await stop(req.body?.pause !== false))));
  router.post('/moods/favorite', wrap(async (req, res) => {
    const s = state(), m = mood(req.body?.moodId), on = req.body?.on !== false;
    s.favorites = on ? [m.id, ...s.favorites.filter((x) => x !== m.id)].slice(0, M.LIMITS.favorites) : s.favorites.filter((x) => x !== m.id);
    saveStore();
    res.json({ favorites: s.favorites });
  }));
  router.post('/moods/prefs', wrap(async (req, res) => {
    const s = state(), b = req.body || {};
    if (typeof b.ambience === 'boolean') s.prefs.ambience = b.ambience;
    if (b.freqRatio != null) { const r = Math.round(Number(b.freqRatio)); if (!(r >= 0 && r <= 10)) throw httpErr(400, '"freqRatio" is 0-10'); s.prefs.freqRatio = r; }
    if (b.language != null) { if (!M.languageOk(b.language)) throw httpErr(400, 'Unknown language'); s.prefs.language = b.language; }
    saveStore();
    res.json(s.prefs);
  }));
  router.post('/moods/reset', wrap(async (req, res) => { // built-ins back as shipped: one, or all
    const s = state(), id = req.body?.id;
    if (id) { if (!M.builtInMood(id)) throw httpErr(404, 'Only built-in moods can be reset'); delete s.overrides[id]; s.hidden = s.hidden.filter((x) => x !== id); }
    else { s.overrides = {}; s.hidden = []; }
    saveStore();
    res.json(moodList());
  }));
  // Create (no id, or a new one) or change a mood; a built-in's changes are kept apart, so it can be reset
  router.post('/moods', wrap(async (req, res) => {
    const s = state(), b = req.body?.mood || {};
    if (b.id && M.builtInMood(b.id)) {
      s.overrides[b.id] = { ...s.overrides[b.id], ...M.validateMood(b, { partial: true }) };
      s.hidden = s.hidden.filter((x) => x !== b.id);
    } else {
      const clean = M.validateMood(b);
      const existing = s.custom.find((x) => x.id === b.id);
      if (existing) Object.assign(existing, clean);
      else {
        if (s.custom.length >= M.LIMITS.custom) throw httpErr(409, `Up to ${M.LIMITS.custom} moods of your own`);
        const base = clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'mood';
        let id = base; for (let i = 2; moods().some((x) => x.id === id); i++) id = `${base}-${i}`;
        s.custom.push({ id, ...clean });
        b.id = id;
      }
    }
    saveStore();
    res.json(mood(b.id));
  }));
  router.post('/moods/:id/delete', wrap(async (req, res) => {
    const s = state(), id = req.params.id, builtIn = !!M.builtInMood(id);
    if (builtIn) { if (!s.hidden.includes(id)) s.hidden.push(id); delete s.overrides[id]; }
    else if (!s.custom.some((x) => x.id === id)) throw httpErr(404, 'Mood not found');
    else s.custom = s.custom.filter((x) => x.id !== id);
    s.favorites = s.favorites.filter((x) => x !== id);
    if (cur?.mood.id === id) await stop(false);
    saveStore();
    res.json({ deleted: id, builtIn });
  }));
  router.get('/focus/presets', (_req, res) => res.json({ presets: F.PRESETS, help: F.HELP }));

  return {
    router, now, play, next, stop,
    // Next pressed in the app soon after a phrase started: that phrase was a miss
    onSkip(run) { const c = cur; if (c && run.serial === c.serial && Date.now() - c.phraseAt < SKIP_MS) finishPhrase(c, 'skip'); },
    // A song favourited while a mood plays (on the Echo music plays on)
    onFavorite() { const c = cur; if (c && c.item?.layer === 'mood' && c.serial === store.musicDevice) { score(c.mood, c.item.query, 1); saveStore(); } },
  };
};
