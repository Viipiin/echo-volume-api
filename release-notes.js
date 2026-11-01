// What changed in each version, in words for the people using the app. Shown in the app ("What's new" opens once
// after an update; Settings → About and the menu link show it any time), served at /api/release-notes, and used
// for the desktop app's "Updated" notification. Newest first. The first entry's version must match package.json.
//
// type: 'new' (something you couldn't do before) | 'improved' | 'fixed'
// where (optional): the screen it's on, so people can find it
const RELEASES = [
  {
    version: '5.2.1', date: '2026-11-01',
    headline: 'Moods move on when Apple Music can\'t find a phrase',
    items: [
      { type: 'fixed', where: 'Moods', text: 'When Alexa answered "I couldn\'t find…", the track from before kept playing and the mood took that as its phrase working (and sometimes learned to like it). Now the mood notices, plays the next phrase, and picks that phrase rarely from then on.' },
      { type: 'fixed', where: 'Moods', text: 'A phrase is no longer marked "Nothing started" while Amazon was still holding the play command.' },
      { type: 'improved', where: 'Moods', text: 'Phrases Apple Music couldn\'t find (hindi ghazals, hindi club songs, hindi morning songs, morning bhajans…) are replaced by artists it does find (Jagjit Singh, Badshah, Lucky Ali, Anuradha Paudwal…).' },
      { type: 'fixed', where: 'Search', text: 'Remixes and live versions ("Sufi (Venky Remix)") now play: the version in brackets is left out of what Alexa is asked, which made it miss the song.' },
      { type: 'fixed', where: 'Activity', text: 'Alexa\'s reply is now found for healing-frequency phrases like "40 Hz gamma waves".' },
    ],
  },
  {
    version: '5.2.0', date: '2026-11-01',
    headline: 'Activity log, a Hindi-English-Punjabi mix for moods, and far fewer Amazon delays',
    items: [
      { type: 'new', where: 'Activity', text: 'See everything Echo Volume did: each command, where it came from, what Alexa heard and what Alexa said back. It opens on Problems, so anything that didn\'t work (for example "I couldn\'t find… on Apple Music", or music that never started) is easy to spot and fix. Scenes show each step; moods show each phrase. Kept for 30 days, with search and export.' },
      { type: 'new', where: 'Moods, Scenes', text: 'Mix: Hindi, English and Punjabi taking turns at random, never the same language twice in a row. Pick it when you play a mood, or for a mood step in a scene.' },
      { type: 'improved', where: 'Moods', text: 'Morning Energizer now plays artists Apple Music can find (Diljit Dosanjh, Vishal-Shekhar, Dua Lipa…) instead of descriptions Alexa answered with "I couldn\'t find…".' },
      { type: 'improved', text: 'Far fewer long "Amazon is busy" waits. Requests to Amazon are spaced out, and they slow down by themselves when Amazon pushes back. A burst now costs a few seconds instead of a 30–60 second stall.' },
      { type: 'improved', where: 'Moods', text: 'When a mood can\'t start, the message names the phrases Alexa couldn\'t find and says how to fix them. The phrase editor explains that artist, song, album or playlist names work best.' },
      { type: 'fixed', where: 'Home', text: 'The TV card no longer says "Checking…" for half a minute when Alexa isn\'t signed in.' },
    ],
  },
  {
    version: '5.1.0', date: '2026-10-31',
    headline: 'A new look, Moods, and 120 fresh songs on every Top songs refresh',
    items: [
      { type: 'new', where: 'Moods', text: 'Moods: pick how you feel or what you\'re doing (Study, Deep Work, Morning Energizer, Sleep…) and matching Apple Music plays on any Echo without end, with optional healing frequencies. It learns from what you skip.' },
      { type: 'new', where: 'Tray', text: 'A Moods menu in the tray, a hotkey (Ctrl+Alt+M) and notifications when a mood starts.' },
      { type: 'new', where: 'Scenes', text: 'Scenes can play or stop a mood, with ready-made mood examples.' },
      { type: 'improved', text: 'A new look: new logo, icons instead of emoji, a custom title bar, a flat graphite Dark theme, and Auto that follows Windows.' },
      { type: 'improved', where: 'Home', text: 'Top songs: 120 per refresh from 250 artists in 18 styles, and a refresh comes back almost at once.' },
    ],
  },
  {
    version: '5.0.0', date: '2026-10-31',
    headline: 'A proper installer, and start with Windows',
    items: [
      { type: 'new', text: 'A new Setup app: choose just you or everyone on the PC, see real progress, and it undoes everything if cancelled. It upgrades older installs and keeps your settings.' },
      { type: 'new', where: 'Tray', text: '"Start with Windows" in the tray menu (starts quietly in the tray), and a notification after an update.' },
      { type: 'new', text: 'Uninstall from inside the app; it asks before deleting your data.' },
    ],
  },
  {
    version: '3.0.0', date: '2026-10-22',
    headline: 'A redesigned app with a sidebar, a phone tab bar and the Midnight theme',
    items: [
      { type: 'improved', text: 'Redesigned: a collapsible sidebar on the PC, a tab bar on phones, and the Midnight theme.' },
      { type: 'improved', where: 'Smart home', text: 'Smart home shows real on/off states, leaves out room groups, and tells two TVs with the same name apart.' },
      { type: 'fixed', where: 'Settings', text: 'Turning off an Echo Show screen works reliably.' },
      { type: 'fixed', text: 'Routines and Stop all also end a playlist or Surprise mix.' },
    ],
  },
];

// Releases after `since` (exclusive), newest first; all of them without `since`
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const since = (version) => (version ? RELEASES.filter((r) => newer(r.version, version)) : RELEASES);

module.exports = { RELEASES, since, newer };
