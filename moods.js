// Moods: the built-in catalog, validation, the user's edits on top (ui-state.json → moods), and suggestions.
// Pure code (no I/O): mood-player.js plays them, server.js keeps the state.
//
// A mood's phrases are what Alexa searches Apple Music for ("play <phrase> on apple music"), per language.
// A phrase may end in "|<energy>" (1 calm … 5 energetic) when it differs from the mood's own energy; the
// intensity chosen when playing favours phrases near it. Phrases are search phrases, so what plays can vary.
const { preset } = require('./focus-presets');

const GROUPS = [
  { id: 'focus', name: 'Focus' }, { id: 'relax', name: 'Relax' }, { id: 'mind', name: 'Mind' },
  { id: 'energy', name: 'Energy' }, { id: 'emotion', name: 'Emotion' },
];
const LANGUAGES = [
  { id: 'instrumental', name: 'Instrumental' }, { id: 'hindi', name: 'Hindi' }, { id: 'english', name: 'English' },
  { id: 'punjabi', name: 'Punjabi' }, { id: 'sufiGhazal', name: 'Sufi & Ghazal' },
];
const PARTS = ['early', 'morning', 'midday', 'afternoon', 'evening', 'night', 'late']; // see partOfDay
const VOCALS = ['instrumental', 'light', 'any'];
// The icons a mood may use (symbols in public/icons.svg). Moods saved before icons replaced emoji are mapped by EMOJI.
const ICONS = ['music', 'book', 'laptop', 'book-open', 'palette', 'coffee', 'cocktail', 'cloud-rain', 'pot', 'sun', 'lotus', 'leaf',
  'diya', 'moon', 'sunrise', 'activity', 'car', 'confetti', 'heart', 'cassette', 'feather', 'smile', 'candle', 'guitar',
  'headphones', 'mic', 'radio', 'wave', 'brain', 'bolt', 'star', 'flower', 'cake'];
const EMOJI = { '📚': 'book', '💻': 'laptop', '📖': 'book-open', '🎨': 'palette', '😌': 'coffee', '🍸': 'cocktail', '🌧': 'cloud-rain', '🍳': 'pot', '☀': 'sun', '🧘': 'lotus', '🌿': 'leaf', '🙏': 'diya', '🌙': 'moon', '🌅': 'sunrise', '🏃': 'activity', '🚗': 'car', '🎉': 'confetti', '❤': 'heart', '📻': 'cassette', '🥀': 'feather', '😄': 'smile', '🕯': 'candle', '🎻': 'guitar' };
const iconOf = (x) => (ICONS.includes(x?.icon) ? x.icon : EMOJI[String(x?.emoji ?? '').replace(/️/g, '')] || 'music');

// m(id, name, icon, group, energy, vocals, options, phrases); icon is a symbol id in public/icons.svg
const m = (id, name, icon, group, energy, vocals, o, phrases) => ({
  id, name, icon, group, energy, vocals, description: o.desc, defaultVolume: o.vol, defaultSleepMinutes: o.sleep ?? null,
  timeOfDay: o.tod, days: o.days || 'any', accent: o.accent, frequencyLayer: o.freq ?? null, frequencyRatio: o.ratio ?? null, phrases,
});

