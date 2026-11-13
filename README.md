# Karaoke

A karaoke player that shows a dot instead of a staff.

The dot rides above the words: **horizontally** it follows the syllable being
sung, **vertically** it follows the pitch. It never jumps between notes — the
position glides — so the sense of a new note comes from the *pulse* instead: a
fast attack, a decay to sustain, a fade before release, and a ring that expands
away on the onset. A note that sits outside the key is **coloured red** — which way it leans is
something the notation already tells you; that it is chromatic at all is what you
need to see coming. There is no staff, no clef, no bar lines — only the
line you are singing, the line coming next, and a faint contour of the notes
still ahead of the dot.

A score can carry the same song in several languages, and they are treated as
peers: same size, stacked, and **each one highlights its own syllable** as the
music passes. Whichever line you read, you can sing — which is the point when
the room is multilingual. Right-to-left scripts work as they should; the dot
travels right to left with the words.

A score can also carry several **people** singing, and they are peers too. Every
part that has words gets a row of its own, labelled with the singer's name and
running on its own clock — in a round the same words arrive bars apart, and in a
duet they are not even the same words. A part that is resting fades back rather
than leaving, so you can see your entry coming. <kbd>V</kbd> says which part is
yours: the bright dot and the top row move to it. The guide tone does not change,
because it is singing everybody.

Every voice gets a **dot of its own**, with a letter in it — S A T B for a choir,
I II III for the voices of a round — and they all share one pitch scale, so a
bass really does sit below a soprano and the harmony is a distance you can read.
<kbd>A</kbd> turns the other voices off if you would rather have the whole height
to yourself. A dot is filled while its voice sounds and hollow while it does not,
so **entries and releases are visible**: a ring expands away on the way in and
closes on the way out, and a waiting dot carries a **count-in** — one tick per
beat until it sings, going out left to right, the thing a conductor gives you.
The beat that is passing is struck and decays across itself, so the count pulses
in time rather than sitting there. (It is deliberately not a ring filling itself:
that reads as a machine thinking, which is the last thing to say to someone about
to sing.)

And because a phrase you cannot see is a phrase you cannot prepare, the last
seconds of a line **sketch the next one** to the right of it: a hollow target at
the pitch you have to find, its own count-in in beats, a dotted line from where
you are now to where that is, and the shape that follows.

The sketch is a **miniature, not a squashed copy** — half the stage's own scale
in *both* directions, the same pixels-per-note against pixels-per-semitone — so a
fourth in the phrase ahead looks like a fourth, and the shape you are about to
sing is the shape you will sing. The entry note keeps its true height, so its
pitch stays directly comparable with where your dot is now, and the rest of the
phrase hangs off it to scale. If the strip is too narrow, notes are dropped from
the end rather than the whole thing being shrunk past reading.

## Run it

```sh
./serve.sh          # http://localhost:8080
```

Any static server works. No build step, no dependencies, no backend — but it
does need an origin, because ES modules will not load over `file://`.

**Sound needs a gesture.** Browsers will not let a page make a noise before you
have touched it, and this app's clock *is* the audio clock — so a suspended
context does not merely mute the guide tone, it stops the dot moving. Any click
or key wakes it. If you press space before that has happened, the app says so
rather than sitting there looking broken.

Reading a score takes anywhere from 6ms to about a second, and while it does, a
hairline crosses the top of the window and the status line names what is being
read. Press space during it and the song starts the moment it is ready.

## Use it

Drop **`.musicxml`**, **`.xml`**, **`.mxl`**, **`.mscz`** or **`.kar`** files
anywhere on the window — several at once become a setlist. Drop an audio file to
sing over a real recording instead of the synth guide tone.

To use a **YouTube soundtrack**, run the API server with its explicit opt-in,
then open the setlist:

```sh
node server/karaoke.mjs --allow-download
```

**Auto** does the whole errand in one press: it searches, ranks, downloads the
best candidate that will actually download, and aligns it. If the aligner says a
recording is not this song, it drops it and tries the next — up to three — which
is the part a shortlist cannot do for you, because a title cannot promise that a
recording is the song. *Ode to Joy* returns a US Navy band playing the anthem:
the right tune, the wrong piece, and only alignment can tell.

