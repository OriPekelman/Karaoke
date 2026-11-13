/**
 * Wiring. Loads a score, runs the clock, and keeps the three views —
 * words, dot, guide tone — reading from the same time.
 */

import { loadFromUrl, loadFromFile, AUDIO_EXT } from './load.js';
import { Library } from './library.js';
import { apiBase, openscore, openewld, searchAll, useServer, serverHealth, guessStyle } from './sources.js';
import { usage } from './store.js';
import { alignAudio } from './align.js';
import { Transport } from './transport.js';
import { Synth } from './synth.js';
import { Stage } from './stage.js';
import { LyricView } from './lyrics.js';
import { approach, clamp, formatTime, el } from './util.js';

const $ = id => document.getElementById(id);

const ui = {
  title: $('song-title'), composer: $('song-composer'),
  splash: $('splash'), splashTitle: $('splash-title'), splashComposer: $('splash-composer'),
  clock: $('clock'), status: $('status'), tweaks: $('tweaks'), error: $('error'),
  scrub: $('scrub'), scrubFill: $('scrub-fill'),
  picker: $('demo-picker'), fileInput: $('file-input'),
  sidebar: $('sidebar'), findInput: $('find-input'), findResults: $('find-results'), findState: $('find-state'), findStyles: $('find-styles'),
  youtubeForm: $('youtube-form'), youtubeUrl: $('youtube-url'), youtubeLoad: $('youtube-load'),
  youtubeFind: $('youtube-find'), youtubeAuto: $('youtube-auto'), youtubeNote: $('youtube-note'), youtubeResults: $('youtube-results'),
  separateBox: $('separate-box'), separateBtn: $('separate-btn'), separateNote: $('separate-note'),
  playlist: $('playlist'), sideCount: $('side-count'), sideClose: $('side-close'), btnFind: $('btn-find'),
  btnOpen: $('btn-open'), btnGuide: $('btn-guide'), btnTheme: $('btn-theme'),
  btnLang: $('btn-lang'), btnVoice: $('btn-voice'), btnAll: $('btn-all'), btnAccomp: $('btn-accomp'),
  btnSpeed: $('btn-speed'), btnSlower: $('btn-slower'), btnFaster: $('btn-faster'),
};

const SPEED_MIN = 0.5, SPEED_MAX = 1.5, SPEED_STEP = 0.05;

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const transport = new Transport(ctx);
const synth = new Synth(ctx, transport);
synth.accompanying = true;   // the other instruments are part of the song, not an extra
const lyrics = new LyricView({ root: $('lines'), stackEl: $('stack'), nextEl: $('line-next') });
const stage = new Stage($('pitch'), $('band'), $('stack'));
const library = new Library();

let score = null;
let opened = {};         // the setlist entry the score came from, when there was one
let trackIndex = 0;      // which language leads
let voiceIndex = 0;      // which singer is mine
let allVoices = true;    // draw everyone's line, or only mine
let dotAlpha = 1;
let lastFrame = performance.now() / 1000;

// ── score loading ────────────────────────────────────────────────────

let loadToken = 0;

async function load(promise, listed = {}) {
  const token = ++loadToken;
  setLoading(true, listed.title || '');

  // Answer immediately with what was chosen. The file may take a moment; the
  // name of it should not, or picking a song looks like nothing happened.
  if (listed.title) {
    ui.title.textContent = listed.title;
    ui.composer.textContent = listed.artist || '';
    ui.splashTitle.textContent = listed.title;
    ui.splashComposer.textContent = listed.artist || '';
    showSplash(true);
  }

  try {
    setError('');
    const next = await promise;
    // A slow file must not land on top of a song asked for after it.
    if (token !== loadToken) return;
    score = next;
    opened = listed;
    trackIndex = 0;
    voiceIndex = 0;

    // A file need not name itself — MuseScore leaves the work title empty more
    // often than not — so the setlist entry stands in when it does. A catalogue
    // entry outranks the file: a song out of a cycle calls itself "Liederkreis,
    // Op.39" where the catalogue knows it is "Mondnacht". A dropped file has no
    // catalogue, only a filename, and there the file knows better.
    const named = score.title && score.title !== 'Untitled' ? score.title : '';
    const title = (listed.curated && listed.title) || named || listed.title || 'Untitled';
    const composer = score.composer || listed.artist || '';
    document.title = `${title} — Karaoke`;
    ui.title.textContent = title;
    ui.composer.textContent = composer;
    ui.splashTitle.textContent = title;
    ui.splashComposer.textContent = composer;

    transport.pause();
    transport.duration = score.duration;
    transport.seek(-transport.leadIn);

    // The guide tone sings the whole score; the dots ride the voices drawn.
    synth.setNotes(score.guideNotes, score.voices.length);
    synth.setAccompaniment(score.accompaniment?.notes ?? []);
    renderAccompButton();
    chordStyle = defaultChordStyle();
    lyrics.chordStyle = chordStyle;
    // Stage first: setting the words lays out a line, and the line is measured
    // against the pitch scale of the voices on the canvas.
    stage.setVoices(drawnVoices());
    lyrics.setScore(score, { voice: voiceIndex, track: trackIndex });
    relayout();
    renderLanguageButton();
    renderVoiceButton();
    renderAllVoicesButton();
    showSplash(true);
    setLoading(false);
    status('ready');
    if (playWhenReady) { playWhenReady = false; play(); }
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    setLoading(false);
    playWhenReady = false;
    setError(err.message || String(err));
    status('failed');
  }
}

