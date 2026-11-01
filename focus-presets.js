// Healing-frequency presets for Moods: what's searched on Apple Music for the frequency layer.
// An Echo is one speaker, so binaural beats (a different tone in each ear) can't work on it: those presets are
// marked headphonesOnly and are never mixed in on their own. Speaker-friendly kinds: isochronic tones (a single tone
// pulsing on and off), plain tones, 432 / 528 Hz music, Solfeggio, singing bowls and chanting.

const PRESETS = [
  { id: 'alpha', name: 'Alpha', band: 'alpha', hz: 10, kind: 'isochronic', summary: 'Relaxed focus, light calm',
    phrases: ['alpha waves isochronic tones', 'alpha waves focus music', 'alpha wave relaxation music', 'alpha waves study music', '10 hz alpha waves'] },
  { id: 'theta', name: 'Theta', band: 'theta', hz: 6, kind: 'isochronic', summary: 'Deep relaxation, drifting, meditation',
    phrases: ['theta waves isochronic tones', 'theta waves meditation music', 'theta wave deep relaxation', '6 hz theta waves', 'theta healing music'] },
  { id: 'delta', name: 'Delta', band: 'delta', hz: 2, kind: 'isochronic', summary: 'Deep sleep',
    phrases: ['delta waves sleep music', 'delta waves isochronic tones', 'delta wave deep sleep', '2 hz delta waves', 'delta waves for sleep'] },
  { id: 'beta', name: 'Beta', band: 'beta', hz: 18, kind: 'isochronic', summary: 'Alert, active thinking',
    phrases: ['beta waves focus music', 'beta waves isochronic tones', 'beta wave concentration music', 'beta waves for studying'] },
  { id: 'gamma', name: 'Gamma', band: 'gamma', hz: 40, kind: 'isochronic', summary: 'High focus, problem solving',
    phrases: ['40 hz gamma waves', 'gamma waves focus music', 'gamma wave isochronic tones', 'gamma waves concentration'] },
  { id: 'hz432', name: '432 Hz', band: null, hz: 432, kind: 'music', summary: 'Music tuned to 432 Hz: soft and warm',
    phrases: ['432 hz music', '432 hz healing music', '432 hz piano', '432 hz relaxing music', '432 hz meditation music'] },
  { id: 'hz528', name: '528 Hz', band: null, hz: 528, kind: 'music', summary: 'The “love frequency”: gentle, uplifting',
    phrases: ['528 hz music', '528 hz healing frequency', '528 hz love frequency', '528 hz meditation music', '528 hz sleep music'] },
  { id: 'solfeggio', name: 'Solfeggio', band: null, hz: '396–852', kind: 'tone', summary: 'The Solfeggio scale: 396, 417, 528, 639, 741, 852 Hz',
    phrases: ['solfeggio frequencies', '396 hz solfeggio', '417 hz solfeggio', '639 hz solfeggio', '741 hz solfeggio', '852 hz solfeggio'] },
  { id: 'bowls', name: 'Singing bowls', band: null, hz: null, kind: 'bowls', summary: 'Tibetan and crystal bowls',
    phrases: ['tibetan singing bowls', 'singing bowls meditation', 'crystal singing bowls', 'himalayan singing bowls', 'singing bowl sound bath'] },
  { id: 'om', name: 'Om', band: null, hz: 136.1, kind: 'chant', summary: 'Om chanting, 136.1 Hz',
    phrases: ['om chanting', 'om mantra meditation', 'om chanting 108 times', 'aum chanting meditation', 'om namah shivaya chant'] },
  // Headphones only: not offered for mixing on an Echo
  { id: 'alpha-binaural', name: 'Alpha binaural', band: 'alpha', hz: 10, kind: 'binaural', headphonesOnly: true, summary: 'Alpha, as binaural beats',
    phrases: ['alpha binaural beats', 'alpha waves binaural beats focus'] },
  { id: 'theta-binaural', name: 'Theta binaural', band: 'theta', hz: 6, kind: 'binaural', headphonesOnly: true, summary: 'Theta, as binaural beats',
    phrases: ['theta binaural beats', 'theta waves binaural beats meditation'] },
  { id: 'delta-binaural', name: 'Delta binaural', band: 'delta', hz: 2, kind: 'binaural', headphonesOnly: true, summary: 'Delta, as binaural beats',
    phrases: ['delta binaural beats sleep', 'delta waves binaural beats'] },
].map((p) => ({ headphonesOnly: false, ...p, speakerSafe: !p.headphonesOnly }));

const BYID = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
const preset = (id) => BYID[id] || null;

const HELP = 'Echo speakers play one sound for both ears, so binaural beats (a different tone in each ear) only work on '
  + 'headphones. On an Echo, use isochronic tones, 432 / 528 Hz music, Solfeggio, singing bowls or Om.';

module.exports = { PRESETS, preset, HELP };