**Find tracks** gives you the ranked shortlist instead, and you may always paste
a `youtube.com` / `youtu.be` link yourself and choose Load. The track is decoded
locally and aligned to the open score just like a dropped recording.

Ranking is done on the server, because the same judgement serves the automatic
pick. It asks YouTube three ways at once — the phrasing that finds a soundtrack
differs by repertoire, so a Lied is asked for as a *piano accompaniment* and a
standard as a *backing track* — then merges the answers and scores each on
whether the title claims to be an accompaniment, whether it claims to be a
lecture about one, and whether it lasts about as long as the score does.

#### What YouTube now takes

`yt-dlp` alone is no longer enough, and the error it gives — `HTTP Error 403:
Forbidden` — names none of the three things actually missing. The server handles
all three, so this is background rather than instructions:

- **A JavaScript runtime**, because the media URL is signed by a parameter only
  the player's own JS can compute. The server is a node process, so it passes
  its own `process.execPath` and the runtime cannot be missing.
- **A PO token**, which the clients that still publish a direct URL now demand.
  [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
  mints them, but only as a daemon — its one-shot script mode fails on the
  integrity token often enough to be no use — so the server starts that daemon
  itself and stops it on the way out. `/api/health` reports whether it is there,
  and the setlist says so rather than letting every attempt discover it.
- **The right client**, because the default chain lands on `web_safari`, which
  YouTube has moved to SABR streaming and which publishes no URL at all. The
  server walks a ladder of clients, `tv_simply` first, since which one works is
  a property of the video and of the week.

Installing the two helpers, once:

```sh
uv tool install --force yt-dlp --with yt-dlp-ejs --with bgutil-ytdlp-pot-provider
git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider ~/bgutil-ytdlp-pot-provider
cd ~/bgutil-ytdlp-pot-provider/server && npm install && npx tsc
```

`--pot-server <path>` and `--pot-port` move the helper if it lives elsewhere.
This is intended for media you are allowed to download. The control stays hidden
unless that server capability is enabled.

**Karaoke MIDI** (`.kar`, `.mid`) is read too. It is an ordinary MIDI file whose
words ride in text meta-events, with `@`-prefixed metadata and a convention that
a syllable continuing a word arrives without a leading space — which is the whole
of its hyphenation, and is what lets it say "vor‑rei" rather than "vor rei".
Whoever carries the words becomes the voice; the other channels become the
accompaniment. There is a large licensed catalogue of these in the world, and
this is what opens it.

**Chord symbols** are read from MusicXML `<harmony>` and MuseScore `<Harmony>`
and placed lead-sheet style, over the syllable they change on — a chord in the
margin is a chord you cannot use. <kbd>C</kbd> cycles off, letters and solfège:
half the world writes **Am/E** and half writes **LAm/MI**, and it starts from
whichever the language you are reading suggests.

| key | |
|---|---|
| <kbd>space</kbd> | play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | seek ±5s |
| <kbd>↑</kbd> <kbd>↓</kbd> | transpose the guide tone |
| <kbd>[</kbd> <kbd>]</kbd> | slower / faster, 50%–150% in 5% steps |
| <kbd>\</kbd> | back to normal speed |
| <kbd>L</kbd> | which language leads (the one the dot sits on) |
| <kbd>V</kbd> | which part is mine, when several people sing |
| <kbd>A</kbd> | draw every part, or only mine |
| <kbd>N</kbd> / <kbd>P</kbd> | next / previous song |
| <kbd>G</kbd> | the tone that sings your notes with you |
| <kbd>B</kbd> | the other instruments — the piano under a Lied |
| <kbd>C</kbd> | chord symbols: off, letters (Am), solfège (LAm) |
| <kbd>T</kbd> | dark / paper |
| <kbd>R</kbd> | restart |
| <kbd>O</kbd> | open files |
| <kbd>S</kbd> | the setlist: find, add, reorder |

The accompaniment plays a **recorded piano** — the FluidR3 General MIDI
soundfont, one mp3 per pitch, published under CC-BY and fetched from GitHub. A
thousand piano notes as triangle waves sound like a test signal, and the
accompaniment is where most of the notes are. It loads only the pitches a score
actually reaches, rounded to every third semitone and shifted at most a tone and
a half either way, so a song wants a dozen files rather than eighty-eight —
*Après un rêve* covers its 45 distinct pitches with 18 samples. The bytes go into
the same store as everything else, so the second time is free and works offline,
and if any of it fails the synthesised tone takes over: it is an improvement, not
a dependency. The guide tone stays synthetic on purpose — it has to sustain any
length of note, and your own line should not share a timbre with the instruments
underneath it.

Two things make the sound, and each has a button that says which state it is in
rather than what pressing it would do — silence is easy to cause and hard to
diagnose. **Tone on/off** is the tone that sings your notes with you. **Piano
on/off** is everything else in the score: the accompaniment is read from the same
scan the voices come from, chords and all, and played underneath on its own
quieter, darker bus so it supports your line instead of competing with it. The
button takes the name of the part it is playing, so a Lied offers *Piano* and an
opera *Accompaniment*; a score with nothing but a vocal line does not show it at
all. (It is not called "voice" — a voice here is a singer.)

The `.mscz` reader keeps only the top note of a chord, so from MuseScore's own
format the accompaniment is a sketch; the MusicXML export is exact.

### Singing over a recording

Drop an audio file — a cover, a backing track, a rehearsal recording — and the
app **matches it to the score by ear**. It is in another key, at another tempo,
after however long an introduction the performer felt like, and none of that is
knowable in advance, so it is measured: both sides are reduced to *chroma* (how
much of each of the twelve pitch classes is sounding), and the cheapest path
pairing one with the other is found by dynamic time warping. Chroma ignores
octave and timbre, so a piano roll and a rock band playing the same harmony look
alike; the key is found by trying rotations of it.

The warp is a **subsequence** match — the score is matched against *part of* the
recording, which is the actual relationship between a piece of music and a
recording of one. Pinning both ends to both corners assumes the recording starts
and stops exactly where the score does, and on a file with a 15-second intro that
error alone put the offset out by 1.4 seconds.

What comes back is an offset, a tempo ratio and a transposition. The score's
clock bends to fit; the recording plays exactly as it was performed. The guide
tone transposes so it still agrees with what you are hearing.

It works in two stages, and the first one is the one that matters. Before
anything is warped, the score is **slid along the recording at a dozen plausible
tempos** to find where it sits; only then is a warp run, inside a band of ±8
seconds around that line. Skipping the first stage is a trap worth describing: a
warp free to begin and end anywhere, given a pair that does not match, finds it
cheaper to race through 200 seconds of score against 30 seconds of audio and
reports a tempo five times the truth. A fixed-tempo scan cannot do that, because
a fixed tempo is exactly what it is testing.

**It refuses bad matches**, and the thresholds come from measurement rather than
taste — including one real commercial recording, which is the case synthetic
tests cannot speak for. Against renderings of the score itself a true match costs
0.11; against a real produced track a *perfect* match costs 0.41, because drums
and voices are not in the arrangement at all. So absolute cost decides very
little. What decides is **straightness** (0.42s of drift across 198 seconds),
how far the winning placement **stood above** the average one, and **coverage** —
how much of the recording the score accounts for.

Coverage is what separates the hard case. The same real recording matched against
*the wrong score entirely* came back at cost 0.398 — better than the true pairing
— with a straight path and a plausible tempo. Only one thing told them apart: the
true score accounted for 92% of the recording and the wrong one for 11%. A
performance of a piece runs alongside most of it; a short score that merely fits
*somewhere* inside a long recording has found a coincidence.

That last point is a prior, not a proof: it would wrongly refuse a legitimate
"find this song inside an hour of concert" request. If you need that, the numbers
are all in the returned object and the threshold is one line.

### When the recording already has a singer

Most recordings of a song do — the original record, a cover, half of what a
soundtrack search returns — and a voice in the playback fights the voice in the
room. If the server finds
[python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator)
(the engine under Ultimate Vocal Remover) — on a GPU box it can reach, or
failing that here — the setlist offers
**Remove vocals** whenever a recording is loaded: the mix is split into stems
and the instrumental takes the playback's place. Separation preserves timing,
so the alignment already measured carries over — nothing is re-matched — and
the original stays one press away, because hearing the sung line is how you
learn it and losing it is how you perform it.

Installing it, once (`--with audioread` because the package forgets to declare
that dependency):

```sh
uv tool install "audio-separator[cpu]" --with audioread
```

Separation is the one genuinely heavy thing this server can be asked for, so
it looks for a **GPU box before it burdens the machine you are singing on**:
the probe walks `gx10`, then `evo`, then here, and takes the first place where
`audio-separator` answers. A remote host needs nothing but that same `uv tool
install` (plus ffmpeg) — the job travels over **a single ssh**, audio down
stdin, instrumental back up stdout, using the trust already on the tailnet: no
daemon, no open port, and the far side keeps nothing but its model cache. The
probe is re-asked every few minutes, so the GPU box that was asleep at startup
is found when it wakes, and a host that fails a job is forgotten and re-probed
rather than trusted again. `--separator-host <host>` pins one; `--separator-host
local` keeps everything on this machine.

**Which model runs depends on where**, and that is a measurement, not taste.
On a GPU box the default is audio-separator's own — BS-Roformer, the current
state of the art (on the GB10 it runs on CUDA). On an M2 Air that same model
ran at 18 seconds per chunk until memory pressure hit and then at ten
*minutes* per chunk — so the local fallback is MDX-Net
(`UVR-MDX-NET-Inst_HQ_3.onnx`), which runs through CoreML in well under real
time and separates cleanly enough to sing over. `--separator-model <file>`
overrides both (`audio-separator --list_models` names them).

Either way, the first separation downloads the model — once, on whichever
machine runs it — and each recording is separated once and cached on this
side, keyed on its content and the model that did it, so asking again is free.

Speed also has a `– 100% +` control in the header; click the readout to reset,
or scroll on it. Slowing down is the useful direction — it is how you learn a
line. The guide tone is regenerated at each new tempo, so **it does not change
pitch**. A dropped backing track is resampled, so that one does shift; the
status line says so while it applies.

## The setlist

<kbd>S</kbd> opens the sidebar, which is for *preparing* a session rather than
for switching songs mid-flight: find a song, add it to the running order, and
drag the order into the shape you mean to sing it in. Clicking a result plays it
now; the **+** beside it lines it up for later without interrupting what is
playing. <kbd>×</kbd> takes a song out, and the header picker stays as the quick
switcher while you sing. The panel sits over the stage rather than pushing it,
so opening it never re-lays out the words or the canvas.

It searches **OpenScore's Lieder corpus** — 1,356
songs by 19th-century composers, public domain, published by MuseScore under
CC0 — and opens any of them straight into the player. Schubert, Schumann, Fauré,
Brahms, and a great many composers you have not heard of, about a third of them
women.

It also searches the **OpenEWLD songbook** — 502 lead sheets of the popular
repertoire, melody with its words and its chord symbols, which is what a
standard is actually written down as. It is the public-domain half of the
Enhanced Wikifonia Leadsheet Dataset: Gershwin, Kern, Youmans, Carmichael, and
the traditional songs and carols beside them. *Blue Moon* opens with its words
and its changes — `B♭7`, `E♭Maj7` — over the melody.

Neither needs a server. GitHub serves both with `access-control-allow-origin: *`,
so the browser may read the indexes and the scores itself. Each index is
built once from the repository's own file tree and kept for a month, so search
answers in a couple of milliseconds — and keeps answering with the network off.

**Both corpora stop where copyright starts** — the Lieder are nineteenth-century
and the songbook runs out around 1930 — so a common word can now return a Lied,
a standard and a file of your own at once. The finder tags each result with the
kind of song it is and offers the choice as chips, which appear only when there
is something to choose between. The same tag decides how a soundtrack is looked
for, which is why it is worth having.

Anything newer is not free to redistribute and so is not shipped. A copy you
already have is another matter, and `tools/import-songs.mjs` puts one where the
server can find it:

```sh
node tools/import-songs.mjs ~/Downloads/Wikifonia.zip --corpus ~/Documents/MuseScore3/Scores \
  --collection Wikifonia --style pop
node tools/import-songs.mjs ~/Downloads/scores --collection "From MuseScore" --style pop --dry-run
```

The source may be a `.zip` or a folder. Names are read the way Wikifonia writes
them — `Artist - Title.mxl` — because the corpus indexer takes the artist from
the folder a score sits in, so the import is what decides whether searching for
a composer finds anything. `--style` writes a `.karaoke-style` file the server
reads, which is what puts imported songs under the right chip and asks for their
soundtracks the right way. `--dry-run` shows what it would do.

**musescore.com is not fetched**, for the same reason CPDL is not: it answers
every non-browser client with a Cloudflare challenge, and getting round that
would mean driving a headless browser against their defences. Their `.mscz`
downloads through your own browser and drops onto the window like any other
file, or goes through the importer with the rest.

**Anything you open is kept.** The file and the built score both go into
IndexedDB, so the second opening costs nothing and the song is there next time,
on a train, with no network. Kept songs show a ⤓ in the picker and survive a
reload. The store holds 250MB before it starts forgetting the least recently
used — your own manifest songs are never touched, since they are files on disk
already.

And the app itself works offline: a service worker keeps the shell and the
bundled demos, so Karaoke opens, plays and searches with nothing behind it. It
installs as a standalone app if your browser offers that.

Everything is network-first with a 2.5-second fuse, falling back to the cache —
so an edited file never serves stale, and a flaky connection never hangs.

### Where else songs could come from

The awkward truth is that most sheet music on the web cannot be read by a web
page. **CPDL/ChoralWiki** — 50,000 choral works, the natural home of the
multi-voice repertoire — sits behind a Cloudflare challenge that refuses every
non-browser client, server included; getting past that means driving a headless
browser against their defences, which is their answer being ignored, so this
does not do it. **IMSLP** and **KernScores** send no CORS header either, though a
server may read them. **PDMX** — 250K public-domain MusicXML scores — is a bulk
download for a server to ingest, and its own README notes a licence-metadata
conflict on 12% of files.

So: GitHub-hosted corpora work in the browser today. Everything else needs the
server below, and some of it should simply be left alone.

## Your own songs

`assets/library.json` is the shelf:

```json
{ "songs": [
  { "file": "au-clair-de-la-lune.musicxml",
    "title": "Au clair de la lune",
    "artist": "traditionnel",
    "languages": ["Français"] }
] }
```

Paths are relative to the manifest they appear in, and a manifest may `include`
others. `assets/library.json` already includes **`songs/library.json`** — that is
where your own music goes, so your setlist never tangles with the bundled demos:

```sh
cp ~/scores/my-song.mxl songs/
$EDITOR songs/library.json     # add { "file": "my-song.mxl", "title": …, "artist": … }
```

An included manifest that is missing or malformed is skipped rather than fatal,
so an empty personal library is the normal case, not an error. Files dropped on
the window are appended for the session without touching either manifest. When a
backend arrives, this JSON is the shape its endpoint should return — see
`js/library.js`.

## Getting scores in

MuseScore's **File → Export → MusicXML** is the intended path, and `.mxl` (the
compressed form) is what it gives you by default. `.mscz` is read directly too,
on a best-effort basis — it is MuseScore's private format, so if a file comes
out wrong, export MusicXML and it will be exact.