function setError(msg) {
  ui.error.textContent = msg;
  ui.error.hidden = !msg;
}

function status(text) { ui.status.textContent = text; }

/**
 * Reading a score takes from a few milliseconds to the better part of a second,
 * and until now that time looked like nothing happening. The hairline says work
 * is under way, the status says what is being read, and a space pressed during
 * it is remembered rather than dropped.
 */
let loading = false;
let playWhenReady = false;

function setLoading(on, what = '') {
  loading = on;
  document.body.classList.toggle('loading', on);
  if (on) status(what ? `loading ${what}…` : 'loading…');
}

// One gesture anywhere is all the audio clock needs; after that it stays awake.
const unlock = () => {
  if (ctx.state === 'running') { synth.wake(); return; }
  ctx.resume().then(() => { if (synth.wake()) setError(''); }).catch(() => {});
};
document.addEventListener('pointerdown', unlock, { passive: true });
document.addEventListener('keydown', unlock, { passive: true });

function showSplash(on) {
  if (on) ui.splash.removeAttribute('hidden-soft');
  else ui.splash.setAttribute('hidden-soft', '');
}

// ── layout ───────────────────────────────────────────────────────────

/** Yours first, then the rest in score order — the order the rows are stacked. */
function drawnVoices() {
  if (!score) return [];
  const lead = score.voices[voiceIndex];
  if (!allVoices || score.voices.length < 2) return [lead];
  return [lead, ...score.voices.filter((_, i) => i !== voiceIndex)];
}

function relayout() {
  if (!score) return;
  stage.resize();
  const origin = $('pitch').getBoundingClientRect();
  stage.layout(lyrics.geometry(origin).slice(0, drawnVoices().length));
}

// A row that changed line has moved its words; only that voice's dot jumps.
lyrics.onLayout = key => { relayout(); stage.snap(key); };
window.addEventListener('resize', relayout);
if (document.fonts?.ready) document.fonts.ready.then(relayout);

// ── frame loop ───────────────────────────────────────────────────────

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  const dt = clamp(now - lastFrame, 0, 0.1);
  lastFrame = now;

  if (!score) return;
  const t = transport.time;

  lyrics.showAt(t);   // geometry is refreshed by onLayout after the fade
  const target = $('lines').classList.contains('swapping') ? 0 : 1;
  dotAlpha = approach(dotAlpha, target, dt, 0.09);
  stage.alpha = dotAlpha;

  lyrics.setActiveAt(t);
  stage.render(t, { active: transport.playing });

  ui.clock.textContent = `${formatTime(Math.max(0, t))} / ${formatTime(score.duration)}`;
  ui.scrubFill.style.width = `${clamp(t / score.duration, 0, 1) * 100}%`;

  if (transport.playing && t >= score.duration + 0.6) {
    transport.pause();
    synth.stop();
    document.body.classList.remove('immersed');
    status('done');
  }
}
requestAnimationFrame(frame);

// ── transport control ────────────────────────────────────────────────

transport.onSeek = () => { synth.resync(); stage.snap(); };

/**
 * Song time is read off the audio clock, so a suspended context is not merely
 * silent — nothing moves at all. Pressing space before the browser has allowed
 * sound would look like a frozen app, so this says what happened instead. And a
 * song still loading remembers that you asked, and starts when it arrives.
 */
async function play() {
  if (loading) { playWhenReady = true; status('loading…'); return; }
  if (!score) return;

  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* the state check below reports it */ }
  }
  synth.wake();
  if (ctx.state !== 'running') {
    setError('your browser is holding sound back — click anywhere on the page, then press space');
    status('sound blocked');
    return;
  }

  setError('');
  transport.play();
  synth.start();
  showSplash(false);
  document.body.classList.add('immersed');
  status('singing');
}

function pause() {
  transport.pause();
  synth.stop();
  document.body.classList.remove('immersed');
  status('paused');
}

function toggle() { transport.playing ? pause() : play(); }

// ── input ────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key;
  if (k === '/' || k === 's' || k === 'S') { e.preventDefault(); openSidebar(true); }
  else if (k === 'Escape') openSidebar(false);
  else if (k === ' ') { e.preventDefault(); toggle(); }
  else if (k === 'ArrowRight') { e.preventDefault(); transport.seek(transport.time + 5); }
  else if (k === 'ArrowLeft') { e.preventDefault(); transport.seek(transport.time - 5); }
  else if (k === 'ArrowUp') { e.preventDefault(); setTranspose(synth.transpose + 1); }
  else if (k === 'ArrowDown') { e.preventDefault(); setTranspose(synth.transpose - 1); }
  else if (k === '[') setRate(transport.rate - SPEED_STEP);
  else if (k === ']') setRate(transport.rate + SPEED_STEP);
  else if (k === '\\') setRate(1);
  else if (k === 'r' || k === 'R' || k === 'Home') { transport.restart(); }
  else if (k === 'g' || k === 'G') toggleGuide();
  else if (k === 'b' || k === 'B') toggleAccompaniment();
  else if (k === 'c' || k === 'C') cycleChords();
  else if (k === 't' || k === 'T') toggleTheme();
  else if (k === 'l' || k === 'L') cycleLanguage();
  else if (k === 'v' || k === 'V') cycleVoice();
  else if (k === 'a' || k === 'A') toggleAllVoices();
  else if (k === 'o' || k === 'O') ui.fileInput.click();
  else if (k === 'n' || k === 'N') { library.step(1); openSong(library.index); }
  else if (k === 'p' || k === 'P') { library.step(-1); openSong(library.index); }
});

