// Activity log: what Echo Volume was asked to do, what it sent to Amazon, and what actually happened.
// Pure bookkeeping (no Alexa calls): server.js feeds it and serves it at /api/activity.
//
// An entry is one thing asked for: a button pressed on the PC or the phone, an API call, a scene (with its steps as
// children), a scheduled run, a mood phrase, a song from a queue, or something about Amazon itself (throttling,
// sign-in). It records where it came from, the Amazon calls made for it (how long they waited in the request gate,
// whether they were throttled), what Alexa said back (from voice history, matched afterwards), and a status:
//   running → ok | problem (it ran, but didn't do what was meant: "I couldn't find…", nothing started) | failed (error)
// Background reads (what's playing, volumes…) are too many to keep one by one: they're counted per hour and endpoint.
// Kept for `days` (30) in one JSON file, at most `maxEntries` entries.
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SOURCES = ['pc', 'phone', 'desktop', 'api', 'scene', 'schedule', 'mood', 'queue', 'amazon', 'system'];
const KINDS = ['action', 'automation', 'amazon', 'system'];
const STATUSES = ['running', 'ok', 'problem', 'failed'];
const MAX_CALLS = 12; // Amazon calls kept per entry (the rest are only counted)
const SECRET = /key|token|secret|password|cookie|csrf/i;

// What Alexa says when a command didn't do what was asked
const BAD_REPLY = /couldn'?t find|can'?t find|could not find|not able to|unable to|sorry|having trouble|didn'?t catch|not sure|isn'?t supported|not supported|don'?t know|something went wrong|try again|isn'?t available|not available|doesn'?t support/i;

// Small, safe copy of a request body: secrets dropped, long strings cut, depth and size bounded
function clean(v, depth = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
  if (depth > 2) return '…';
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => clean(x, depth + 1)).concat(v.length > 5 ? [`+${v.length - 5} more`] : []);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 15)) out[k] = SECRET.test(k) ? '•••' : clean(x, depth + 1);
    return out;
  }
  return String(v).slice(0, 50);
}
// Endpoint pattern for counting reads: no query string, long ids folded
const pattern = (p) => String(p || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/[0-9a-z]{16,}(?=\/|$)/gi, '/:id').replace(/\/\d{4,}(?=\/|$)/g, '/:n').slice(0, 80);

// What a behaviors command asked for: the Echo, and the words Alexa will log ("turn on tv", the music phrase)
function parseCommand(body) {
  const found = { serial: null, text: null };
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    let op = node.operationPayload;
    if (typeof op === 'string') { try { op = JSON.parse(op); } catch { op = null; } }
    if (op) {
      found.serial ||= op.deviceSerialNumber || null;
      found.text ||= op.text || op.searchPhrase || null;
    }
    for (const n of node.nodesToExecute || []) walk(n, depth + 1);
    if (node.startNode) walk(node.startNode, depth + 1);
  };
  try { const b = JSON.parse(body); walk(typeof b.sequenceJson === 'string' ? JSON.parse(b.sequenceJson) : b); } catch {}
  return found;
}
// Alexa writes "hz" out as "hertz" in voice history ("play 40 hertz gamma waves"), so both sides say hertz
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u0a7f ]+/g, ' ').replace(/(\d)\s*hz\b|\bhz\b/g, '$1 hertz').replace(/\s+/g, ' ').trim();

// Voice history records → entries waiting for Alexa's reply, on the same Echo, the record within -3 s … +40 s of
// the command. Alexa logs the words it was sent, so a record whose words contain an entry's command belongs to it;
// a record with no such entry goes to the latest command sent before it that has no words of its own to match.
// Returns [{ entry, record }].
function matchReplies(entries, records) {
  const out = [], taken = new Set();
  const sorted = [...records].filter((r) => r.serial && r.at).sort((a, b) => a.at - b.at);
  const near = (e, r) => !taken.has(e.id) && e.reply && e.reply.serial === r.serial && r.at - e.reply.sentAt >= -3000 && r.at - e.reply.sentAt <= 40000;
  for (const r of sorted) {
    const heard = words(r.text);
    const cands = entries.filter((e) => near(e, r));
    let best = cands.filter((e) => e.reply.text && heard.includes(words(e.reply.text)))
      .sort((a, b) => Math.abs(r.at - a.reply.sentAt) - Math.abs(r.at - b.reply.sentAt))[0];
    if (!best) {
      const loose = cands.filter((e) => !e.reply.text);
      best = loose.filter((e) => e.reply.sentAt <= r.at + 500).sort((a, b) => b.reply.sentAt - a.reply.sentAt)[0] || loose[0];
    }
    if (best) { taken.add(best.id); out.push({ entry: best, record: r }); }
  }
  return out;
}

