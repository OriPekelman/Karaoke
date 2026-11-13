/**
 * Template for a four-language score — the shape a song like Donna Donna wants:
 * one melody, one verse per language, all sung syllable-for-note.
 *
 * Copy this file, replace the melody and the four verses, then:
 *
 *   node tools/make-score.mjs my-song.mjs
 *
 * Rules the validator will hold you to:
 *   · every measure sums to beats × 4 / beatType × divisions (a `pickup: true`
 *     measure is exempt)
 *   · every track has exactly one syllable entry per *pitched* note, in order —
 *     use '' for a note the previous syllable is held across (a melisma)
 *
 * Hyphenation: 'dis|begin', 'cour|middle', 'teous|middle', 'ly|end' renders as
 * dis‑cour‑teous‑ly with the dot walking across the word. A bare 'word' is a
 * whole word. Right-to-left scripts need nothing special — the player detects
 * them and mirrors the dot.
 *
 * As shipped this is a plain rising-and-falling phrase, so it runs unmodified
 * and you can see the format working before you replace anything.
 */

export default {
  title: 'Untitled',
  composer: '',
  rights: '',

  divisions: 4,      // ticks per quarter note: 4 → quarter=4, eighth=2, dotted quarter=6
  fifths: 0,         // key signature: +1 = G major/E minor, -2 = B♭ major, …
  beats: 4,
  beatType: 4,
  tempo: 96,         // quarter notes per minute

  // Order matters: track 1 is the one selected first. L cycles them in the app.
  tracks: [
    { label: 'ייִדיש',   syllables: ['איין', 'ליד', 'גייט', 'אַ|begin', 'רויס|end', 'אין', 'דער', 'וועלט'] },
    { label: 'עברית',   syllables: ['שיר', 'א|begin', 'חד|end', 'יו|begin', 'צא|end', 'ל|begin', 'עו|middle', 'לם|end'] },
    { label: 'English', syllables: ['One', 'song', 'goes', 'out', 'in|begin', 'to|end', 'the', 'world'] },
    { label: 'Français', syllables: ['Un', 'chant', 's’en', 'va', 'par', 'le', 'va|begin', 'ste|end'] },
  ],

  measures: [
    { notes: ['C4/4', 'D4/4', 'E4/4', 'G4/4'] },
    { notes: ['A4/4', 'G4/4', 'E4/4', 'C4/4'] },
  ],
};