function setTranspose(v) {
  synth.transpose = clamp(Math.round(v), -12, 12);
  showTweaks();
}

function setRate(v) {
  transport.setRate(clamp(Math.round(v * 100) / 100, SPEED_MIN, SPEED_MAX));
  showTweaks();
}

function showTweaks() {
  const rate = transport.rate;
  const off = Math.abs(rate - 1) > 0.001;
  ui.btnSpeed.textContent = `${Math.round(rate * 100)}%`;
  ui.btnSpeed.setAttribute('aria-pressed', String(off));
  ui.btnSlower.disabled = rate <= SPEED_MIN + 1e-6;
  ui.btnFaster.disabled = rate >= SPEED_MAX - 1e-6;

  const bits = [];
  if (synth.transpose) bits.push(`${synth.transpose > 0 ? '+' : ''}${synth.transpose} semitone${Math.abs(synth.transpose) > 1 ? 's' : ''}`);
  if (synth.track.name) bits.push(synth.track.name);
  // Resampling a recording moves its pitch; the guide tone is regenerated and does not.
  if (off && synth.track.buffer) bits.push('track pitch shifts');
  ui.tweaks.textContent = bits.join(' · ');
}

/**
 * The tone that sings the notes with you. It says which state it is in rather
 * than what pressing it would do: a button labelled for its action is ambiguous
 * about the state, and this one is easy to leave off by accident and then wonder
 * why the app is silent. It is not called "voice" — a voice here is a singer.
 */
function toggleGuide() {
  synth.enabled = !synth.enabled;
  ui.btnGuide.setAttribute('aria-pressed', String(synth.enabled));
  ui.btnGuide.textContent = synth.enabled ? 'Tone on' : 'Tone off';
  if (synth.enabled && transport.playing) synth.resync();
  else synth.silence();
  status(synth.enabled
    ? (transport.playing ? 'tone on' : 'tone on · press space')
    : 'tone off');
}

/**
 * The other instruments — the piano under a Lied, the strings under an aria.
 * They are played underneath your line rather than level with it, and the button
 * takes the name of the part it is playing, so a Lied offers "Piano" and an
 * opera "Accompaniment".
 */
function toggleAccompaniment() {
  if (!score?.accompaniment) return;
  synth.accompanying = !synth.accompanying;
  if (synth.accompanying && transport.playing) synth.resync();
  renderAccompButton();
  status(`${score.accompaniment.label.toLowerCase()} ${synth.accompanying ? 'on' : 'off'}`);
}

function renderAccompButton() {
  if (!ui.btnAccomp) return;
  const has = !!score?.accompaniment?.notes?.length;
  ui.btnAccomp.hidden = !has;
  if (!has) return;
  const { label } = score.accompaniment;
  ui.btnAccomp.textContent = `${label} ${synth.accompanying ? 'on' : 'off'}`;
  ui.btnAccomp.title = `${label} — ${score.accompaniment.notes.length} notes (B)`;
  ui.btnAccomp.setAttribute('aria-pressed', String(synth.accompanying));
}

/**
 * Chord symbols: off, letters, or solfège. Which naming a singer wants follows
 * the language they are reading — LA and MI in a French or Italian or Spanish
 * song, A and E in an English or German one — so that is where it starts, and
 * the key cycles from there.
 */
const CHORD_STYLES = ['', 'letters', 'latin'];
let chordStyle = '';

function cycleChords() {
  if (!score?.chords?.length) { status('this score has no chord symbols'); return; }
  chordStyle = CHORD_STYLES[(CHORD_STYLES.indexOf(chordStyle) + 1) % CHORD_STYLES.length];
  lyrics.setChordStyle(chordStyle);
  relayout();
  status(chordStyle ? `chords · ${chordStyle === 'latin' ? 'DO RE MI' : 'C D E'}` : 'chords off');
}

/** Romance languages name notes by solfège; everyone else uses letters. */
function defaultChordStyle() {
  if (!score?.chords?.length) return '';
  const label = score.tracks?.[trackIndex]?.label ?? '';
  return /Fran|Ital|Espa|Portug|Catal/i.test(label) ? 'latin' : 'letters';
}

function toggleTheme() {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'paper' ? 'night' : 'paper';
  setTimeout(() => stage.refreshColours(), 50);
}

function cycleLanguage() {
  if (!score || score.tracks.length < 2) return;
  trackIndex = (trackIndex + 1) % score.tracks.length;
  lyrics.setTrack(trackIndex);
  renderLanguageButton();
  relayout();
  stage.snap();
}

function renderLanguageButton() {
  if (!ui.btnLang) return;
  const many = score && score.tracks.length > 1;
  ui.btnLang.hidden = !many;
  if (many) ui.btnLang.textContent = score.tracks[trackIndex].label;
}

/**
 * Take a different part. The dot, the pitch band and the top row move to that
 * singer; the guide tone does not change, because it is singing everybody.
 */
function cycleVoice() {
  if (!score || score.voices.length < 2) return;
  voiceIndex = (voiceIndex + 1) % score.voices.length;
  lyrics.setVoice(voiceIndex);
  stage.setVoices(drawnVoices());
  renderVoiceButton();
  relayout();
  stage.snap();
}

