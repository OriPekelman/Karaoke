/**
 * Chord symbols, for whoever is holding the guitar.
 *
 * A score writes them as a root, a quality and sometimes a bass note, and there
 * are two ways to say the result out loud. Half the world writes **Am/E**, and
 * half writes **LAm/MI** — Romance-language countries name notes by solfège, so
 * a French or Italian or Spanish singer reads LA where an English one reads A.
 * Both are produced here and the view picks; there is no reason to make anyone
 * transpose alphabets while sight-reading.
 */

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LATIN = { C: 'DO', D: 'RE', E: 'MI', F: 'FA', G: 'SOL', A: 'LA', B: 'SI' };

/** MusicXML's kind vocabulary, as a player would write it above the stave. */
const KINDS = {
  'major': '', 'minor': 'm', 'augmented': '+', 'diminished': 'dim',
  'dominant': '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
  'diminished-seventh': 'dim7', 'augmented-seventh': '+7',
  'half-diminished': 'm7♭5', 'major-minor': 'mMaj7',
  'major-sixth': '6', 'minor-sixth': 'm6',
  'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9',
  'dominant-11th': '11', 'major-11th': 'maj11', 'minor-11th': 'm11',
  'dominant-13th': '13', 'major-13th': 'maj13', 'minor-13th': 'm13',
  'suspended-second': 'sus2', 'suspended-fourth': 'sus4',
  'power': '5', 'none': '', 'other': '',
};

const accidental = alter => (alter > 0 ? '♯'.repeat(alter) : alter < 0 ? '♭'.repeat(-alter) : '');

/**
 * One chord, spelled both ways. `suffix` is taken from the score when it wrote
 * one — engravers put the exact text they want there — and from the kind
 * vocabulary otherwise.
 */
export function chordText({ step, alter = 0, kind = 'major', kindText, bassStep, bassAlter = 0 }) {
  const suffix = (kindText ?? '').trim() || KINDS[kind] || '';
  const name = style => {
    const root = style === 'latin' ? LATIN[step] ?? step : step;
    const bass = bassStep ? `/${style === 'latin' ? LATIN[bassStep] ?? bassStep : bassStep}${accidental(bassAlter)}` : '';
    return `${root}${accidental(alter)}${suffix}${bass}`;
  };
  return { letters: name('letters'), latin: name('latin') };
}

/** Tonal pitch class → letter, the way MuseScore stores roots. */
export function stepFromTpc(tpc) {
  if (!isFinite(tpc)) return null;
  const step = ['F', 'C', 'G', 'D', 'A', 'E', 'B'][((tpc % 7) + 7) % 7];
  const alter = Math.floor((tpc - 6) / 7) - 1;
  return { step, alter };
}

export { LETTERS };