const BUILT_IN = [
  // ---------- Focus ----------
  m('study', 'Study', 'book', 'focus', 2, 'instrumental',
    { desc: 'Calm and steady, nothing to sing along to', vol: 3, sleep: 90, tod: ['morning', 'afternoon', 'evening'], days: 'weekday', accent: ['#2cc3f0', '#3b4bd8'], freq: 'alpha' }, {
      instrumental: ['lofi study beats', 'instrumental study music', 'peaceful piano for studying', 'calm study music|1', 'lofi hip hop for studying', 'ambient study music|1', 'classical music for studying', 'chillhop study beats|3'],
      hindi: ['hindi lofi songs', 'bollywood lofi', 'hindi lofi study mix', 'soft hindi instrumental', 'arijit singh lofi', 'bollywood flute instrumental|1'],
      english: ['acoustic study songs', 'soft acoustic covers', 'chill indie for studying', 'coffee shop acoustic', 'soft pop for studying', 'mellow acoustic songs'],
      punjabi: ['punjabi lofi songs', 'punjabi lofi chill', 'slowed punjabi lofi', 'soft punjabi songs', 'punjabi acoustic songs', 'diljit dosanjh lofi'],
      sufiGhazal: ['sufi instrumental', 'ghazal instrumental', 'sufi lofi', 'soft ghazals', 'jagjit singh ghazals|1', 'sitar instrumental'],
    }),
  m('deepwork', 'Deep Work', 'laptop', 'focus', 3, 'instrumental',
    { desc: 'Long stretches of concentration and coding', vol: 3, sleep: null, tod: ['morning', 'afternoon', 'night'], days: 'weekday', accent: ['#22d3ee', '#0f766e'], freq: 'beta' }, {
      instrumental: ['deep focus music', 'coding music', 'electronic focus music|3', 'synthwave for coding|4', 'minimal techno focus|4', 'ambient electronic focus|2', 'video game music for focus', 'post rock instrumental|3'],
      hindi: ['bollywood instrumental', 'hindi lofi beats', 'bollywood lofi chill', 'hindi chill mix', 'a r rahman instrumental', 'hindi indie chill'],
      english: ['chill electronic', 'downtempo electronic', 'indie electronic chill', 'focus pop', 'chill house|4', 'electronic chill mix'],
      punjabi: ['punjabi lofi', 'punjabi chill beats', 'punjabi lofi mix', 'slowed punjabi songs', 'punjabi instrumental', 'punjabi chill'],
      sufiGhazal: ['sufi lofi', 'sufi instrumental', 'qawwali instrumental', 'sarangi instrumental', 'santoor instrumental', 'sufi chill'],
    }),
  m('reading', 'Reading', 'book-open', 'focus', 1, 'instrumental',
    { desc: 'Quiet, warm and out of the way', vol: 2, sleep: 60, tod: ['evening', 'night', 'afternoon'], accent: ['#f5c26b', '#8b5e34'], freq: 'hz432' }, {
      instrumental: ['peaceful piano', 'classical music for reading', 'soft piano music', 'calm classical music', 'quiet jazz piano|2', 'ambient piano', 'cello and piano', 'chopin nocturnes'],
      hindi: ['soft hindi songs', 'hindi acoustic songs', 'old hindi songs soft', 'hindi unplugged', 'lata mangeshkar soft songs', 'bollywood piano instrumental'],
      english: ['soft acoustic songs', 'quiet indie folk', 'acoustic covers', 'mellow folk songs', 'coffee house acoustic', 'soft jazz vocals|2'],
      punjabi: ['soft punjabi songs', 'punjabi acoustic', 'punjabi folk soft', 'satinder sartaaj songs', 'punjabi unplugged', 'gurdas maan soft songs'],
      sufiGhazal: ['ghazals', 'jagjit singh ghazals', 'mehdi hassan ghazals', 'soft sufi songs', 'ghulam ali ghazals', 'abida parveen sufi'],
    }),
  m('creative', 'Creative Flow', 'palette', 'focus', 3, 'light',
    { desc: 'Bright and moving, ideas welcome', vol: 4, tod: ['morning', 'afternoon'], accent: ['#f472b6', '#8b5cf6'], freq: 'alpha' }, {
      instrumental: ['creative flow music', 'chillhop', 'jazzhop', 'nu jazz instrumental', 'upbeat lofi|4', 'future bass chill|4', 'neo soul instrumental', 'electronic chill instrumental'],
      hindi: ['hindi indie songs', 'prateek kuhad songs', 'hindi indie pop', 'anuv jain songs', 'the local train songs|4', 'bollywood indie'],
      english: ['indie pop', 'feel good indie', 'alt pop', 'indie dance|4', 'dream pop', 'bedroom pop'],
      punjabi: ['punjabi indie', 'punjabi pop', 'punjabi chill pop', 'ap dhillon songs', 'punjabi rnb', 'karan aujla chill songs'],
      sufiGhazal: ['sufi rock|4', 'coke studio sufi', 'sufi fusion', 'coke studio pakistan', 'kailash kher songs', 'sufi pop'],
    }),

  // ---------- Relax ----------
  m('chill', 'Chill', 'coffee', 'relax', 2, 'any',
    { desc: 'Easy music for a slow hour', vol: 4, tod: ['afternoon', 'evening'], accent: ['#5eead4', '#0ea5e9'], freq: 'hz432', ratio: 3 }, {
      instrumental: ['chill instrumental', 'lofi chill', 'chill vibes', 'chillout music', 'downtempo chill', 'chill jazz', 'bossa nova', 'chill guitar instrumental'],
      hindi: ['hindi chill songs', 'bollywood chill', 'hindi chill mix', 'chill bollywood songs', 'bollywood unplugged', 'hindi indie chill'],
      english: ['chill hits', 'chill pop', 'chill rnb', 'chill acoustic', 'chill vibes songs', 'chill indie'],
      punjabi: ['punjabi chill', 'chill punjabi songs', 'punjabi lofi chill', 'punjabi rnb', 'ap dhillon chill', 'punjabi chill mix'],
      sufiGhazal: ['sufi chill', 'coke studio', 'soft qawwali', 'ghazal chill', 'rahat fateh ali khan soft songs', 'sufi lounge'],
    }),
  m('lounge', 'Lounge', 'cocktail', 'relax', 2, 'any',
    { desc: 'Smooth evening sounds', vol: 3, tod: ['evening', 'night'], accent: ['#c084fc', '#f59e0b'], freq: null }, {
      instrumental: ['lounge music', 'smooth jazz', 'jazz lounge', 'deep house lounge|3', 'nu jazz lounge', 'bossa nova lounge', 'cafe del mar chill', 'saxophone lounge'],
      hindi: ['bollywood lounge', 'hindi lounge music', 'bollywood jazz', 'retro bollywood lounge', 'kishore kumar lounge', 'hindi soft evening songs'],
      english: ['lounge vocals', 'smooth soul', 'neo soul', 'jazz vocals', 'rnb slow jams', 'sade songs'],
      punjabi: ['punjabi lounge', 'punjabi soft songs', 'punjabi rnb chill', 'punjabi retro', 'punjabi slow songs', 'punjabi unplugged'],
      sufiGhazal: ['sufi lounge', 'ghazal lounge', 'coke studio lounge', 'mehdi hassan ghazals', 'ghulam ali ghazals', 'ghazal evening'],
    }),
  m('rainy', 'Rainy Day', 'cloud-rain', 'relax', 1, 'any',
    { desc: 'Grey skies, chai and soft songs', vol: 3, tod: ['afternoon', 'evening'], accent: ['#64748b', '#38bdf8'], freq: null }, {
      instrumental: ['rainy day jazz', 'rain lofi', 'rainy day piano', 'rain sounds piano', 'monsoon instrumental', 'rainy day acoustic', 'jazz for rainy days', 'rainy night lofi'],
      hindi: ['hindi rain songs', 'bollywood barish songs', 'monsoon bollywood songs', 'old hindi rain songs', 'romantic barish songs', 'hindi lofi rain'],
      english: ['rainy day songs', 'rainy day acoustic songs', 'sad rainy day songs', 'cozy rainy day', 'rainy day indie', 'rainy day jazz vocals'],
      punjabi: ['punjabi barish songs', 'punjabi rain songs', 'punjabi monsoon songs', 'punjabi sad soft songs', 'punjabi lofi rain', 'punjabi acoustic rain'],
      sufiGhazal: ['barish ghazals', 'monsoon ghazals', 'sawan ghazal', 'rain sufi songs', 'jagjit singh barish', 'sufi rain'],
    }),
  m('cooking', 'Cooking', 'pot', 'relax', 3, 'any',
    { desc: 'Cheerful and familiar, for the kitchen', vol: 5, tod: ['midday', 'evening'], accent: ['#fb923c', '#facc15'], freq: null }, {
      instrumental: ['cooking jazz', 'upbeat jazz', 'italian dinner music', 'latin jazz', 'swing music|4', 'cafe music', 'gypsy jazz', 'funk instrumental|4'],
      hindi: ['bollywood feel good songs', 'hindi happy songs', 'bollywood kitchen songs', 'evergreen hindi songs', 'kishore kumar hits', 'bollywood 90s hits|4'],
      english: ['cooking songs', 'feel good pop', 'motown hits', 'happy songs|4', 'kitchen dance party|4', 'feel good classics'],
      punjabi: ['punjabi happy songs', 'punjabi feel good', 'diljit dosanjh hits|4', 'punjabi classics', 'punjabi folk upbeat|4', 'gurdas maan hits'],
      sufiGhazal: ['sufi upbeat songs', 'qawwali hits', 'nusrat fateh ali khan qawwali|4', 'coke studio hits', 'sufi pop', 'kailash kher hits'],
    }),
  m('sunday', 'Sunday Morning', 'sun', 'relax', 2, 'any',
    { desc: 'Slow start, coffee, sunshine', vol: 3, tod: ['early', 'morning'], days: 'weekend', accent: ['#fde68a', '#fb7185'], freq: 'hz528', ratio: 4 }, {
      instrumental: ['sunday morning jazz', 'morning acoustic', 'sunday morning coffee', 'brunch jazz', 'bossa nova morning', 'peaceful morning piano', 'acoustic guitar morning', 'morning lofi'],
      hindi: ['hindi morning songs', 'soft hindi morning songs', 'old hindi morning songs', 'bollywood sunday songs', 'hindi acoustic morning', 'rd burman songs'],
      english: ['sunday morning songs', 'lazy sunday', 'acoustic morning', 'sunday brunch songs', 'feel good folk', 'soft morning pop'],
      punjabi: ['punjabi morning songs', 'soft punjabi songs', 'punjabi folk', 'punjabi acoustic', 'satinder sartaaj songs', 'punjabi sunday'],
      sufiGhazal: ['morning sufi', 'sufi morning songs', 'morning ghazals', 'soft qawwali', 'shabad gurbani|1', 'sufi kalam'],
    }),

  // ---------- Mind ----------
  m('meditate', 'Meditate', 'lotus', 'mind', 1, 'instrumental',
    { desc: 'Stillness: bowls, tones and space', vol: 2, sleep: 30, tod: ['early', 'morning', 'night'], accent: ['#a78bfa', '#1e1b4b'], freq: 'theta', ratio: 0 }, {
      instrumental: ['meditation music', 'ambient meditation', 'zen meditation', 'deep meditation music', 'mindfulness meditation', 'tibetan meditation', 'flute meditation', 'meditation drone'],
      hindi: ['hindi meditation music', 'indian meditation music', 'bansuri meditation', 'om meditation', 'mantra meditation', 'indian flute meditation'],
      english: ['guided meditation music', 'meditation ambient', 'calm meditation', 'relaxing meditation', 'mindfulness music', 'meditation sounds'],
      punjabi: ['gurbani meditation', 'waheguru simran', 'shabad kirtan soft', 'mool mantar', 'gurbani shabad', 'japji sahib'],
      sufiGhazal: ['sufi meditation', 'sufi ney flute', 'whirling dervish music', 'sufi zikr', 'sufi ambient', 'rumi meditation music'],
    }),
  m('calm', 'Calm / Anxiety Relief', 'leaf', 'mind', 1, 'instrumental',
    { desc: 'Slow breath, soft edges', vol: 2, sleep: 45, tod: ['afternoon', 'evening', 'night'], accent: ['#86efac', '#0f766e'], freq: 'hz528', ratio: 2 }, {
      instrumental: ['calm music', 'relaxing music', 'stress relief music', 'anxiety relief music', 'calming piano', 'peaceful ambient', 'nature sounds with music', 'calm guitar'],
      hindi: ['calm hindi songs', 'soothing hindi songs', 'peaceful hindi music', 'hindi relaxing songs', 'calm bollywood instrumental', 'soothing bhajans'],
      english: ['calming songs', 'soothing acoustic', 'gentle songs', 'peaceful songs', 'calm indie folk', 'relaxing vocals'],
      punjabi: ['peaceful gurbani', 'soothing punjabi songs', 'calm punjabi songs', 'shabad kirtan', 'soft punjabi folk', 'punjabi relaxing'],
      sufiGhazal: ['soothing sufi', 'peaceful sufi', 'calm ghazals', 'soft sufi kalam', 'abida parveen', 'sufi healing'],
    }),
  m('gratitude', 'Gratitude / Spiritual', 'diya', 'mind', 2, 'any',
    { desc: 'Devotional and uplifting', vol: 3, tod: ['early', 'morning', 'evening'], accent: ['#fbbf24', '#f97316'], freq: 'om', ratio: 3 }, {
      instrumental: ['spiritual music', 'devotional instrumental', 'temple music', 'peaceful spiritual music', 'sitar spiritual', 'flute devotional'],
      hindi: ['bhajans', 'morning bhajans', 'hindi devotional songs', 'krishna bhajans', 'shiv bhajans', 'aarti songs'],
      english: ['gratitude songs', 'uplifting songs', 'spiritual songs', 'gospel', 'hymns', 'inspirational songs'],
      punjabi: ['gurbani', 'shabad kirtan', 'waheguru simran', 'gurbani kirtan', 'punjabi devotional', 'dhan guru nanak'],
      sufiGhazal: ['qawwali', 'nusrat fateh ali khan', 'sufi devotional', 'abida parveen', 'sabri brothers qawwali', 'sufi kalam'],
    }),
  m('sleep', 'Sleep', 'moon', 'mind', 1, 'instrumental',
    { desc: 'Fade into the night', vol: 2, sleep: 45, tod: ['night', 'late'], accent: ['#6366f1', '#0f172a'], freq: 'delta', ratio: 0 }, {
      instrumental: ['sleep music', 'deep sleep music', 'sleep piano', 'sleep ambient', 'lullabies for adults', 'sleep sounds', 'rain for sleep', 'calm sleep music'],
      hindi: ['hindi lullaby', 'hindi sleep songs', 'soft hindi night songs', 'lori songs', 'bollywood sleep lofi', 'old hindi soft songs'],
      english: ['sleep songs', 'soft songs for sleep', 'night acoustic', 'lullaby songs', 'calm night songs', 'sleep pop'],
      punjabi: ['punjabi lori', 'soft punjabi night songs', 'gurbani for sleep', 'kirtan sohila', 'punjabi sleep songs', 'punjabi soft night'],
      sufiGhazal: ['night ghazals', 'soft ghazals', 'jagjit singh night', 'sufi night', 'mehdi hassan soft', 'ghazals for sleep'],
    }),

  // ---------- Energy ----------
  m('morning', 'Morning Energizer', 'sunrise', 'energy', 4, 'any',
    { desc: 'Wake up and get going', vol: 5, tod: ['early', 'morning'], days: 'weekday', accent: ['#fb923c', '#fde047'], freq: null }, {
      instrumental: ['morning motivation instrumental', 'upbeat instrumental', 'happy morning music', 'energetic acoustic', 'upbeat lofi', 'morning workout instrumental|5'],
      hindi: ['hindi morning motivation songs', 'bollywood happy songs', 'hindi upbeat songs', 'bollywood energetic songs|5', 'hindi feel good songs', 'motivational hindi songs'],
      english: ['morning motivation', 'wake up songs', 'feel good morning', 'happy pop', 'upbeat pop', 'good vibes'],
      punjabi: ['punjabi morning songs', 'punjabi upbeat songs', 'punjabi hits', 'punjabi bhangra|5', 'punjabi feel good', 'diljit dosanjh hits'],
      sufiGhazal: ['uplifting sufi', 'sufi rock', 'coke studio upbeat', 'qawwali upbeat', 'kailash kher', 'sufi energetic'],
    }),
  m('workout', 'Workout / Run', 'activity', 'energy', 5, 'any',
    { desc: 'High energy, big beats', vol: 6, tod: ['early', 'morning', 'evening'], accent: ['#f43f5e', '#f97316'], freq: null }, {
      instrumental: ['workout music', 'running music', 'edm workout', 'gym music', 'drum and bass', 'electronic workout', 'phonk', 'hard techno|5'],
      hindi: ['bollywood workout songs', 'hindi gym songs', 'hindi workout mix', 'bollywood party songs', 'hindi rap', 'badshah songs'],
      english: ['workout hits', 'gym hits', 'running hits', 'hip hop workout', 'rock workout', 'pop workout'],
      punjabi: ['punjabi workout songs', 'punjabi gym songs', 'bhangra workout', 'sidhu moose wala songs', 'karan aujla songs', 'punjabi rap'],
      sufiGhazal: ['sufi rock', 'qawwali remix', 'sufi trance', 'coke studio rock', 'junoon songs', 'sufi upbeat'],
    }),
  m('drive', 'Commute / Drive', 'car', 'energy', 3, 'any',
    { desc: 'Road songs, windows down', vol: 5, tod: ['morning', 'evening'], days: 'weekday', accent: ['#38bdf8', '#a3e635'], freq: null }, {
      instrumental: ['driving music', 'synthwave drive', 'road trip instrumental', 'night drive', 'chill drive', 'retrowave'],
      hindi: ['hindi road trip songs', 'bollywood driving songs', 'hindi long drive songs', 'bollywood travel songs', 'hindi indie road trip', 'arijit singh hits'],
      english: ['road trip songs', 'driving songs', 'classic rock driving', 'drive time hits', 'indie road trip', 'night drive songs'],
      punjabi: ['punjabi driving songs', 'punjabi long drive songs', 'punjabi road trip', 'punjabi hits', 'punjabi car songs', 'ap dhillon songs'],
      sufiGhazal: ['sufi road trip', 'coke studio', 'sufi rock', 'qawwali hits', 'rahat fateh ali khan hits', 'atif aslam songs'],
    }),
  m('party', 'Party', 'confetti', 'energy', 5, 'any',
    { desc: 'Turn it up', vol: 6, tod: ['evening', 'night'], days: 'weekend', accent: ['#e879f9', '#22d3ee'], freq: null }, {
      instrumental: ['party edm', 'house party', 'dance music', 'club hits', 'tech house', 'afro house'],
      hindi: ['bollywood party songs', 'hindi party songs', 'bollywood dance hits', 'hindi club songs', 'bollywood wedding songs', 'hindi remix'],
      english: ['party hits', 'dance hits', 'pop party', 'throwback party', 'hip hop party', 'top 40 party'],
      punjabi: ['punjabi party songs', 'bhangra party', 'punjabi dance hits', 'punjabi club songs', 'punjabi wedding songs', 'yo yo honey singh'],
      sufiGhazal: ['qawwali party', 'sufi remix', 'coke studio party', 'sufi dance', 'mast qalandar', 'sufi trance'],
    }),

  // ---------- Emotion ----------
  m('romantic', 'Romantic', 'heart', 'emotion', 2, 'any',
    { desc: 'Love songs, soft and warm', vol: 3, tod: ['evening', 'night'], accent: ['#fb7185', '#be123c'], freq: null }, {
      instrumental: ['romantic instrumental', 'romantic piano', 'romantic guitar', 'romantic jazz', 'love songs instrumental', 'romantic saxophone'],
      hindi: ['hindi romantic songs', 'bollywood love songs', 'arijit singh romantic songs', '90s romantic hindi songs', 'old hindi romantic songs', 'romantic hindi lofi'],
      english: ['love songs', 'romantic songs', 'rnb love songs', 'acoustic love songs', 'love ballads', 'romantic pop'],
      punjabi: ['punjabi romantic songs', 'punjabi love songs', 'romantic punjabi hits', 'punjabi sad love songs', 'b praak romantic', 'jassie gill romantic'],
      sufiGhazal: ['romantic ghazals', 'romantic sufi songs', 'rahat fateh ali khan romantic', 'jagjit singh romantic', 'romantic qawwali', 'atif aslam romantic'],
    }),
  m('nostalgia', 'Nostalgia', 'cassette', 'emotion', 2, 'any',
    { desc: 'Songs from back then', vol: 4, tod: ['evening', 'night', 'afternoon'], accent: ['#d6a35c', '#7c2d12'], freq: null }, {
      instrumental: ['retro instrumental', 'old bollywood instrumental', 'classic instrumental hits', 'vintage jazz', 'oldies instrumental', 'retro lounge'],
      hindi: ['old hindi songs', '90s bollywood songs', 'kishore kumar songs', 'mohammed rafi songs', 'lata mangeshkar songs', '80s hindi songs'],
      english: ['90s hits', '80s hits', 'oldies', 'classic hits', '2000s hits', 'throwback songs'],
      punjabi: ['old punjabi songs', '90s punjabi songs', 'punjabi classics', 'gurdas maan songs', 'surjit bindrakhia songs', 'old punjabi folk'],
      sufiGhazal: ['old ghazals', 'classic ghazals', 'mehdi hassan', 'begum akhtar ghazals', 'old qawwali', 'pankaj udhas ghazals'],
    }),
  m('reflective', 'Sad / Reflective', 'feather', 'emotion', 1, 'any',
    { desc: 'For heavy days', vol: 3, tod: ['evening', 'night', 'late'], accent: ['#60a5fa', '#312e81'], freq: 'hz432', ratio: 4 }, {
      instrumental: ['sad piano', 'melancholic instrumental', 'sad strings', 'emotional piano', 'reflective ambient', 'sad cello'],
      hindi: ['hindi sad songs', 'bollywood sad songs', 'arijit singh sad songs', 'hindi heartbreak songs', 'old hindi sad songs', 'sad hindi lofi'],
      english: ['sad songs', 'heartbreak songs', 'sad acoustic', 'sad indie', 'reflective songs', 'sad pop'],
      punjabi: ['punjabi sad songs', 'punjabi heartbreak songs', 'b praak sad songs', 'punjabi sad hits', 'sad punjabi lofi', 'punjabi emotional songs'],
      sufiGhazal: ['sad ghazals', 'sad sufi songs', 'jagjit singh sad ghazals', 'nusrat sad songs', 'dard bhari ghazal', 'sad qawwali'],
    }),
  m('feelgood', 'Feel-Good', 'smile', 'emotion', 4, 'any',
    { desc: 'Smiles guaranteed', vol: 5, tod: ['morning', 'afternoon', 'evening'], accent: ['#facc15', '#22c55e'], freq: null }, {
      instrumental: ['happy instrumental', 'feel good instrumental', 'upbeat acoustic', 'happy ukulele', 'feel good jazz', 'sunny lofi'],
      hindi: ['hindi feel good songs', 'bollywood happy songs', 'hindi happy hits', 'bollywood feel good', 'pritam happy songs', 'hindi upbeat songs'],
      english: ['feel good songs', 'happy hits', 'good vibes', 'feel good pop', 'happy indie', 'feel good classics'],
      punjabi: ['punjabi feel good songs', 'punjabi happy songs', 'diljit dosanjh', 'punjabi upbeat', 'happy punjabi hits', 'punjabi pop'],
      sufiGhazal: ['happy sufi songs', 'upbeat qawwali', 'coke studio feel good', 'sufi pop', 'kailash kher happy', 'sufi celebration'],
    }),
  m('sufi', 'Sufi & Ghazal evening', 'candle', 'emotion', 2, 'any',
    { desc: 'Qawwali, ghazal and kalam', vol: 3, tod: ['evening', 'night'], accent: ['#f59e0b', '#7c3aed'], freq: null }, {
      instrumental: ['sufi instrumental', 'ghazal instrumental', 'sarangi', 'harmonium instrumental', 'sufi ney flute', 'qawwali instrumental'],
      hindi: ['hindi ghazals', 'hindi sufi songs', 'bollywood sufi songs', 'jagjit singh hindi ghazals', 'pankaj udhas', 'talat aziz ghazals'],
      english: ['sufi music', 'world music sufi', 'sufi fusion', 'sufi chill', 'coke studio', 'sufi soul'],
      punjabi: ['punjabi sufi songs', 'wadali brothers', 'punjabi sufi kalam', 'bulleh shah kalam', 'satinder sartaaj', 'punjabi qawwali'],
      sufiGhazal: ['ghazals', 'qawwali', 'nusrat fateh ali khan', 'abida parveen', 'mehdi hassan ghazals', 'jagjit singh ghazals', 'ghulam ali', 'sabri brothers'],
    }),
  m('bollyinstrumental', 'Instrumental Bollywood', 'guitar', 'emotion', 2, 'instrumental',
    { desc: 'Bollywood favourites, without words', vol: 3, tod: ['afternoon', 'evening'], accent: ['#ec4899', '#0ea5e9'], freq: null }, {
      instrumental: ['bollywood instrumental', 'bollywood flute instrumental', 'bollywood piano covers', 'bollywood violin covers', 'bollywood guitar instrumental', 'bollywood saxophone', 'bollywood lofi instrumental', 'a r rahman instrumental'],
      hindi: ['bollywood instrumental', 'hindi songs instrumental', 'old hindi songs instrumental', 'bollywood sitar instrumental', 'bollywood santoor', 'hindi film instrumental'],
      english: ['bollywood orchestral', 'indian cinematic instrumental', 'bollywood strings', 'indian fusion instrumental', 'bollywood piano', 'bollywood jazz instrumental'],
      punjabi: ['punjabi instrumental', 'punjabi flute instrumental', 'punjabi dhol instrumental|4', 'punjabi guitar instrumental', 'punjabi tumbi', 'punjabi folk instrumental'],
      sufiGhazal: ['ghazal instrumental', 'sufi instrumental', 'sarangi instrumental', 'qawwali instrumental', 'harmonium ghazal instrumental', 'sufi flute'],
    }),
];