function renderVoiceButton() {
  if (!ui.btnVoice) return;
  const many = score && score.voices.length > 1;
  ui.btnVoice.hidden = !many;
  if (many) ui.btnVoice.textContent = score.voices[voiceIndex].label;
}

/**
 * Draw everyone, or only your own line. With everyone on, the band stretches to
 * hold every voice, so your part moves less — which is the price of seeing the
 * harmony as a distance.
 */
function toggleAllVoices() {
  if (!score || score.voices.length < 2) return;
  allVoices = !allVoices;
  stage.setVoices(drawnVoices());
  renderAllVoicesButton();
  relayout();
  stage.snap();
}

function renderAllVoicesButton() {
  if (!ui.btnAll) return;
  ui.btnAll.hidden = !(score && score.voices.length > 1);
  ui.btnAll.setAttribute('aria-pressed', String(allVoices));
}

ui.btnSlower.addEventListener('click', () => setRate(transport.rate - SPEED_STEP));
ui.btnFaster.addEventListener('click', () => setRate(transport.rate + SPEED_STEP));
ui.btnSpeed.addEventListener('click', () => setRate(1));
// Wheel over the readout is the fastest way to hunt for a practice tempo.
ui.btnSpeed.addEventListener('wheel', e => {
  e.preventDefault();
  setRate(transport.rate + (e.deltaY < 0 ? SPEED_STEP : -SPEED_STEP));
}, { passive: false });

ui.btnOpen.addEventListener('click', () => ui.fileInput.click());
ui.btnGuide.addEventListener('click', toggleGuide);
if (ui.btnAccomp) ui.btnAccomp.addEventListener('click', toggleAccompaniment);
ui.btnTheme.addEventListener('click', toggleTheme);
if (ui.btnLang) ui.btnLang.addEventListener('click', cycleLanguage);
if (ui.btnVoice) ui.btnVoice.addEventListener('click', cycleVoice);
if (ui.btnAll) ui.btnAll.addEventListener('click', toggleAllVoices);

ui.fileInput.addEventListener('change', () => { handleFiles([...ui.fileInput.files]); ui.fileInput.value = ''; });

// ── the setlist ──────────────────────────────────────────────────────

function renderLibrary() {
  ui.picker.replaceChildren(...library.songs.map(s => new Option(library.label(s), s.source)));
  ui.picker.selectedIndex = library.index;
  ui.picker.hidden = library.songs.length < 1;
  if (!ui.sidebar.hidden) renderPlaylist();
}

function openSong(index) {
  const song = library.select(index);
  if (!song) return;
  ui.picker.selectedIndex = library.index;
  load(song.open(), song);
  warmNeighbours();
}

/**
 * Read the songs on either side of this one while the room is quiet. Parsing a
 * score is the only thing here big enough to be felt, so it is done ahead of
 * time and never once the transport is running: a stall in the middle of a song
 * is not worth any amount of saved memory.
 */
let warming = null;
const warmed = new Set();
// Bound, because these are Window methods and a bare reference is an illegal call.
const whenIdle = window.requestIdleCallback
  ? window.requestIdleCallback.bind(window)
  : (fn => setTimeout(() => fn({ didTimeout: true }), 900));
const cancelIdle = window.cancelIdleCallback
  ? window.cancelIdleCallback.bind(window)
  : clearTimeout;

function warmNeighbours() {
  if (warming) cancelIdle(warming);
  warming = whenIdle(async () => {
    warming = null;
    for (const step of [1, -1]) {
      if (transport.playing) return;      // the only rule: never while singing
      await library.warm(library.index + step);
    }

    // Then everything already on this machine — the demos and your own folder.
    // They cost only time we are not using, and a song picked from the list
    // should open the moment it is picked. Each is tried once a session: the
    // store forgets the least used, and chasing that would never settle.
    const next = library.songs.find(s => !s.remote && !s.score && !s.reading && !warmed.has(s.source));
    if (!next || transport.playing) return;
    warmed.add(next.source);
    await library.warm(library.songs.indexOf(next));
    warmNeighbours();
  }, { timeout: 3000 });
}

// The end of a song, or a pause, is the next chance to get ahead.
transport.onIdle = warmNeighbours;

// Hand the keyboard back after choosing. A select keeps focus once used, and
// the keys this app listens for deliberately skip form controls — so space
// would reopen the dropdown instead of starting the song you just picked.
ui.picker.addEventListener('change', () => {
  openSong(ui.picker.selectedIndex);
  ui.picker.blur();
});

// ── the setlist ──────────────────────────────────────────────────────

/**
 * A panel for preparing a session rather than for switching songs mid-flight:
 * find something, add it to the running order, drag the order into shape. It
 * sits over the stage instead of pushing it, so opening it never re-lays out the
 * words or the canvas — and the header picker stays for switching while singing.
 */
let found = [];          // everything the sources answered with
let shown = [];          // what the filter lets through; `picked` indexes this
let styleFilter = '';    // '' is everything
let picked = 0;
let findTimer = null;

function openSidebar(on = true) {
  ui.sidebar.hidden = !on;
  if (!on) return;
  renderPlaylist();
  renderYouTubeSoundtrack();
  renderSeparate();
  ui.findInput.focus();
  ui.findInput.select();
  // The index is 3MB and read the first time someone actually looks for
  // something, not at startup: most sessions never ask for it.
  Promise.all([openscore.prime(findState), openewld.prime()]).then(([lieder, songbook]) => {
    if (!found.length) findState(`${(lieder + songbook).toLocaleString()} songs to search`);
  });
}

