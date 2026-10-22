# Echo Volume

Control your Echo devices, Samsung TV, Apple Music & Podcasts and Alexa from your laptop or phone: volume, music,
radio, podcasts, alarms & timers, Alexa lists, scenes, announcements, routines and per-Echo settings. A small local
server with a web UI and a REST API, also packaged as a Windows desktop app.

> Amazon has no official public API for any of this. It uses **alexa-remote2**, the unofficial library behind the
> ioBroker / Node-RED / Home Assistant Alexa integrations, talking to Amazon's cloud with your Alexa login (not your
> local network). The TV uses Samsung's official SmartThings API.

## Features

- **Echo volume** per device and speaker group, mute, presets, global hotkeys with an on-screen indicator
- **Apple Music, Apple Podcasts & radio**: search, play, move between Echos, sleep timer, crossfade, favourites, "Surprise" mixes
- **Samsung TV** via SmartThings: power, volume, channel, input, apps, remote
- **Alexa**: alarms, timers & reminders, shopping/to-do lists, announcements, routines, sound effects, voice history, smart-home devices
- **Scenes** (multi-step actions, optionally scheduled) and **birthday/anniversary announcements**
- **Per-Echo settings**: Do Not Disturb, equalizer, Echo Show screen, Bluetooth
- **Live updates** from Amazon's push connection, **phone access** over Wi-Fi with a QR code
- **REST API** for scripts and shortcuts, and a **Windows desktop app** (Electron) with tray quick controls

## Project structure

```
server.js            Express server: REST API, Alexa login, live events, scheduler
alexa-features.js    Alexa features (alerts, lists, routines, music, scenes…)
smartthings.js       Samsung SmartThings OAuth + TV control
public/              Web UI (index.html, mini.html, smartthings.html, theme.css, PWA manifest)
desktop/             Electron app: main.js (window, tray, hotkeys), osd.html (volume overlay)
build/               App and tray icons used by electron-builder
scripts/make-icon.js Generates the icons
.env.example         Configuration template (copy to .env)
```

| Script | What it does |
|---|---|
| `npm start` | Run the server + web UI at http://localhost:5005 |
| `npm run app` | Run the desktop app in development |
| `npm run dist` | Build the Windows installer into `dist/` |
| `npm run icons` | Regenerate the icons in `build/` |

## Setup (Windows / Mac / Linux)

Requires Node.js 18+ and an Amazon account with Echo devices.

```bash
cd echo-volume-api
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm start
```

**First run only:** the console prints a login URL. Open `http://localhost:3001` in a browser (not one with the Alexa
app on it), sign in with your amazon.in account + OTP. Once you see the success page, stop (Ctrl+C) and run
`npm start` again. The session is saved to `cookie.json` and refreshed weekly automatically.

On success you'll see your devices listed, e.g. `• Vipin's Echo Show 8  [G000XXXXXXXX]  (KNIGHT)`. Put a name in
`.env` → `DEFAULT_DEVICE=Vipin's Echo Show 8` to skip the `device` field in API calls.

**Same setup as the desktop app:** once the desktop app has been set up, `npm start` uses its data folder
(`%APPDATA%\Echo Volume`): the same `.env`, Amazon login, SmartThings connection and saved favourites/scenes, so the
browser and the app behave the same. The startup line prints the folder; `DATA_DIR=.` uses the project folder instead.
Only one copy runs at a time: if the app (or another `npm start`) already owns the port, `npm start` says so and exits.

## The web UI

Open **http://localhost:5005**. The sections (a sidebar menu on a laptop, a tab bar at the bottom on a phone):