// ---------- validation ----------
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, n) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
const HEX = /^#[0-9a-f]{6}$/i;
// One phrase: "text" or "text|<energy 1-5>"
function cleanPhrase(p) {
  const [t, e] = String(p ?? '').split('|');
  const text = str(t, 80).toLowerCase();
  if (!text) return null;
  const energy = Math.round(Number(e));
  return energy >= 1 && energy <= 5 ? `${text}|${energy}` : text;
}
function cleanPhrases(ph, need) {
  const out = {};
  for (const { id } of LANGUAGES) {
    if (!ph || ph[id] == null) continue;
    const list = (Array.isArray(ph[id]) ? ph[id] : []).map(cleanPhrase).filter(Boolean);
    out[id] = [...new Set(list)].slice(0, 20);
  }
  if (need && !Object.values(out).some((l) => l.length)) throw bad('Add at least one search phrase');
  return out;
}
// A whole mood (partial: only the fields given, for edits of a built-in)
function validateMood(x, { partial = false } = {}) {
  if (!x || typeof x !== 'object') throw bad('"mood" is required');
  const o = {};
  const has = (k) => x[k] !== undefined;
  if (!partial || has('name')) { o.name = str(x.name, 40); if (!o.name) throw bad('Give the mood a name'); }
  if (!partial || has('icon') || has('emoji')) o.icon = iconOf(x); // emoji: saved before icons
  if (!partial || has('group')) { o.group = GROUPS.some((g) => g.id === x.group) ? x.group : 'relax'; }
  if (!partial || has('description')) o.description = str(x.description, 120);
  if (!partial || has('energy')) o.energy = Math.max(1, Math.min(5, Math.round(Number(x.energy)) || 3));
  if (!partial || has('vocals')) o.vocals = VOCALS.includes(x.vocals) ? x.vocals : 'any';
  if (!partial || has('defaultVolume')) o.defaultVolume = Math.max(0, Math.min(10, Math.round(Number(x.defaultVolume ?? 3))));
  if (!partial || has('defaultSleepMinutes')) {
    const s = x.defaultSleepMinutes == null || x.defaultSleepMinutes === '' ? null : Math.round(Number(x.defaultSleepMinutes));
    o.defaultSleepMinutes = s > 0 && s <= 600 ? s : null;
  }
  if (!partial || has('timeOfDay')) o.timeOfDay = (Array.isArray(x.timeOfDay) ? x.timeOfDay : []).filter((t) => PARTS.includes(t));
  if (!partial || has('days')) o.days = ['any', 'weekday', 'weekend'].includes(x.days) ? x.days : 'any';
  if (!partial || has('accent')) {
    const a = Array.isArray(x.accent) ? x.accent.filter((c) => HEX.test(c)) : [];
    o.accent = a.length === 2 ? a : ['#2cc3f0', '#3b4bd8'];
  }
  if (!partial || has('frequencyLayer')) o.frequencyLayer = x.frequencyLayer && preset(x.frequencyLayer) && !preset(x.frequencyLayer).headphonesOnly ? x.frequencyLayer : null;
  if (!partial || has('frequencyRatio')) {
    const r = x.frequencyRatio == null || x.frequencyRatio === '' ? null : Math.round(Number(x.frequencyRatio));
    o.frequencyRatio = r >= 0 && r <= 10 ? r : null;
  }
  if (!partial || has('phrases')) o.phrases = cleanPhrases(x.phrases, !partial);
  return o;
}