The player reads the parts that sing: every part+`<voice>` carrying lyrics
becomes a line on stage, named after the part. That is what separates Leporello
from the flutes doubling him — the orchestra has no words, so it never appears.
A stray two-word cue on an instrumental staff is below the floor and ignored
too. With no words anywhere, the busiest voice is taken and sung in solfège.

Within a part the reader follows ties and treats a note with no word of its own
as a melisma — the word holds while the dot keeps moving. Repeat barlines are
**not** expanded; write the repeat out if you need it.

### Several languages

Each `<lyric number="…">` on a note is a separate language track, and `name`
gives it a label:

```xml
<note>
  <pitch><step>E</step><octave>4</octave></pitch>
  <duration>4</duration>
  <lyric number="1" name="Deutsch"><syllabic>begin</syllabic><text>Freu</text></lyric>
  <lyric number="2" name="English"><syllabic>single</syllabic><text>Joy,</text></lyric>
  <lyric number="3" name="עברית"><syllabic>begin</syllabic><text>שמ</text></lyric>
</note>
```

In MuseScore these are just verses 1, 2, 3 — <kbd>Ctrl</kbd>+<kbd>L</kbd> on the
first note, type the verse, then <kbd>↓</kbd> to start the next one on the same
note. Export MusicXML and every verse arrives as its own language track. (Verse
numbers become the labels; MusicXML's `name` attribute gets you "Français"
instead of "Verse 3".)