function createActivityLog({ file, days = 30, maxEntries = 10000, saveDelay = 3000, onChange = () => {}, log = () => {} } = {}) {
  const als = new AsyncLocalStorage();
  let entries = [], reads = {}; // reads: "hour|pattern" -> { hour, path, count, errors, totalMs, maxMs }
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      entries = Array.isArray(raw.entries) ? raw.entries : [];
      reads = raw.reads && typeof raw.reads === 'object' ? raw.reads : {};
      for (const e of entries) if (e.status === 'running') { e.status = 'problem'; (e.notes ||= []).push('Echo Volume stopped before this finished'); }
    } catch {}
  }
  const byId = new Map(entries.map((e) => [e.id, e]));

  function prune() {
    const old = Date.now() - days * 86400000;
    if (entries.length > maxEntries || (entries[0] && entries[0].at < old)) {
      const keep = entries.filter((e) => e.at >= old).slice(-maxEntries);
      for (const e of entries) if (!keep.includes(e)) byId.delete(e.id);
      entries = keep;
    }
    const oldHour = Math.floor(old / 3600000);
    for (const [k, b] of Object.entries(reads)) if (b.hour < oldHour) delete reads[k];
  }
  let timer = null, writing = false, again = false;
  function save() {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (writing) { again = true; return; }
      prune();
      writing = true;
      const text = JSON.stringify({ v: 1, entries, reads }), tmp = file + '.tmp';
      fs.writeFile(tmp, text, (e) => {
        const done = (e2) => { writing = false; if (e2) log(`Saving the activity log failed: ${e2.message}`); if (again) { again = false; save(); } };
        if (e) return done(e);
        fs.rename(tmp, file, (e2) => (e2 ? fs.writeFile(file, text, done) : done()));
      });
    }, saveDelay);
    timer.unref?.();
  }
  const flush = () => { if (!file) return; try { prune(); fs.writeFileSync(file, JSON.stringify({ v: 1, entries, reads })); } catch {} };
  const changed = (e) => { save(); try { onChange(e); } catch {} };

  // ---------- writing ----------
  function start({ source = 'system', kind = 'action', title, device = null, detail = null, parent = null }) {
    const e = {
      id: crypto.randomUUID(), at: Date.now(), source: SOURCES.includes(source) ? source : 'system', kind: KINDS.includes(kind) ? kind : 'action',
      title: String(title || 'Action').slice(0, 160), device: device ? String(device).slice(0, 60) : null, detail: detail == null ? null : clean(detail),
      parent: parent || null, status: 'running', ms: null, calls: [], moreCalls: 0, notes: [], alexa: null, reply: null,
    };
    entries.push(e); byId.set(e.id, e);
    if (entries.length > maxEntries + 500) prune();
    changed(e);
    return e;
  }
  // status only moves forward to something worse once it's a problem (a later "ok" doesn't hide a failure)
  const RANK = { running: 0, ok: 1, problem: 2, failed: 3 };
  // A step or queued song that went wrong makes the scene or action it belongs to a problem too
  function setStatus(e, status, depth = 0) {
    if (!e || !STATUSES.includes(status)) return;
    if (e.status === 'running' || RANK[status] > RANK[e.status]) e.status = status;
    const parent = (status === 'problem' || status === 'failed') && depth < 5 && e.parent && byId.get(e.parent);
    if (!parent) return;
    if (parent.status === 'running') parent.childProblem = true; // finish() will mark it
    else if (RANK[parent.status] < RANK.problem) { setStatus(parent, 'problem', depth + 1); changed(parent); }
  }
  function finish(e, { status = 'ok', error = null, http = null, result = null } = {}) {
    if (!e) return;
    setStatus(e, e.childProblem && status === 'ok' ? 'problem' : status);
    delete e.childProblem;
    if (e.ms == null) e.ms = Date.now() - e.at;
    if (error) e.error = String(error).slice(0, 300);
    if (http) e.http = http;
    if (result) e.result = clean(result);
    changed(e);
  }
  function note(e, text, status) {
    if (!e) return;
    if (e.notes.length < 20) e.notes.push(String(text).slice(0, 300));
    if (status) setStatus(e, status);
    changed(e);
  }
  function update(e, patch) {
    if (!e) return;
    for (const k of ['title', 'device', 'source', 'kind']) if (patch[k] != null) e[k] = String(patch[k]).slice(0, 160);
    changed(e);
  }
  // Something that happened at once (Amazon throttling, signed in…)
  function event({ source = 'system', kind = 'system', title, status = 'ok', detail = null, device = null, parent = null }) {
    const e = start({ source, kind, title, detail, device, parent });
    finish(e, { status });
    return e;
  }

  // ---------- context: which entry the code running now belongs to ----------
  const run = (e, fn) => (e ? als.run(e, fn) : fn());
  const current = () => als.getStore() || null;
  const detached = (fn) => als.exit(fn); // background work that belongs to no entry (its reads are only counted)

  // One Amazon request (from the request gate): attached to the entry it was made for; reads are also counted per hour
  function amazonCall({ kind, path, method = 'GET', ms = 0, waited = 0, error = null, shared = false, retry = false }, e = current()) {
    if (kind === 'read') {
      const hour = Math.floor(Date.now() / 3600000), pth = pattern(path), k = `${hour}|${pth}`;
      const b = (reads[k] ||= { hour, path: pth, count: 0, errors: 0, shared: 0, totalMs: 0, maxMs: 0 });
      if (shared) b.shared++; else b.count++;
      if (error) b.errors++;
      b.totalMs += ms; b.maxMs = Math.max(b.maxMs, ms);
      save();
    }
    if (!e) return;
    if (e.calls.length < MAX_CALLS) e.calls.push({ kind, path: pattern(path), method, ms: Math.round(ms), waited: Math.round(waited), error: error ? String(error).slice(0, 120) : null, shared, retry });
    else e.moreCalls++;
    if (waited > 5000) note(e, `Waited ${Math.round(waited / 1000)}s in the request gate (Amazon was being paced)`);
    if (ms > 8000) note(e, `Amazon took ${Math.round(ms / 1000)}s to answer ${pattern(path)} (most likely throttled, then retried)`);
    changed(e);
  }
  // A voice-style command or music request went to this Echo: Alexa's reply will be looked up in voice history
  function expectReply(serial, e = current(), text = null) {
    if (e && serial && !e.reply) { e.reply = { serial, sentAt: Date.now(), tries: 0, text: text ? String(text).slice(0, 200) : null }; changed(e); }
  }
  const waitingForReply = () => entries.filter((e) => e.reply && !e.alexa && e.reply.tries < 2);
  // Attach a voice history record (Alexa's reply) to an entry; a reply like "I couldn't find…" makes it a problem
  function attachReply(e, r) {
    e.alexa = { heard: String(r.text || '').slice(0, 200), said: String(r.response || '').slice(0, 300), at: r.at };
    if (BAD_REPLY.test(e.alexa.said)) setStatus(e, 'problem');
    changed(e);
  }
  function replyTried(e) { if (e.reply) { e.reply.tries++; if (e.reply.tries >= 2 && !e.alexa) note(e, 'Alexa\'s reply wasn\'t found in voice history'); save(); } }

  // ---------- reading ----------
  // top: only entries that aren't a step of another (a scene's steps, a mood's phrases are under their parent)
  function query({ status, source, kind, q, before, limit = 100, parent, top = false } = {}) {
    const want = status === 'issues' ? ['problem', 'failed'] : status ? [status] : null;
    const text = q ? String(q).toLowerCase() : null;
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < Math.min(500, limit); i--) {
      const e = entries[i];
      if (before && e.at >= Number(before)) continue;
      if (parent !== undefined ? e.parent !== parent : false) continue;
      if (top && e.parent && byId.has(e.parent)) continue;
      if (want && !want.includes(e.status)) continue;
      if (source && e.source !== source) continue;
      if (kind && e.kind !== kind) continue;
      if (text && !`${e.title} ${e.device || ''} ${e.error || ''} ${e.alexa?.said || ''} ${e.alexa?.heard || ''} ${e.notes.join(' ')}`.toLowerCase().includes(text)) continue;
      out.push(e);
    }
    return out;
  }
  const children = (id) => entries.filter((e) => e.parent === id);
  const get = (id) => byId.get(id) || null;
  function summary(hours = 24) {
    const since = Date.now() - hours * 3600000, s = { total: 0, ok: 0, problem: 0, failed: 0, running: 0, throttles: 0 };
    for (let i = entries.length - 1; i >= 0 && entries[i].at >= since; i--) {
      const e = entries[i];
      s.total++; s[e.status]++;
      if (e.kind === 'amazon' && /throttl/i.test(e.title)) s.throttles++;
    }
    return s;
  }
  function readStats(hours = 24) {
    const from = Math.floor((Date.now() - hours * 3600000) / 3600000);
    return Object.values(reads).filter((b) => b.hour >= from).sort((a, b) => b.hour - a.hour || b.count - a.count);
  }
  function clear() { entries = []; reads = {}; byId.clear(); save(); }

  return { start, finish, note, update, event, run, current, detached, amazonCall, expectReply, waitingForReply, attachReply, replyTried, query, children, get, summary, readStats, clear, flush, all: () => entries };
}

module.exports = { createActivityLog, matchReplies, parseCommand, clean, pattern, BAD_REPLY, SOURCES, STATUSES };