// ---------- the state kept in ui-state.json (store.moods) ----------
const DEFAULT_STATE = () => ({
  v: 1, custom: [], overrides: {}, hidden: [], favorites: [], last: null,
  prefs: { ambience: true, freqRatio: 3, language: 'hindi' }, history: [], scores: {}, seen: {},
});
const LIMITS = { custom: 50, favorites: 30, history: 300, phrasesPerMood: 40, seenDays: 3 };
const BUILT_IN_IDS = new Set(BUILT_IN.map((x) => x.id));
const idOk = (id) => typeof id === 'string' && /^[a-z0-9-]{2,40}$/.test(id);

// Whatever was in the file → a valid state. Bad entries are dropped one by one (logged), never the whole thing.
function migrate(raw, log = () => {}) {
  const s = DEFAULT_STATE();
  if (!raw || typeof raw !== 'object') return s;
  const keep = (what, fn) => { try { return fn(); } catch (e) { log(`Moods: dropped ${what}: ${e.message}`); return undefined; } };
  for (const c of Array.isArray(raw.custom) ? raw.custom.slice(0, LIMITS.custom) : []) {
    const mood = keep(`custom mood "${c?.name}"`, () => {
      if (!idOk(c?.id) || BUILT_IN_IDS.has(c.id)) throw new Error('bad id');
      return { id: c.id, ...validateMood(c) };
    });
    if (mood && !s.custom.some((x) => x.id === mood.id)) s.custom.push(mood);
  }
  for (const [id, o] of Object.entries(raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {})) {
    if (!BUILT_IN_IDS.has(id)) continue;
    const ov = keep(`changes to "${id}"`, () => validateMood(o, { partial: true }));
    if (ov && Object.keys(ov).length) s.overrides[id] = ov;
  }
  const known = (id) => BUILT_IN_IDS.has(id) || s.custom.some((c) => c.id === id);
  s.hidden = (Array.isArray(raw.hidden) ? raw.hidden : []).filter((id) => BUILT_IN_IDS.has(id));
  s.favorites = [...new Set((Array.isArray(raw.favorites) ? raw.favorites : []).filter(known))].slice(0, LIMITS.favorites);
  if (raw.last && known(raw.last.moodId)) s.last = { moodId: raw.last.moodId, serial: str(raw.last.serial, 40), opts: raw.last.opts && typeof raw.last.opts === 'object' ? raw.last.opts : {}, at: Number(raw.last.at) || 0 };
  const p = raw.prefs || {};
  if (typeof p.ambience === 'boolean') s.prefs.ambience = p.ambience;
  if (Number(p.freqRatio) >= 0 && Number(p.freqRatio) <= 10) s.prefs.freqRatio = Math.round(Number(p.freqRatio));
  if (LANGUAGES.some((l) => l.id === p.language)) s.prefs.language = p.language;
  s.history = (Array.isArray(raw.history) ? raw.history : []).filter((h) => h && known(h.m) && Number(h.at)).slice(-LIMITS.history);
  for (const [id, sc] of Object.entries(raw.scores && typeof raw.scores === 'object' ? raw.scores : {})) {
    if (!known(id) || !sc || typeof sc !== 'object') continue;
    const entries = Object.entries(sc).filter(([, n]) => Number.isFinite(n)).map(([k, n]) => [k, Math.max(-5, Math.min(5, n))]);
    if (entries.length) s.scores[id] = Object.fromEntries(entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, LIMITS.phrasesPerMood));
  }
  if (Number(raw.scoresAt)) s.scoresAt = Number(raw.scoresAt);
  const old = Date.now() - LIMITS.seenDays * 86400000;
  for (const [k, at] of Object.entries(raw.seen && typeof raw.seen === 'object' ? raw.seen : {})) if (Number(at) > old) s.seen[k] = Number(at);
  return s;
}