/** Show the soundtrack control only when the optional local API explicitly
 * advertises it. Downloading is deliberately server-side: a browser cannot
 * decode a YouTube page into audio, and the operator chooses whether yt-dlp is
 * enabled when they start the server. */
async function renderYouTubeSoundtrack() {
  const health = await serverHealth();
  const enabled = !!score && !!health?.capabilities?.includes('audio') && !!health?.capabilities?.includes('youtube-search');
  ui.youtubeForm.hidden = !enabled;
  ui.youtubeAuto.hidden = !health?.capabilities?.includes('soundtrack');
  if (!enabled && score && health && !ui.sidebar.hidden) {
    // Keep this short: most people run the static app and do not need to hear
    // about a capability they did not ask for.
    ui.youtubeNote.textContent = 'start the API with --allow-download to add a YouTube soundtrack';
  } else if (enabled) {
    // A server that can download but has no PO-token helper will 403 on most
    // videos. Saying so here beats letting every attempt discover it.
    ui.youtubeNote.textContent = health.potoken && !health.potoken.ok
      ? `soundtracks may fail: ${health.potoken.why}`
      : 'matches the recording to the score';
  }
}

/**
 * What to ask YouTube for, and how to read the answer.
 *
 * The song names itself; the style decides which corner of YouTube is worth
 * asking. A Schubert Lied wants "piano accompaniment" and a Sing King backing
 * track wants "karaoke", and asking for the wrong one returns a page of things
 * you cannot sing over. The score's own length goes along too, because it is
 * the cheapest way to tell an accompaniment from a lecture about it.
 */
function scoreStyle() {
  if (opened.style) return opened.style;
  return guessStyle(`${score?.title ?? ''} ${score?.composer ?? ''} ${opened.set ?? ''} ${opened.artist ?? ''}`);
}

function soundtrackParams(extra = {}) {
  const params = new URLSearchParams({
    q: [score?.title, score?.composer].filter(Boolean).join(' '),
    style: scoreStyle(),
    ...extra,
  });
  if (Number.isFinite(score?.duration) && score.duration > 0) {
    params.set('duration', Math.round(score.duration));
  }
  return params;
}

function renderYouTubeResults(results) {
  ui.youtubeResults.replaceChildren(...results.map(hit => {
    const li = el('li', '');
    li.role = 'option';
    li.append(el('span', 'name', hit.title));
    li.append(el('span', 'who', [hit.channel, hit.duration ? formatTime(hit.duration) : ''].filter(Boolean).join(' · ')));
    li.title = `Load ${hit.title}`;
    li.addEventListener('click', () => {
      ui.youtubeUrl.value = hit.url;
      loadYouTubeSoundtrack(hit.url);
    });
    return li;
  }));
}

function findState(text) { ui.findState.textContent = text; }

function runSearch() {
  const query = ui.findInput.value.trim();
  clearTimeout(findTimer);
  if (query.length < 2) { found = []; applyFilter(); findState('type to search'); return; }
  findTimer = setTimeout(async () => {
    const t0 = performance.now();
    found = await searchAll(query, { limit: 60 });
    picked = 0;
    applyFilter();
    findState(found.length
      ? `${found.length} match${found.length > 1 ? 'es' : ''} · ${Math.round(performance.now() - t0)}ms`
      : 'nothing here by that name');
  }, 110);
}

/**
 * Which kind of song this is. A source that knows has said so; a file on this
 * machine has not, and there the words are all there is to go on.
 */
const styleOf = hit => hit.style || guessStyle(`${hit.title} ${hit.artist} ${hit.set ?? ''}`);

/**
 * The corpora do not divide by period, and now that there are three of them a
 * common word finds Lieder, standards and whatever is on this machine at once.
 * The filter is offered only when it would do something: one kind of song in
 * the results means there is nothing to choose between.
 */