### Languages, or stanzas?

A numbered lyric line means two different things, and scores almost never say
which. `<lyric number="2">` is *another language for the same music* in Fauré's
**Après un rêve** — Bussine's French over the Tuscan original — and those belong
on screen together. It is *the next stanza* in Schubert's **Heidenröslein**,
which you sing afterwards, and stacking those makes no sense at all.

Nothing in the file distinguishes them, but the words do: two stanzas of one poem
are in one language and a translation is not. So a line the score has `name`d is
believed, and otherwise `js/language.js` reads the text — a script check, then a
count of the little words that give a language away — and the lines stack only if
they turn out to be different languages. It is a crude test used for one narrow
question, never trusted to be right about *which* language unless it is sure, and
when it cannot tell, the lines are kept apart, because a verse stacked on a verse
is the mistake a singer notices.

Two things make it work: syllables are rejoined into words first ("vor‑rei" is
not "vor rei"), and a recognised language replaces the label, so the rows read
**Français / Italiano** rather than "Verse 1 / Verse 2". Munktell's *Cantilène*
comes out French over Swedish; *Là ci darem la mano* Italian over German.

If you would rather write a score than engrave one, `tools/make-score.mjs` takes
a compact spec — pitches, durations, one syllable list per language — and emits
the MusicXML:

```sh
cp tools/example-song.mjs my-song.mjs     # then edit
node tools/make-score.mjs my-song.mjs     # → assets/my-song.musicxml
```

It refuses specs that will not sing: measures that do not add up, and tracks
whose syllable count does not match the notes.

Because singable translations align syllable-for-note, every track shares one
note stream. Line breaks are decided once — from the music, not the punctuation:
a rest, or a syllable held out relative to the tune, is where a singer breathes,
and the resulting phrases are packed into lines by balance. Every other language
is then sliced against those same note ranges, so the lines always say the same
thing in every language. Text direction is detected per track from the script.

### Several singers

Languages and singers are different axes and behave differently. Languages share
a note stream, so they break into the same lines and always say the same thing.
Singers do not share anything: each voice gets its own line planning, its own
range, and its own place in the piece. Voices are *when*, languages are *what in*.

Nothing special is needed in the score — two staves with words is a duet, three
is a round. With more than one singer on stage, the languages stop stacking and
<kbd>L</kbd> moves every part to the same language at once, so the rows stay one
per person. `tools/make-score.mjs` writes multi-part scores too, with `parts`
instead of `measures`:

```js
parts: [
  { name: 'Voix I',  measures: roundVoice(0, 4) },   // enters at bar 1
  { name: 'Voix II', measures: roundVoice(2, 2) },   // two bars later
]
```

