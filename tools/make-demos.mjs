/**
 * Writes the bundled demo scores in assets/.
 *
 * The transcriptions live here in a compact form so they stay readable and
 * editable; the MusicXML they emit is what the app actually loads.
 *
 *   node tools/make-demos.mjs
 *
 * See tools/musicxml-writer.mjs for the note and syllable syntax, and
 * tools/make-score.mjs if you want to build a score of your own.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMusicXML, validate, words } from './musicxml-writer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────────────
// Amazing Grace — melody "New Britain" (traditional), words John Newton, 1779.
// ─────────────────────────────────────────────────────────────────────
const amazingGrace = {
  title: 'Amazing Grace',
  composer: 'traditional · words John Newton (1779)',
  rights: 'Public domain',
  divisions: 4, fifths: 1, beats: 3, beatType: 4, tempo: 82,
  tracks: [{
    label: 'English',
    // '' marks a note the previous syllable is held across — a melisma.
    syllables: [
      'A|begin', 'ma|middle', 'zing|end', 'grace!',
      'how', 'sweet', 'the', 'sound', '', '',
      'that', 'saved', 'a', 'wretch', 'like', 'me!', '',
      'I', 'once', 'was', 'lost,', 'but', 'now', 'am', 'found,', '', '',
      'Was', 'blind,', 'but', 'now', 'I', 'see.', '',
    ],
  }],
  measures: [
    { pickup: true, notes: ['D4/4'] },
    { notes: ['G4/6', 'B4/2', 'G4/4'] },
    { notes: ['B4/8', 'A4/4'] },
    { notes: ['G4/6', 'E4/2', 'D4/4'] },
    { notes: ['D4/8', 'D4/4'] },
    { notes: ['G4/6', 'B4/2', 'G4/4'] },
    { notes: ['B4/8', 'A4/4'] },
    { notes: ['G4/8', 'D5/4'] },
    { notes: ['D5/6', 'B4/2', 'D5/4'] },
    { notes: ['B4/8', 'A4/4'] },
    { notes: ['G4/6', 'E4/2', 'D4/4'] },
    { notes: ['D4/8', 'D4/4'] },
    { notes: ['G4/6', 'B4/2', 'G4/4'] },
    { notes: ['B4/8', 'A4/4'] },
    { notes: ['G4/12'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// Greensleeves — traditional, 16th century. Two D sharps against a one-sharp
// key signature, which is exactly what the colour coding is for.
// ─────────────────────────────────────────────────────────────────────
const greensleeves = {
  title: 'Greensleeves',
  composer: 'traditional (16th century)',
  rights: 'Public domain',
  divisions: 4, fifths: 1, beats: 6, beatType: 8, tempo: 78,
  tracks: [{
    label: 'English',
    syllables: [
      'A|begin', 'las,|end', 'my', 'love,', 'you',
      'do', 'me', 'wrong,',
      'to', 'cast', 'me', 'off',
      'dis|begin', 'cour|middle', 'teous|middle', 'ly,|end',
      'And', 'I', 'have', 'loved', 'you',
      'so', 'long,', 'de|begin',
      'light|middle', 'ing|end', 'in', 'your',
      'com|begin', 'pa|middle', 'ny.|end', '',
    ],
  }],
  measures: [
    { pickup: true, notes: ['E4/2'] },
    { notes: ['G4/4', 'A4/2', 'B4/4', 'C5/2'] },
    { notes: ['B4/6', 'A4/4', 'F#4/2'] },
    { notes: ['D4/4', 'E4/2', 'F#4/4', 'G4/2'] },
    { notes: ['F#4/6', 'E4/4', 'D#4/2'] },
    { notes: ['E4/6', 'r/4', 'E4/2'] },
    { notes: ['G4/4', 'A4/2', 'B4/4', 'C5/2'] },
    { notes: ['B4/6', 'A4/4', 'F#4/2'] },
    { notes: ['D4/4', 'E4/2', 'F#4/4', 'G4/2'] },
    { notes: ['F#4/6', 'E4/4', 'D#4/2'] },
    { notes: ['E4/12'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// A warm-up that is nothing but altered notes: every raised step on the way
// up, every lowered one on the way down.
// ─────────────────────────────────────────────────────────────────────
const solfege = {
  title: 'Chromatic Solfège Ladder',
  composer: 'a vocal warm-up',
  rights: 'Public domain',
  divisions: 4, fifths: 0, beats: 4, beatType: 4, tempo: 88,
  tracks: [{
    label: 'Solfège',
    syllables: words(`do di re ri mi fa fi sol si la li ti do
                      ti te la le sol se fa mi me re ra do`),
  }],
  measures: [
    { notes: ['C4/4', 'C#4/4', 'D4/4', 'D#4/4'] },
    { notes: ['E4/4', 'F4/4', 'F#4/4', 'G4/4'] },
    { notes: ['G#4/4', 'A4/4', 'A#4/4', 'B4/4'] },
    { notes: ['C5/16'] },
    { notes: ['B4/4', 'Bb4/4', 'A4/4', 'Ab4/4'] },
    { notes: ['G4/4', 'Gb4/4', 'F4/4', 'E4/4'] },
    { notes: ['Eb4/4', 'D4/4', 'Db4/4', 'r/4'] },
    { notes: ['C4/16'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// Five languages over one melody, to exercise the multi-track lyric path
// (including right-to-left scripts). Beethoven's tune and Schiller's German
// are public domain; the four singable translations are written for this demo.
// ─────────────────────────────────────────────────────────────────────
const multilingual = {
  title: 'Ode to Joy',
  composer: 'Beethoven (1824) · words Friedrich Schiller',
  rights: 'Public domain; translations written for this demo',
  divisions: 4, fifths: 0, beats: 4, beatType: 4, tempo: 104,
  tracks: [
    {
      label: 'Deutsch',
      syllables: [
        'Freu|begin', 'de,|end', 'schö|begin', 'ner|end', 'Göt|begin', 'ter|middle', 'fun|middle', 'ken,|end',
        'Toch|begin', 'ter|end', 'aus', 'E|begin', 'ly|middle', 'si|middle', 'um,|end',
        'Wir', 'be|begin', 'tre|middle', 'ten|end', 'feu|begin', 'er|middle', 'trun|middle', 'ken,|end',
        'Himm|begin', 'li|middle', 'sche,|end', 'dein', 'Hei|begin', 'lig|middle', 'tum!|end',
      ],
    },
    {
      label: 'English',
      syllables: [
        'Joy,', 'thou', 'spark', 'of', 'light', 'e|begin', 'ter|middle', 'nal,|end',
        'Daugh|begin', 'ter|end', 'of', 'E|begin', 'ly|middle', 'si|middle', 'um,|end',
        'Fi|begin', 're|middle', 'drunk|end', 'we', 'come', 'be|begin', 'fore|end', 'thee,',
        'Heav|begin', 'en|middle', 'ly,|end', 'thy', 'ho|begin', 'ly|end', 'home!',
      ],
    },
    {
      label: 'Français',
      syllables: [
        'Joie,', 'di|begin', 'vi|middle', 'ne|end', 'é|begin', 'tin|middle', 'cel|middle', 'le,|end',
        'Fil|begin', 'le|end', 'de', 'l’É|begin', 'ly|middle', 'si|middle', 'um,|end',
        'Nous', 'en|begin', 'trons,|end', 'i|begin', 'vres|end', 'de', 'flam|begin', 'me,|end',
        'En', 'ton', 'sanc|begin', 'tu|middle', 'ai|middle', 're|end', 'saint!',
      ],
    },
    {
      label: 'עברית',
      syllables: [
        'שמ|begin', 'חה,|end', 'ני|begin', 'צוץ|end', 'של', 'א|begin', 'לו|middle', 'הים,|end',
        'בת', 'א|begin', 'לים|end', 'מן', 'ה|begin', 'מ|middle', 'רום,|end',
        'בו|begin', 'ע|middle', 'רים|end', 'נ|begin', 'בוא|end', 'א|begin', 'ל|middle', 'יך,|end',
        'אל', 'מק|begin', 'ד|middle', 'שך|end', 'ה|begin', 'ק|middle', 'דוש!|end',
      ],
    },
    {
      label: 'ייִדיש',
      syllables: [
        'פֿרייד,', 'דו', 'שיי|begin', 'נער|end', 'גע|begin', 'טער|middle', 'פֿונ|middle', 'קען,|end',
        'טאָכ|begin', 'טער|end', 'פֿון', 'ע|begin', 'לי|middle', 'סי|middle', 'ום,|end',
        'פֿײַ|begin', 'ער|middle', 'טרונ|middle', 'קען|end', 'קו|begin', 'מען|end', 'מיר', 'אָן,',
        'הימ|begin', 'לי|middle', 'שע,|end', 'אין', 'דײַן', 'הי|begin', 'כל!|end',
      ],
    },
  ],
  measures: [
    { notes: ['E4/4', 'E4/4', 'F4/4', 'G4/4'] },
    { notes: ['G4/4', 'F4/4', 'E4/4', 'D4/4'] },
    { notes: ['C4/4', 'C4/4', 'D4/4', 'E4/4'] },
    { notes: ['E4/6', 'D4/2', 'D4/8'] },
    { notes: ['E4/4', 'E4/4', 'F4/4', 'G4/4'] },
    { notes: ['G4/4', 'F4/4', 'E4/4', 'D4/4'] },
    { notes: ['C4/4', 'C4/4', 'D4/4', 'E4/4'] },
    { notes: ['D4/6', 'C4/2', 'C4/8'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// Au clair de la lune — French traditional, 18th century. One language only,
// which is the common case: the layout gives a single track the whole stage.
// The third phrase leaps up a fifth, so the dot has somewhere to go.
// ─────────────────────────────────────────────────────────────────────
const auClairDeLaLune = {
  title: 'Au clair de la lune',
  composer: 'traditionnel (XVIIIᵉ siècle)',
  rights: 'Public domain',
  divisions: 4, fifths: 0, beats: 4, beatType: 4, tempo: 96,
  tracks: [{
    label: 'Français',
    syllables: [
      'Au', 'clair', 'de', 'la', 'lu|begin', 'ne,|end', 'mon', 'a|begin', 'mi|end', 'Pier|begin', 'rot,|end',
      'Prê|begin', 'te|end', 'moi', 'ta', 'plu|begin', 'me|end', 'pour', 'é|begin', 'crire|end', 'un', 'mot.',
      'Ma', 'chan|begin', 'delle|end', 'est', 'mor|begin', 'te,|end', 'je', 'n’ai', 'plus', 'de', 'feu,',
      'Ou|begin', 'vre|end', 'moi', 'ta', 'por|begin', 'te,|end', 'pour', 'l’a|begin', 'mour|end', 'de', 'Dieu.',
    ],
  }],
  measures: [
    { notes: ['C4/4', 'C4/4', 'C4/4', 'D4/4'] },
    { notes: ['E4/8', 'D4/8'] },
    { notes: ['C4/4', 'E4/4', 'D4/4', 'D4/4'] },
    { notes: ['C4/16'] },
    { notes: ['C4/4', 'C4/4', 'C4/4', 'D4/4'] },
    { notes: ['E4/8', 'D4/8'] },
    { notes: ['C4/4', 'E4/4', 'D4/4', 'D4/4'] },
    { notes: ['C4/16'] },
    { notes: ['D4/4', 'D4/4', 'D4/4', 'D4/4'] },
    { notes: ['A4/8', 'A4/8'] },
    { notes: ['D4/4', 'C4/4', 'B3/4', 'A3/4'] },
    { notes: ['G3/16'] },
    { notes: ['C4/4', 'C4/4', 'C4/4', 'D4/4'] },
    { notes: ['E4/8', 'D4/8'] },
    { notes: ['C4/4', 'E4/4', 'D4/4', 'D4/4'] },
    { notes: ['C4/16'] },
  ],
};

// ─────────────────────────────────────────────────────────────────────
// Frère Jacques as a round: one tune, three singers, entering two bars apart.
// Same words in every voice and never in the same place — which is the whole
// point of a round, and the clearest test of voices that keep their own clock.
// Three languages on top of that, so both axes are exercised at once.
// ─────────────────────────────────────────────────────────────────────
const roundTune = [
  { notes: ['C4/4', 'D4/4', 'E4/4', 'C4/4'] },
  { notes: ['C4/4', 'D4/4', 'E4/4', 'C4/4'] },
  { notes: ['E4/4', 'F4/4', 'G4/8'] },
  { notes: ['E4/4', 'F4/4', 'G4/8'] },
  { notes: ['G4/2', 'A4/2', 'G4/2', 'F4/2', 'E4/4', 'C4/4'] },
  { notes: ['G4/2', 'A4/2', 'G4/2', 'F4/2', 'E4/4', 'C4/4'] },
  { notes: ['C4/4', 'G3/4', 'C4/8'] },
  { notes: ['C4/4', 'G3/4', 'C4/8'] },
];
const bar = { notes: ['r/16'] };
const roundVoice = (restsBefore, restsAfter) => [
  ...Array(restsBefore).fill(bar), ...roundTune, ...Array(restsAfter).fill(bar),
];

const frereJacques = {
  title: 'Frère Jacques',
  composer: 'traditionnel · à trois voix',
  rights: 'Public domain',
  divisions: 4, fifths: 0, beats: 4, beatType: 4, tempo: 96,
  tracks: [
    {
      label: 'Français',
      syllables: [
        'Frè|begin', 're|end', 'Jac|begin', 'ques,|end',
        'Frè|begin', 're|end', 'Jac|begin', 'ques,|end',
        'Dor|begin', 'mez|end', 'vous?',
        'Dor|begin', 'mez|end', 'vous?',
        'Son|begin', 'nez|end', 'les', 'ma|begin', 'ti|middle', 'nes,|end',
        'Son|begin', 'nez|end', 'les', 'ma|begin', 'ti|middle', 'nes,|end',
        'Ding', 'ding', 'dong,', 'Ding', 'ding', 'dong.',
      ],
    },
    {
      label: 'English',
      syllables: [
        'Are', 'you', 'sleep|begin', 'ing,|end',
        'Are', 'you', 'sleep|begin', 'ing,|end',
        'Bro|begin', 'ther|end', 'John?',
        'Bro|begin', 'ther|end', 'John?',
        'Mor|begin', 'ning|end', 'bells', 'are', 'ring|begin', 'ing,|end',
        'Mor|begin', 'ning|end', 'bells', 'are', 'ring|begin', 'ing,|end',
        'Ding', 'ding', 'dong,', 'Ding', 'ding', 'dong.',
      ],
    },
    {
      label: 'Deutsch',
      syllables: [
        'Bru|begin', 'der|end', 'Ja|begin', 'kob,|end',
        'Bru|begin', 'der|end', 'Ja|begin', 'kob,|end',
        'schläfst', 'du', 'noch?',
        'schläfst', 'du', 'noch?',
        'Hörst', 'du', 'nicht', 'die', 'Glo|begin', 'cken,|end',
        'Hörst', 'du', 'nicht', 'die', 'Glo|begin', 'cken,|end',
        'Ding', 'dang', 'dong,', 'Ding', 'dang', 'dong.',
      ],
    },
  ],
  parts: [
    { name: 'Voix I', measures: roundVoice(0, 4) },
    { name: 'Voix II', measures: roundVoice(2, 2) },
    { name: 'Voix III', measures: roundVoice(4, 0) },
  ],
};

const files = {
  'ode-to-joy-multilingual.musicxml': multilingual,
  'au-clair-de-la-lune.musicxml': auClairDeLaLune,
  'amazing-grace.musicxml': amazingGrace,
  'greensleeves.musicxml': greensleeves,
  'frere-jacques-round.musicxml': frereJacques,
  'solfege-ladder.musicxml': solfege,
};

mkdirSync(join(ROOT, 'assets'), { recursive: true });
for (const [name, spec] of Object.entries(files)) {
  const pitched = validate(spec, name);
  const voices = (spec.parts ?? [1]).length;
  writeFileSync(join(ROOT, 'assets', name), buildMusicXML(spec));
  console.log(`${name}  ${pitched} notes × ${spec.tracks.length} track(s)${voices > 1 ? ` × ${voices} voices` : ''}`);
}