function applyFilter() {
  const counts = new Map();
  for (const hit of found) {
    const style = styleOf(hit);
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  // A filter that would empty the list is one the last search has outlived.
  if (styleFilter && !counts.has(styleFilter)) styleFilter = '';

  shown = styleFilter ? found.filter(hit => styleOf(hit) === styleFilter) : found;
  if (picked >= shown.length) picked = 0;
  renderStyleChips(counts);
  renderResults();
}

function renderStyleChips(counts) {
  ui.findStyles.replaceChildren();
  ui.findStyles.hidden = counts.size < 2;
  if (counts.size < 2) return;

  const chip = (style, label, n) => {
    const b = el('button', 'label chip', n ? `${label} ${n}` : label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(styleFilter === style));
    b.addEventListener('click', () => {
      styleFilter = styleFilter === style ? '' : style;   // a second press is off
      picked = 0;
      applyFilter();
    });
    return b;
  };
  ui.findStyles.append(chip('', 'All', found.length));
  for (const [style, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    ui.findStyles.append(chip(style, style, n));
  }
}

function renderResults() {
  ui.findResults.replaceChildren(...shown.map((hit, i) => {
    const li = el('li', '');
    li.role = 'option';
    li.setAttribute('aria-selected', String(i === picked));
    li.append(el('span', 'name', hit.title));
    if (hit.set) li.append(el('span', 'set', hit.set));
    li.append(el('span', 'who', hit.artist));

    // Two intentions, kept apart: hear it now, or line it up for later.
    const add = el('button', 'add', '+');
    add.title = 'Add to the setlist';
    add.addEventListener('click', e => { e.stopPropagation(); addFound(i, false); });
    li.append(add);

    li.addEventListener('click', () => { picked = i; addFound(i, true); });
    return li;
  }));
  ui.findResults.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function moveSelection(delta) {
  if (!shown.length) return;
  picked = (picked + delta + shown.length) % shown.length;
  renderResults();
}

function addFound(index, andPlay) {
  const hit = shown[index];
  if (!hit) return;
  const before = library.songs.length;
  const at = library.addRemote(hit);
  const fresh = library.songs.length > before;
  renderLibrary();
  renderPlaylist();
  if (andPlay) { openSidebar(false); openSong(at); return; }
  status(fresh ? `added ${hit.title}` : `${hit.title} is already in the setlist`);
  ui.playlist.children[at]?.scrollIntoView({ block: 'nearest' });
}

/** The running order, in order, draggable. */
function renderPlaylist() {
  if (!ui.playlist) return;
  ui.playlist.replaceChildren(...library.songs.map((song, i) => {
    const li = el('li', i === library.index ? 'current' : '');
    li.draggable = true;
    li.dataset.index = String(i);

    li.append(el('span', 'grip', '⠿'));
    li.append(el('span', 'name', song.title));
    if (song.remote && song.saved) li.append(el('span', 'kept', '⤓'));
    li.append(el('span', 'who', song.artist || ''));

    const drop = el('button', 'drop', '×');
    drop.title = 'Take it out of the setlist';
    drop.addEventListener('click', e => {
      e.stopPropagation();
      library.remove(i);
      renderLibrary();
      renderPlaylist();
    });
    li.append(drop);

    li.addEventListener('click', () => { openSong(i); renderPlaylist(); });
    li.addEventListener('dragstart', e => {
      dragFrom = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));   // Firefox needs a payload
    });
    li.addEventListener('dragend', () => { dragFrom = -1; renderPlaylist(); });
    li.addEventListener('dragover', e => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', e => {
      e.preventDefault();
      li.classList.remove('over');
      if (dragFrom < 0 || dragFrom === i) return;
      // Inserting at the target's index does the right thing both ways: dragging
      // down, everything above has already shifted, so it lands after the row it
      // was dropped on; dragging up, it lands before it.
      library.move(dragFrom, i);
      dragFrom = -1;
      renderLibrary();
      renderPlaylist();
      status('setlist reordered');
    });
    return li;
  }));

  const kept = library.songs.filter(s => s.saved).length;
  ui.sideCount.textContent = `${library.songs.length} song${library.songs.length === 1 ? '' : 's'}${kept ? ` · ${kept} kept` : ''}`;
}

let dragFrom = -1;

ui.findInput.addEventListener('input', runSearch);
ui.findInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); addFound(picked, !e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); openSidebar(false); }
});
ui.btnFind.addEventListener('click', () => openSidebar(ui.sidebar.hidden));
ui.sideClose.addEventListener('click', () => openSidebar(false));
ui.youtubeFind.addEventListener('click', async () => {
  if (!score) return;
  ui.youtubeFind.disabled = true;
  ui.youtubeNote.textContent = 'finding likely tracks…';
  ui.youtubeResults.replaceChildren();
  try {
    const res = await fetch(`${apiBase()}/api/youtube-search?${soundtrackParams()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `search failed (${res.status})`);
    }
    const { results = [] } = await res.json();
    renderYouTubeResults(results);
    ui.youtubeNote.textContent = results.length
      ? `${results.length} likely tracks, best first — choose one to load`
      : 'no likely tracks found';
  } catch (err) {
    ui.youtubeNote.textContent = `could not find tracks: ${err.message}`;
  } finally {
    ui.youtubeFind.disabled = false;
  }
});

/**
 * The whole errand in one press: search, rank, download the best that will
 * actually download, and line it up against the score.
 *
 * A title cannot promise that a recording is the song — "Ode to Joy" returns a
 * US Navy band playing the anthem, which is the right tune and the wrong piece.
 * The aligner already knows the difference, so its verdict is what decides:
 * a recording that will not match is dropped and the next candidate tried. That
 * is the part a shortlist cannot do for you, and the reason this is one press.
 */
const AUTO_TRIES = 3;

ui.youtubeAuto.addEventListener('click', async () => {
  if (!score) return;
  ui.youtubeAuto.disabled = true;
  ui.youtubeFind.disabled = true;
  ui.youtubeResults.replaceChildren();

  let best = null;
  let skip = 0;
  try {
    for (let attempt = 0; attempt < AUTO_TRIES; attempt++) {
      ui.youtubeNote.textContent = attempt
        ? `that one did not match — trying the next (${attempt + 1} of ${AUTO_TRIES})…`
        : 'finding and loading the best match…';
      setLoading(true, 'finding a soundtrack');

      const res = await fetch(`${apiBase()}/api/soundtrack?${soundtrackParams({ skip })}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Out of candidates is only an error if nothing has worked at all.
        if (res.status === 404 && best) break;
        throw new Error(body.error || `no soundtrack (${res.status})`);
      }

      const picked = decodeHeader(res, 'x-audio-title') || 'a YouTube track';
      const channel = decodeHeader(res, 'x-audio-channel');
      const name = decodeHeader(res, 'x-audio-name') || 'youtube-soundtrack.mp3';
      // Ask past whatever rank this one turned out to be: the server may have
      // skipped candidates of its own that refused to download.
      skip = (Number(res.headers.get('x-audio-index')) || 0) + 1;
      ui.youtubeUrl.value = res.headers.get('x-audio-url') || '';
      const file = new File([await res.blob()], name, { type: res.headers.get('content-type') || 'audio/mpeg' });

      setError('');
      const fit = await useBackingTrack(file, picked);
      const confidence = fit?.confidence ?? 0;
      if (!best || confidence > best.confidence) best = { picked, channel, confidence };
      if (confidence >= 0.25) {
        ui.youtubeNote.textContent = `${picked}${channel ? ` · ${channel}` : ''} — matched ${Math.round(confidence * 100)}%`;
        return;
      }
    }
    // Nothing matched. The last one loaded is still playable, and saying which
    // ones were tried is more use than saying it failed.
    ui.youtubeNote.textContent = best
      ? `no good match in ${AUTO_TRIES} tries — best was ${best.picked} at ${Math.round(best.confidence * 100)}%. Try "Find tracks".`
      : 'nothing downloadable was found';
  } catch (err) {
    setError(`could not load soundtrack: ${err.message}`);
    ui.youtubeNote.textContent = 'nothing downloadable was found';
  } finally {
    setLoading(false);
    ui.youtubeAuto.disabled = false;
    ui.youtubeFind.disabled = false;
  }
});