A part with no `tracks` of its own sings the score's — which is what a round
wants — while a duet gives each singer their own. See `frere-jacques-round` in
`tools/make-demos.mjs`.

The guide tone plays every voice at one level, with unisons folded together so
they do not beat against each other, and the bus gives way as voices are added
so a duet is not twice as loud as a song.

The letter in each dot comes from the part name: one character if that is enough
to tell them apart (Soprano → S, Zerlina → Z), the trailing roman numeral if
there is one (Voix II → II), initials or numbers if two parts would otherwise
collide. It is assigned once, in `assignBadges()`, so the same singer keeps the
same letter for the whole song.

## Demos

| | |
|---|---|
| `ode-to-joy-multilingual` | five languages over one melody, two of them right-to-left |
| `au-clair-de-la-lune` | French, one language — the layout gives it the whole stage |
| `amazing-grace` | melismas — one word held across three notes |
| `greensleeves` | a D♯ against a one-sharp key signature: the colouring in context |
| `frere-jacques-round` | three singers entering two bars apart, in three languages |
| `solfege-ladder` | nothing but altered notes, up in sharps and down in flats |

All six are public domain. The piano the accompaniment plays is the
[FluidR3_GM soundfont](https://github.com/gleitz/midi-js-soundfonts), rendered to
mp3 by Ben Gleitzman and released under CC-BY 3.0. They are generated from a compact transcription in
`tools/make-demos.mjs` — edit that and run `node tools/make-demos.mjs` rather
than hand-editing the XML.

### Songs that are not here

**Donna Donna** and **Barbara** were both asked for, and neither is bundled.
Donna Donna is Sholom Secunda (1940) and Aaron Zeitlin, with the English of
Kevess and Schwartz (1956) and the French of 1964; Joan Baez sings it but does
not own it. Barbara died in 1997. All of it is still in copyright — words and
melody alike — so it is not shipped here. Nothing in the app stops you: put your
own scores in `assets/library.json`, or drop them on the window. The
five-language demo exists to prove that path works end to end.

## Layout

```
index.html
css/style.css
js/
  app.js         wiring, input, the frame loop
  library.js     the setlist — manifest, found songs, dropped files
  sources.js     where songs are searched for: OpenScore, the songbook, and a server if there is one
  store.js       IndexedDB: kept scores and cached indexes
  dom.js         the one browser dependency the readers have, made injectable
  load.js        file/URL → score, whatever the container
  musicxml.js    MusicXML → one note stream per singing voice
  musescore.js   the same, best-effort, from MuseScore's own format
  zip.js         .mxl / .mscz containers, inflating via DecompressionStream
  score.js       notes → syllables → lines, per voice and per language track
  transport.js   the clock — song time comes off the audio clock, not rAF
  synth.js       guide tone, accompaniment, and a dropped recording
  instrument.js  recorded piano notes, fetched and cached as needed
  align.js       matching a recording to the score: chroma, and a subsequence warp
  chords.js      chord symbols, spelled as letters or as solfège
  midi.js        .kar and .mid — karaoke MIDI, words and all
  stage.js       canvas: a dot per voice, the contours, the phrase ahead
  lyrics.js      the words, and where each syllable landed on screen
sw.js            the service worker: the app itself, offline
assets/          library.json + demo scores + icons
server/
  karaoke.mjs    optional: proxy, pre-parsing, and your own folder
  minidom.mjs    just enough XML for the readers, where there is no DOMParser
tools/           score generator and demo transcriptions
```

Four things are worth knowing if you change anything:

- **Time is the audio clock.** `Transport.time` is derived from
  `AudioContext.currentTime`, so the dot and the guide tone cannot drift apart.
  Anything that needs to happen at a musical moment should ask the transport,
  never `performance.now()`.
- **The canvas asks the DOM where the words are.** `LyricView.measure()` returns
  each syllable's box and `Stage.layout()` turns those into note positions, so
  the dot is always over the right word whatever the font, the wrap or the
  writing direction — at the cost of a relayout whenever the line changes.
- **The words own the horizontal, the pitch owns the vertical.** Every row
  advances on its own clock in `LyricView.showAt()` and reports its geometry
  through `LyricView.geometry()`; `Stage.layout()` turns each row's syllable
  boxes into that voice's note positions. So the canvas can only draw a voice
  whose words are on screen — and it must be given its voices, with
  `Stage.setVoices()`, before the words are set, or the first layout measures
  against the wrong pitch scale.
- **Line breaking is musical.** `planLines()` in `score.js` reads rests and held
  notes first and punctuation only as a suggestion. Commas lie: "Au clair de la
  lune," is mid-phrase and "Götterfunken," ends one.
- **Nothing heavy happens while the transport runs.** A frame — three voices,
  words and canvas — costs about 0.05 ms, and a line change about 0.3 ms, both
  well inside a 16.7 ms budget. The one expensive thing in the app is reading a
  score: 6 ms for a demo, 130 ms for a duet in MuseScore's own format, 650 ms
  for a full orchestral one. So scores are read once and kept (`memoise` in
  `library.js`), and the neighbours in the setlist are read ahead during idle
  time — but never while singing, which `Library.warm()` leaves to its caller to
  enforce. If you add work anywhere, add it there.

## The server

Optional. The app plays local files and searches OpenScore without it.

```sh
node server/karaoke.mjs --port 8090 --corpus ~/Documents/MuseScore3/Scores
```

It serves the app as well, so opening **http://localhost:8090** is enough. If you
would rather keep using `./serve.sh`, that forwards `/api/*` to this server when
it is running (set `KARAOKE_API=host:port` to point elsewhere) and answers a
plain 503 when it is not — so the app degrades to its no-server self instead of
littering the console with 404s. From any other origin,
`karaoke.useServer('http://localhost:8090')` in the console records the base
once; the server allows the cross-origin call.

It does the three things a page cannot:

| | |
|---|---|
| `/api/fetch?url=` | reaches a score the browser is not allowed to reach, and keeps a copy. **Allow-listed**, not an open proxy — GitHub by default, `--allow host,host` to add more |
| `/api/score?url=` or `?path=` | reads the file *there* and returns the note streams |
| `/api/search?q=` | looks through the folder given to `--corpus`: your own MuseScore library |
| `/api/separate` (POST) | takes the singer out of the audio in the request body, via python-audio-separator — run on a GPU box over ssh when one answers, here otherwise |
| `/api/youtube-search?q=` | the ranked shortlist of likely soundtracks — metadata only, nothing is fetched |
| `/api/soundtrack?q=` | search, rank and download in one move; `&skip=N` is “that one was wrong, give me the next” |

The pre-processing is the interesting one. `js/musicxml.js`, `js/musescore.js`,
`js/zip.js` and `js/score.js` all run **unchanged** on the server: the only thing
they wanted from a browser was a way to turn text into a tree, which is now the
one seam in `js/dom.js`, and `server/minidom.mjs` fills it in about a hundred
lines — so this stays a project with no dependencies and no build step. Node
supplies `DecompressionStream` and `fetch` itself, so `.mxl` and `.mscz` need
nothing further.

For *Madamina* — Mozart, twelve staves, 3MB of MuseScore XML — that is the
difference between **580ms of parsing on the main thread and 7ms of building
lines**. The wire carries the parse, not the built score: the built form has note
objects shared between voices, lines and syllables, and JSON would quietly
duplicate each one three times.

The readers are checked against each other rather than trusted: the same six
files parsed in the browser and on the server produce byte-identical JSON,
across MusicXML and MuseScore, one voice and three, left-to-right and right-to-
left.

It does **not** scrape CPDL — see above.

`--allow-download` adds `/api/audio?url=`, `/api/youtube-search` and
`/api/soundtrack`, which shell out to **yt-dlp** to pull the audio from a video
so alignment can be tried against a real performance rather than a rendering of
the score — and start the PO-token daemon described above, because without it
most videos answer 403. It is off unless asked for, none of the helpers are
bundled or installed by it, and taking media off most video hosts is against
their terms — so it is a testing switch, on your own machine, and it is yours to
throw.

### The seams

`js/sources.js` is where a new source goes: `{ id, label, search(query) }`
returning entries that carry a URL, and optionally a `parsedUrl` for a server
that has already done the reading. `js/library.js` and `js/load.js` are the other
seams — `loadFromUrl()` takes any URL, `Library.loadManifest()` any manifest.
`window.karaoke` exposes the transport, synth, stage, library, store usage and
current score for driving the player from outside.

## Licence

GPL-3.0-or-later — see [`LICENSE`](LICENSE). The bundled demo scores in
`assets/` are generated by `tools/make-demos.mjs` from public-domain material.