// The moods to show and play: built-ins (with the user's changes, minus deleted ones), then the user's own
function resolveMoods(state) {
  const fav = new Set(state.favorites);
  const builtIn = BUILT_IN.filter((b) => !state.hidden.includes(b.id)).map((b) => {
    const ov = state.overrides[b.id];
    return { ...b, ...ov, phrases: { ...b.phrases, ...ov?.phrases }, builtIn: true, edited: !!ov, favorite: fav.has(b.id) };
  });
  return [...builtIn, ...state.custom.map((c) => ({ ...c, builtIn: false, edited: false, favorite: fav.has(c.id) }))];
}
const builtInMood = (id) => BUILT_IN.find((b) => b.id === id) || null;

// ---------- suggestions: time of day, weekday / weekend, what's been played around this hour ----------
function partOfDay(h) {
  return h >= 5 && h < 8 ? 'early' : h < 12 && h >= 8 ? 'morning' : h >= 12 && h < 14 ? 'midday' : h >= 14 && h < 17 ? 'afternoon'
    : h >= 17 && h < 20 ? 'evening' : h >= 20 && h < 23 ? 'night' : 'late';
}
const PART_NAMES = { early: 'Early morning', morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon', evening: 'Evening', night: 'Night', late: 'Late night' };
function suggestMood(now, state, moods = resolveMoods(state)) {
  const d = new Date(now), h = d.getHours(), part = partOfDay(h), day = d.getDay();
  const weekend = day === 0 || day === 6, friSat = (day === 5 || day === 6) && h >= 18;
  const mins = h * 60 + d.getMinutes();
  const scored = moods.map((mood) => {
    let score = 0; const why = [];
    if (mood.timeOfDay?.includes(part)) { score += 3; why.push(`${PART_NAMES[part]}${mood.days === 'weekday' && !weekend ? ' on a weekday' : mood.days === 'weekend' && weekend ? ' at the weekend' : ''}`); }
    if (mood.days === 'weekday' && weekend) score -= 2;
    if (mood.days === 'weekday' && !weekend) score += 1;
    if (mood.days === 'weekend' && !weekend) score -= 2;
    if (mood.days === 'weekend' && weekend) score += 1;
    if (mood.id === 'party' && friSat) { score += 2; why.push('Weekend night'); }
    if (mood.favorite) score += 0.5;
    // Played around this time on other days: likely again; played in the last two hours: give it a rest
    const near = state.history.filter((x) => x.m === mood.id && now - x.at > 12 * 3600000 && Math.abs(new Date(x.at).getHours() * 60 + new Date(x.at).getMinutes() - mins) <= 60);
    if (near.length) { score += Math.min(3, near.length); why.unshift('You often pick this around now'); }
    if (state.history.some((x) => x.m === mood.id && now - x.at < 2 * 3600000)) score -= 1;
    return { moodId: mood.id, score, reason: why[0] || PART_NAMES[part] };
  });
  return { part, suggestions: scored.sort((a, b) => b.score - a.score).slice(0, 3).map(({ moodId, reason }) => ({ moodId, reason })) };
}

module.exports = { GROUPS, LANGUAGES, VOCALS, ICONS, BUILT_IN, LIMITS, validateMood, migrate, resolveMoods, builtInMood, suggestMood, partOfDay, DEFAULT_STATE, cleanPhrase };