| Tab | What's there |
|---|---|
| **Home** | TV (SmartThings: power, volume, channel, input, apps, remote), **Apple Music & Podcasts**, and a card per Echo / speaker group (volume, presets, mute; groups show each member's volume) |
| **Alarms & timers** | Everything set on your Echos and the Alexa app; set timers, alarms and reminders; switch alarms on/off; delete |
| **Lists** | Your Alexa shopping and to-do lists: add, tick off, delete (synced with the Alexa app) |
| **Scenes** | Several actions in one tap, optionally on a schedule |
| **Alexa** | Announcements (optionally after a sound), routines, one-tap weather/news/calendar…, sound effects, voice history |
| **Smart home** | Lights, plugs and switches connected to Alexa |
| **Settings** | Per Echo: Do Not Disturb, equalizer, screen on/off, Bluetooth. Birthdays & anniversaries. Notifications. Phone access |

The header has **Stop all** (stops audio on every Echo), the theme picker (System / Light / Dark / Midnight, shared with the
desktop app) and a **● Live** indicator while instant updates from Amazon are connected.

### Apple Music & Podcasts

Link the **Apple Music** and **Apple Podcasts** skills in the Alexa app once. Then:

- **Play on** picks the Echo or speaker group; **Volume** (below the now-playing bar) is that Echo's volume;
  **Move to** moves what's playing to another Echo (the same song or station starts there, near the same point,
  and stops here; the album or playlist around it doesn't move); **Sleep** pauses after 15 min – 2 hours.
- Search **Songs**, **Albums**, **Artists**, **Radio** or **Podcasts** (Apple's free catalog; the country follows
  `AMAZON_PAGE`, override with `MUSIC_COUNTRY`). Sort newest/oldest first and show 30, 100 or 200 results (Apple returns
  the most relevant matches first and the sort applies to those, so use 100 or 200 for an artist's newest songs).
- **Top / Recent / Favourites** under the search bar. Tap ☆ on any tile, or in the now-playing bar to save what's
  playing (even something started by voice).
- **Podcasts:** tap a show to see its episodes, then **▶ Latest episode** or **▶ Play show** (Alexa usually continues
  where you left off). Alexa can't start an older episode by name; start the latest and use ⏮ to go back an episode.
- **Surprise with a Song** plays popular Hindi songs back to back, without end: current hits, 2000s, 90s, golden-era
  Bollywood, indie / Sufi / ghazal and Punjabi / Haryanvi, mixed. **Surprise with a Podcast** plays the latest
  episode of one show after another: tech & AI, Hindi shows and history / general knowledge (a hand-picked list plus
  India's Technology and History charts). ⏭ skips to the next pick; tap again for a new mix; playing anything else
  ends it. What a Surprise played is left out of new mixes for 3 days. If Alexa can't find a show (or plays another
  one), it's skipped.
- −15/−10/+10/+15 skip within the track or episode.
- **Crossfade** (in an open playlist: Off / 5 / 10 / 15 s) applies to playlists and to songs queued from search
  results. An Echo plays one song at a time, so the songs can't overlap. Instead the volume steps down near the end of a song
  (e.g. 30 → 20 → 10), the next song starts while it's quiet, and the volume comes back up once it plays. It's two
  coarse steps each way, because Alexa sets volume in steps of 10 and rate-limits commands. The player's own 0–100
  volume command lands ~10 s late on these Echos and drops commands sent close together. Not for speaker groups,
  and a volume like 27 comes back as 30.

Alexa plays by search phrase, so an ambiguous title may play a different version.

### Radio

Station search uses the free Radio Browser directory; playback goes through TuneIn. International stations (BBC and
others) work, but **most Indian FM stations (Radio Mirchi, Radio City, Vividh Bharati) aren't on TuneIn for Alexa**
and a similar-sounding station from another country may start instead (the now-playing bar shows what started). For
Indian music, tap an artist to play their station on Apple Music.

### Alarms, timers and reminders

New ones are set by voice on the chosen Echo, exactly like saying "set a tea timer for 10 minutes" or "remind me to
call Mum tomorrow at 7 pm". The lists come from Amazon and update live; running timers also show a countdown badge on
their Echo's card. Alarms can be switched on/off; anything can be deleted (reminders and alarms ask first).

### Scenes

A scene is a list of steps: Echo volume, play music/radio, pause/resume, sleep timer, TV (on/off, volume, mute, open an
app), Do Not Disturb, Echo Show screen, announcement, routine, sound effect, one-tap Alexa, stop all, wait. **Add
examples** creates "Movie time" and "Bedtime" to edit. A schedule (time + days) runs the scene automatically while Echo
Volume is running.

### Birthdays & anniversaries

In **Settings**, add a name, day and month, and optionally the year. On the day, at the set time (09:00 by default), it
is announced on the chosen Echo, speaker group or all Echos, optionally after a sound. With the year it says the age or
the number of years ("Asha is celebrating 34th birthday today. Happy birthday, Asha!"); without it, "It's Asha's
birthday today. Happy birthday, Asha!". Names with "and" or "&" get "are" ("Asha and Rohan are celebrating 10th
anniversary today"). 29 February is announced on 28 February in other years. **Preview** says it now. It only runs
while Echo Volume is running: if the PC was off at the set time, it is announced once Echo Volume starts, until 10 pm.
A Windows / page notification is shown too when "timer or alarm" notifications are on.

### Speaker groups

Groups (e.g. "Chill Out") work for music, volume, announcements and Do Not Disturb. Music is started by asking a member
Echo to play "on Chill Out"; group volume sets every member Echo (the card shows their average, and each member's own
slider).

### Notifications

Settings → Notifications: a notification when a **timer or alarm goes off** (on by default) and when **the song
changes** (off by default). The desktop app shows Windows notifications; a browser shows them while the page is in the
background, after **Allow browser notifications**.

### Phone access

Settings → Phone access: use Echo Volume from phones on the same Wi-Fi. Turning it on creates a key and shows a QR code
with the link (`http://<this PC>:5005/?key=…`); scan it, then use the browser's **Add to Home screen** to open it like an
app. The first time, Windows may ask whether to allow Echo Volume on private networks: allow it. **Make a new key**
locks out phones using the old link. (`API_KEY` in `.env`, if set, is used instead and keeps phone access on.)

### What Alexa doesn't allow

- **Echo Show brightness:** not settable (Alexa answers "use the brightness slider"); screen on/off works.
- **Apple Music:** no shuffle, repeat or queue through Alexa ("I can't turn shuffle on for this stream"). Those
  controls appear only for sources that offer them.
- **Older podcast episodes by name**, **Indian FM radio on TuneIn**: see above.

### Live updates and the Amazon rate limit

Amazon's push connection sends volume, music, alarm, list, Bluetooth and equalizer changes as they happen, and the
pages update instantly (also when someone talks to an Echo). Voice-style commands (volume, group music, seek, timers…)
are rate limited by Amazon: a quick burst gets "Too many requests" and a 30–60 s delay. The server sends them one at a
time, at least 1.5 s apart (`COMMAND_GAP_MS`), and for volume only the latest value of a burst of clicks. The console
shows `⚠ Amazon: rate exceeded` when the limit is still hit.

## API

All endpoints are under `/api`. `device` accepts an Echo or group name (or part of it) or serial; omit it if
`DEFAULT_DEVICE` is set. Music routes remember the Echo they were last used with and use it when `device` is omitted
(media keys and quick controls rely on this).

**Echos and volume**

| Method | Endpoint | Body / query | What it does |
|---|---|---|---|
| GET | `/api/health` | — | `{ ready: true }` when logged in |
| GET | `/api/devices` | — | Echos, groups (with `members`) and other devices |
| GET / POST | `/api/volume` | `?device=` / `{ "device", "level": 35 }` | Read / set volume 0–100 (groups: every member) |
| POST | `/api/volume/up`, `/api/volume/down` | `{ "device", "step": 10 }` | Change volume |
| POST | `/api/mute`, `/api/unmute` | `{ "device" }` | Volume 0 / back to the previous volume |
| POST | `/api/command` | `{ "device", "text": "what time is it" }` | Any voice command, as if said to that Echo |

**Music, radio and podcasts**

| Method | Endpoint | Body / query | What it does |
|---|---|---|---|
| GET | `/api/music/search` | `?q=&type=song\|album\|artist&limit=&sort=newest\|oldest` | Apple Music catalog search |
| GET | `/api/music/top` | `?type=song\|album` | Top chart for your country |
| GET | `/api/radio` | `?q=&limit=` | Radio stations (popular in your country without `q`) |
| GET | `/api/podcasts/top`, `/api/podcasts/search` | `?limit=` / `?q=&limit=` | Top podcasts / podcast search |
| GET | `/api/podcasts/:id/episodes` | — | A podcast's recent episodes |
| POST | `/api/podcasts/play` | `{ "device", "podcast": "show name", "latest": true }` | Play the latest episode (or the show) on Apple Podcasts |
| POST | `/api/music/play` | `{ "device", "query", "provider": "TUNEIN"?, "item"? }` | Play on Apple Music (or TuneIn); without `query`: resume |
| POST | `/api/music/surprise` | `{ "device", "kind": "song" \| "podcast" }` | Start a Surprise mix (popular Hindi songs, or podcasts to learn from) that keeps going |
| POST | `/api/music/pause`, `/next`, `/previous` | `{ "device" }` | Playback controls |
| POST | `/api/music/seek` | `{ "device", "seconds": 15 }` | Skip forward (negative: back) |
| POST | `/api/music/shuffle`, `/repeat` | `{ "device", "on": true }` | Where the source allows it (see `/api/music/now`) |
| GET / POST | `/api/music/queue`, `/api/music/jump` | `?device=` / `{ "device", "id" }` | Up next, and jump to one of those |
| POST | `/api/music/move` | `{ "from", "to" }` | Move what's playing to another Echo / group |
| POST | `/api/music/sleep` | `{ "device", "minutes": 30 }` | Pause after N minutes (0 cancels) |
| GET | `/api/music/now` | `?device=` | Now playing: title, artist, artwork, state, position, shuffle/repeat, `sleepAt` |
| GET / POST | `/api/music/favorites` | `{ "item" }` | Favourites; `POST /api/music/favorites/remove` `{ "query" }` |
| GET | `/api/music/recent` | — | Last 30 items played from the UI |
| GET / POST | `/api/music/crossfade` | `{ "seconds": 0\|5\|10\|15 }` | Fade between playlist songs (0 = off) |

**Alexa**

| Method | Endpoint | Body / query | What it does |
|---|---|---|---|
| GET / POST | `/api/alerts` | `{ "type": "timer", "device", "minutes": 10, "label": "tea" }` | List alarms/timers/reminders / create one: `alarm` takes `time` "07:30" + `repeat` (daily, weekdays, weekends); `reminder` takes `text` + `time` + `day` (today, tomorrow) or `minutes` |
| POST | `/api/alerts/toggle`, `/api/alerts/delete` | `{ "id", "on" }` / `{ "id" }` | Alarm on/off; delete anything |
| POST | `/api/announce` | `{ "text", "device": "all", "mode": "announcement\|speak", "sound"? }` | Announcement (chime + text, on Echo Show screens) or plain speech; optional sound first |
| GET / POST | `/api/sounds`, `/api/sound` | — / `{ "device": "all", "id" }` | Sound effects |
| POST | `/api/alexa/do` | `{ "device", "action": "weather" }` | weather, traffic, flashbriefing, goodmorning, calendarToday, calendarTomorrow, joke, funfact, singasong, tellstory |
| GET / POST | `/api/routines`, `/api/routines/run` | — / `{ "id", "device" }` | Alexa routines |
| POST | `/api/stop-all` | — | Stop audio on every Echo |
| GET | `/api/history` | `?hours=24` | Voice history: what was said, on which Echo, Alexa's answer |
| GET | `/api/lists` | — | Alexa lists with their items |
| POST | `/api/lists/:id/items` | `{ "value" }` | Add an item |
| POST | `/api/lists/:id/items/:item` | `{ "completed": true, "value"?, "version" }` | Tick off / rename (version from `/api/lists`) |
| POST | `/api/lists/:id/items/:item/delete` | `{ "version" }` | Delete an item |
| GET / POST | `/api/scenes`, `/api/scenes/:id/run`, `/api/scenes/:id/delete` | `{ "scene": { "name", "steps", "schedule" } }` | Scenes |
| GET / POST | `/api/celebrations`, `/api/celebrations/settings`, `/api/celebrations/:id/test`, `/api/celebrations/:id/delete` | `{ "type": "birthday|anniversary", "name", "day", "month", "year"? }` / `{ "enabled", "time", "device", "sound" }` | Birthdays & anniversaries |
| GET / POST | `/api/smarthome/devices`, `/api/smarthome/devices/:id` | — / `{ "action": "turnOn\|turnOff\|setBrightness", "brightness" }` | Smart home |

**Per Echo, notifications, UI, live updates**

| Method | Endpoint | Body / query | What it does |
|---|---|---|---|
| GET / POST | `/api/dnd` | — / `{ "device": "all", "enabled": true }` | Do Not Disturb |
| GET / POST | `/api/eq` | `?device=` / `{ "device", "bass", "mid", "treble" }` | Equalizer (−6…+6) |
| POST | `/api/screen` | `{ "device", "on": false }` | Echo Show screen on/off |
| GET / POST | `/api/bluetooth`, `/connect`, `/disconnect` | — / `{ "device", "address" }` | Paired Bluetooth devices |
| GET / POST | `/api/notify` | `{ "alerts": true, "songs": false }` | Notification settings |
| GET / POST | `/api/ui` | `{ "theme": "system\|light\|dark\|midnight" }` | Theme (shared with the desktop app) |
| GET / POST | `/api/lan`, `/api/lan/qr` | `{ "enabled": true, "newKey"? }` | Phone access (this PC only) |
| GET | `/api/events` | — | Server-sent events: volume, media, alerts, lists, eq, bluetooth, activity, scene, alert, song, theme |
| GET / POST | `/api/tv/…`, `/api/st/…` | | TV through Alexa / SmartThings (power, volume, mute, input, channel, apps, `key`) |

### Examples

```bash
curl -X POST localhost:5005/api/volume -H "Content-Type: application/json" -d "{\"device\":\"hallway\",\"level\":30}"
curl -X POST localhost:5005/api/alerts -H "Content-Type: application/json" -d "{\"type\":\"timer\",\"device\":\"hallway\",\"minutes\":10,\"label\":\"tea\"}"
curl localhost:5005/api/music/now
```

PowerShell (also usable from a desktop shortcut with a hotkey):

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5005/api/volume/up
Invoke-RestMethod -Method Post -Uri http://localhost:5005/api/announce -ContentType 'application/json' -Body '{"text":"Dinner is ready","device":"all"}'
```

## Security

- **This PC needs no key.** Other devices need the API key (phone access key, or `API_KEY` in `.env`) as header
  `x-api-key` or `?key=` in the link. With phone access off and no `API_KEY`, other devices are refused.
- Requests made by other websites in your browser, and host names other than this PC's (DNS rebinding), are refused.
- `cookie.json` is equivalent to your Alexa session, and the phone link contains the key: keep both private.

## Troubleshooting

- **503 Not logged in** → complete the login at `http://localhost:3001`, then restart.
- **Login loop / OTP errors** → in Amazon account settings switch 2-Step Verification to an authenticator app; delete `cookie.json` and retry.
- **"Port 5005 is already in use"** → the desktop app or another `npm start` is running; use it, or quit it first.
- **Volume reads `null`** → some firmware only reports volume while media is playing; setting volume still works.
- **Commands arrive late** → Amazon's rate limit (see above); avoid long bursts of clicks.
- **Alexa TV commands do nothing** → if the Alexa app has two devices with the TV's name, Alexa can't tell which is meant. Rename one, or set `TV_NAME`. With SmartThings connected the app uses SmartThings instead.
- **TV controls greyed out** → the TV is off; SmartThings only accepts volume/channel/input while it's on.
- **A podcast or song doesn't start** → make sure the Apple Podcasts / Apple Music skill is linked in the Alexa app; the Alexa tab's voice history shows what Alexa answered.
- **Phone can't connect** → same Wi-Fi as the PC? Allow Echo Volume (or Node.js) in Windows Defender Firewall for private networks.
- **Wrong region** → for amazon.com accounts set `AMAZON_PAGE=amazon.com`, `ALEXA_SERVICE_HOST=pitangui.amazon.com`, `ACCEPT_LANGUAGE=en-US`.
- Amazon changes these internal endpoints occasionally — `npm update alexa-remote2` usually fixes breakage.

## Desktop app (Windows)

Echo Volume also runs as a desktop app with the server built in (no terminal or browser needed).

- **Install:** build the installer with `npm install` then `npm run dist`, and run `dist\Echo Volume Setup <version>.exe`
  (installers aren't committed to the repo). During development, run `npm run app`.
- **Data folder:** `%APPDATA%\Echo Volume` holds `.env`, `cookie.json`, `st-token.json`, `settings.json` (hotkeys) and
  `ui-state.json` (theme, favourites, recently played, scenes, birthdays & anniversaries, notification and phone-access settings). Tray menu →
  *Open data folder*. Edit `.env` there, then quit and reopen the app.
- **Tray:** click for quick controls (Echo and TV volume, and what's playing with previous / play-pause / next),
  double-click to open the app. *Stop all audio* stops every Echo. Closing the window keeps it running; quit from the
  tray menu.
- **Notifications:** timers/alarms going off and song changes as Windows notifications (Settings tab).
- **Hotkeys** (tray menu → *Show hotkeys…*):

| Keys | Action |
|---|---|
| Ctrl+Alt+Up / Down | Echo volume ±1 (device chosen under tray menu → *Hotkeys control*) |
| Ctrl+Alt+Home | Echo mute / unmute |
| Ctrl+Alt+PageUp / PageDown | TV volume ±2 (SmartThings) |
| Ctrl+Alt+End | TV mute / unmute |
| Ctrl+Alt+E | Show / hide the app |
| Play/Pause, Next, Previous, Stop media keys | Echo music (optional: tray menu → *Media keys control Echo music*; while on, other players don't get these keys) |

- The app listens on `127.0.0.1:5005` (this PC only), plus the network while phone access is on.

## Disclaimer

Personal project, not affiliated with or endorsed by Amazon, Apple or Samsung. It relies on Amazon's unofficial,
undocumented Alexa endpoints, which can change without notice. Use at your own risk.
