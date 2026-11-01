// One gate for every request Echo Volume makes to Amazon, so bursts never reach it.
//
// Amazon throttles its Alexa web API ("Too many requests" / "Rate exceeded"), and alexa-remote2 then waits
// 30-60 s before retrying once, holding the request the whole time. Its limits aren't published, so instead of
// guessing a fixed gap this adapts:
//   - Commands (Amazon's "behaviors" API, which plays music, speaks, sets the volume..., plus play/pause/next and
//     any PUT/DELETE) go one at a time, each waiting for the one before, at least `gap` apart.
//   - Reads (player state, volumes, lists...) go a short gap apart, and identical reads already on their way are
//     shared instead of being sent twice (several open pages polling the same thing).
//   - When Amazon throttles anyway, the gap doubles (up to maxGap) and reads slow down for `cooldownMs`; after a
//     run of commands that went through, it eases back towards the base gap.
// attach() routes alexa-remote2's single HTTP entry point (httpsGetCall) through the gate, so calls made inside
// the library (sendSequenceCommand, getPlayerInfo, init...) are covered without changing each call site.

function createLimiter({ baseGap = 1500, maxGap = 12000, readGap = 250, slowReadGap = 2000, cooldownMs = 60000, easeAfter = 5, log = () => {} } = {}) {
  let gap = baseGap, cooldownUntil = 0, okStreak = 0, throttles = 0, lastThrottleAt = 0;
  let writeChain = Promise.resolve(), writeLast = 0, readNext = 0, waitingWrites = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cooling = () => Date.now() < cooldownUntil;

  // Commands: strictly one after another; the next starts `gap` after the previous one started and not before it ended
  function write(fn) {
    waitingWrites++;
    const run = writeChain.then(async () => {
      const wait = writeLast + gap - Date.now();
      if (wait > 0) await sleep(wait);
      writeLast = Date.now();
      waitingWrites--;
      return fn();
    });
    writeChain = run.catch(() => {});
    return run;
  }
  // Reads: started a short gap apart (longer while Amazon is throttling), without waiting for each other
  async function read(fn) {
    const start = Math.max(Date.now(), readNext);
    readNext = start + (cooling() ? slowReadGap : readGap);
    if (start > Date.now()) await sleep(start - Date.now());
    return fn();
  }
  function throttled() {
    const now = Date.now();
    throttles++;
    okStreak = 0;
    if (now - lastThrottleAt > 2000) gap = Math.min(maxGap, gap * 2); // one burst = one step up
    lastThrottleAt = now;
    cooldownUntil = now + cooldownMs;
    log(`Amazon is throttling: commands now ${Math.round(gap / 100) / 10}s apart, reads slowed for ${Math.round(cooldownMs / 1000)}s`);
  }
  function wentThrough() {
    if (cooling() || gap === baseGap || ++okStreak < easeAfter) return;
    okStreak = 0;
    gap = Math.max(baseGap, Math.round(gap * 0.75));
    if (gap === baseGap) log(`Amazon is answering normally again: commands back to ${baseGap / 1000}s apart`);
  }
  // The library re-sent a request by itself (its retry after a throttle): the next command counts its gap from now
  const resent = () => { writeLast = Date.now(); };
  const status = () => ({ gapMs: gap, throttledUntil: cooling() ? cooldownUntil : null, throttles, waitingCommands: waitingWrites });
  return { write, read, throttled, wentThrough, resent, status };
}

// Commands: the behaviors API (sequences, play search phrases and their validation), the player's command
// endpoint, and anything that changes something by PUT/DELETE. Everything else is a read (some reads are POSTs,
// e.g. smart home state queries).
const isCommand = (path, method) => /^\/api\/(behaviors\/|np\/command)/.test(path) || method === 'PUT' || method === 'DELETE';
// alexa-remote2 logs this just before it waits and retries a throttled request
const THROTTLE_LOG = /rate exceeded|too many requests|throttl/i;

// hooks.context(): who the request is for (captured when it's made); hooks.onCall(info, context) when it's answered:
// { kind: 'command' | 'read', path, method, ms (Amazon's answer time), waited (in the gate), error, shared, retry, body }
function attach(alexa, limiter, hooks = {}) {
  const context = hooks.context || (() => null);
  const report = (info, ctx) => { try { hooks.onCall?.(info, ctx); } catch {} };
  if (typeof alexa.httpsGetCall !== 'function') {
    console.log('⚠ Amazon request gate not installed: this alexa-remote2 version has no httpsGetCall');
    return false;
  }
  const raw = alexa.httpsGetCall.bind(alexa);
  const inflight = new Map(); // read key -> callbacks waiting for the same answer
  alexa.httpsGetCall = (path, callback, flags = {}) => {
    // The library's own retries (after a throttle or a 503) already waited and belong to a request that holds
    // a place in the queue: queueing them again behind it would never finish
    const method = (flags.method || 'GET').toUpperCase();
    const ctx = context(), asked = Date.now();
    if (flags.isRetry) {
      if (isCommand(path, method)) limiter.resent();
      return raw(path, callback, flags);
    }
    if (isCommand(path, method)) {
      return limiter.write(() => new Promise((done) => {
        const sent = Date.now();
        raw(path, (err, body) => {
          if (!err) limiter.wentThrough();
          report({ kind: 'command', path, method, ms: Date.now() - sent, waited: sent - asked, error: err?.message || null, body: flags.data || null }, ctx);
          done();
          if (callback) callback(err, body);
        }, flags);
      }));
    }
    const key = method === 'GET' && !flags.data ? `${flags.host || ''}${path}` : null;
    if (key && inflight.has(key)) {
      inflight.get(key).push((err, body) => { report({ kind: 'read', path, method, ms: Date.now() - asked, waited: 0, error: err?.message || null, shared: true }, ctx); if (callback) callback(err, body); });
      return;
    }
    if (key) inflight.set(key, [callback]);
    limiter.read(() => {
      const sent = Date.now();
      raw(path, (err, body) => {
        report({ kind: 'read', path, method, ms: Date.now() - sent, waited: sent - asked, error: err?.message || null }, ctx);
        const cbs = key ? inflight.get(key) : [callback];
        if (key) inflight.delete(key);
        for (const cb of cbs) if (cb) cb(err, body);
      }, flags);
    });
  };
  return true;
}

module.exports = { createLimiter, attach, isCommand, THROTTLE_LOG };