/** Header values are percent-encoded so titles may carry anything. */
function decodeHeader(res, name) {
  const raw = res.headers.get(name);
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}
ui.youtubeForm.addEventListener('submit', e => {
  e.preventDefault();
  loadYouTubeSoundtrack(ui.youtubeUrl.value.trim());
});

async function loadYouTubeSoundtrack(url) {
  if (!url) return;
  if (!score) { status('open a score before loading its soundtrack'); return; }

  let parsed;
  try { parsed = new URL(url); } catch { setError('that is not a valid YouTube URL'); return; }
  if (!/^https?:$/.test(parsed.protocol) || !/(^|\.)(youtube\.com|youtu\.be)$/.test(parsed.hostname)) {
    setError('use a youtube.com or youtu.be link');
    return;
  }

  ui.youtubeLoad.disabled = true;
  ui.youtubeNote.textContent = 'getting soundtrack…';
  setLoading(true, 'getting soundtrack');
  try {
    const res = await fetch(`${apiBase()}/api/audio?url=${encodeURIComponent(parsed.href)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `soundtrack request failed (${res.status})`);
    }
    const rawName = res.headers.get('x-audio-name') || 'youtube-soundtrack.mp3';
    let name = rawName;
    try { name = decodeURIComponent(rawName); } catch { /* an ordinary filename is fine */ }
    const file = new File([await res.blob()], name, { type: res.headers.get('content-type') || 'audio/mpeg' });
    await useBackingTrack(file, 'YouTube soundtrack');
    ui.youtubeNote.textContent = 'soundtrack loaded and matched';
  } catch (err) {
    setError(`could not load soundtrack: ${err.message}`);
    ui.youtubeNote.textContent = 'could not load soundtrack';
  } finally {
    setLoading(false);
    ui.youtubeLoad.disabled = false;
  }
}

// seek by clicking the hairline
let scrubbing = false;
const scrubTo = e => {
  if (!score) return;
  const r = ui.scrub.getBoundingClientRect();
  transport.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * score.duration);
};
ui.scrub.addEventListener('pointerdown', e => { scrubbing = true; ui.scrub.setPointerCapture(e.pointerId); scrubTo(e); });
ui.scrub.addEventListener('pointermove', e => scrubbing && scrubTo(e));
ui.scrub.addEventListener('pointerup', () => { scrubbing = false; });

// reveal the chrome whenever the pointer moves
let hideTimer;
document.addEventListener('pointermove', () => {
  document.body.classList.remove('immersed');
  clearTimeout(hideTimer);
  if (transport.playing) hideTimer = setTimeout(() => document.body.classList.add('immersed'), 2200);
});

// ── drag and drop ────────────────────────────────────────────────────

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  handleFiles([...e.dataTransfer.files]);
});

async function handleFiles(files) {
  const audio = files.filter(f => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/'));
  const scores = files.filter(f => !audio.includes(f));

  // Several scores at once become a setlist rather than one winner.
  if (scores.length) {
    const at = library.add(scores);
    renderLibrary();
    openSong(at);
    if (scores.length > 1) status(`${scores.length} songs added`);
  }

  for (const file of audio) {
    try {
      await useBackingTrack(file, 'recording');
    } catch (err) {
      setError(`could not use ${file.name}: ${err.message}`);
    }
  }
}

async function useBackingTrack(file, label) {
  if (ctx.state !== 'running') await ctx.resume();
  const buffer = await synth.loadTrack(file);
  synth.enabled = false;
  ui.btnGuide.setAttribute('aria-pressed', 'false');
  ui.btnGuide.textContent = 'Tone off';
  backing.file = file;
  backing.instrumental = null;
  backing.vocalsOff = false;
  renderSeparate();
  showTweaks();
  status(`${label} loaded`);
  return alignTrack(buffer, file.name);
}

/**
 * The loaded recording in both dressings: as it was performed, and with the
 * singer taken out. Most recordings of a song have someone singing it — the
 * original record, a cover, half of what a soundtrack search returns — and a
 * voice in the playback fights the voice in the room. The server separates
 * the stems (python-audio-separator); separation preserves timing, so the
 * alignment already measured carries over and nothing is re-matched. Both
 * versions are kept, because hearing the sung line is how you learn it and
 * losing it is how you perform it.
 */
const backing = { file: null, instrumental: null, vocalsOff: false };

async function renderSeparate() {
  const health = await serverHealth();
  const usable = !!backing.file && !!health?.capabilities?.includes('separate');
  ui.separateBox.hidden = !usable;
  if (!usable) return;
  ui.separateBtn.textContent = backing.vocalsOff ? 'Vocals back on' : 'Remove vocals';
  const where = health.separator?.host;
  ui.separateNote.textContent = backing.vocalsOff
    ? 'singing the instrumental — the original is one press away'
    : backing.instrumental ? 'the instrumental is ready'
    : `takes the singer out, keeps the band${where && where !== 'local' ? ` — on ${where}` : ''}`;
}

ui.separateBtn.addEventListener('click', async () => {
  if (!backing.file) return;

  // Already separated: this is a toggle, not a request. The buffers swap under
  // the same offset and stretch, so the song does not miss a beat.
  if (backing.instrumental) {
    backing.vocalsOff = !backing.vocalsOff;
    await synth.loadTrack(backing.vocalsOff ? backing.instrumental : backing.file);
    status(backing.vocalsOff ? 'vocals removed' : 'original recording');
    showTweaks();
    renderSeparate();
    return;
  }

  ui.separateBtn.disabled = true;
  ui.separateNote.textContent = 'separating — the first ever run also downloads the model…';
  setLoading(true, 'removing the vocals');
  try {
    const res = await fetch(`${apiBase()}/api/separate`, {
      method: 'POST',
      headers: {
        'content-type': backing.file.type || 'audio/mpeg',
        'x-audio-name': encodeURIComponent(backing.file.name),
      },
      body: backing.file,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `separation failed (${res.status})`);
    }
    const name = decodeHeader(res, 'x-audio-name') || 'instrumental.mp3';
    backing.instrumental = new File([await res.blob()], name, { type: 'audio/mpeg' });
    backing.vocalsOff = true;
    await synth.loadTrack(backing.instrumental);
    status('vocals removed');
  } catch (err) {
    setError(`could not remove the vocals: ${err.message}`);
  } finally {
    setLoading(false);
    ui.separateBtn.disabled = false;
    showTweaks();
    await renderSeparate();
    if (!backing.instrumental) ui.separateNote.textContent = 'could not remove the vocals';
  }
});

/**
 * Match a dropped recording to the score it is a recording of.
 *
 * A cover is in another key, at another tempo, after some length of
 * introduction, and none of that is knowable in advance — so it is measured.
 * What comes back is applied only if the match is good enough to be worth
 * trusting: a wrong alignment is worse than none, because it looks like the app
 * is broken rather than like the file is unrelated.
 */
async function alignTrack(buffer, name) {
  if (!score || !buffer) return;
  setLoading(true, `matching ${name}`);
  try {
    const fit = await alignAudio(buffer, score, {
      onProgress: p => setLoading(true, `matching ${name} · ${Math.round(p * 100)}%`),
    });

    if (fit.confidence < 0.25) {
      synth.track.offset = 0;
      synth.track.stretch = 1;
      setError(`that recording does not seem to be this song (match ${Math.round(fit.confidence * 100)}%) — it will play unaligned`);
      status('not matched');
      return fit;
    }

    synth.track.stretch = 1 / fit.rate;
    synth.track.offset = fit.offset;
    setRate(fit.rate);                       // the score bends; the recording does not
    if (fit.transpose) setTranspose(fit.transpose);
    transport.seek(0);

    const bits = [
      `matched ${Math.round(fit.confidence * 100)}%`,
      fit.offset > 0.05 ? `starts ${fit.offset.toFixed(1)}s in` : '',
      Math.abs(fit.rate - 1) > 0.01 ? `${Math.round(fit.rate * 100)}% speed` : 'same tempo',
      fit.transpose ? `${fit.transpose > 0 ? '+' : ''}${fit.transpose} semitones` : 'same key',
    ].filter(Boolean);
    status(bits.join(' · '));
    return fit;
  } catch (err) {
    setError(`could not match that recording: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

// ── boot ─────────────────────────────────────────────────────────────

showTweaks();
try {
  await library.loadManifest();
  renderLibrary();
  openSong(0);
} catch (err) {
  setError('no song library found — drop a MusicXML file to begin');
  ui.picker.hidden = true;
}

// Songs found on another day are still yours: they come back from the store,
// and the search index is warmed so the finder answers instantly and offline.
library.restoreSaved().then(n => { if (n) renderLibrary(); }).catch(() => {});

// Registered straight away rather than on `load`: this module awaits the
// manifest, so by the time it resumes the load event is long gone.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('offline unavailable:', err.message));
}

// A handle for the console, and the hook a backend would drive the player through.
window.karaoke = {
  transport, synth, stage, lyrics, library,
  get score() { return score; },
  play, pause, load, loadFromUrl, openSong,
  setlist: openSidebar, search: searchAll, usage,
  // Point the app at a server on another port: karaoke.useServer('http://localhost:8090')
  useServer, serverHealth,
};
