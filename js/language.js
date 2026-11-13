/**
 * Which language is this, roughly?
 *
 * Needed for one decision. A score numbers its lyric lines 1, 2, 3 and almost
 * never says what they are, but the number means two completely different
 * things: *another language for the same music* — Fauré's French over the
 * Tuscan original, a singable translation — which belongs on screen together,
 * and *the next stanza of a strophic song*, which does not, because you sing it
 * afterwards rather than at the same time.
 *
 * Nothing in the file distinguishes them. The text does: two stanzas of one poem
 * are in one language, a translation is not. So this is deliberately crude — a
 * script check, then a count of the little words that give a language away — and
 * it is only ever asked whether two lines are *the same* language, never trusted
 * to be right about which. When it cannot tell, the caller keeps the lines apart,
 * because stacking two verses of one poem is the worse mistake.
 */

const SCRIPTS = [
  [/[֐-׿]/, 'he', 'עברית'],
  [/[؀-ۿ]/, 'ar', 'العربية'],
  [/[Ѐ-ӿ]/, 'ru', 'Русский'],
  [/[Ͱ-Ͽ]/, 'el', 'Ελληνικά'],
  [/[぀-ヿ]/, 'ja', '日本語'],
  [/[가-힯]/, 'ko', '한국어'],
  [/[一-鿿]/, 'zh', '中文'],
];

// The commonest words, which is what a language leaks even in poetry.
const WORDS = {
  fr: { name: 'Français', words: 'le la les de des du un une et est que qui dans mon ma mes ton ta tes son sa ses pour ne pas plus je tu il elle nous vous au aux avec sur comme si tout toute me te se ce cette', marks: /[çœàâèêëîïôûùü]/ },
  de: { name: 'Deutsch', words: 'der die das den dem des und ist ich du er sie es wir ihr nicht ein eine einen mein dein sein mit von zu im in auf für so wie noch nur wenn dass da nach über aus bei war sind hat', marks: /[äöüß]/ },
  en: { name: 'English', words: 'the and of to a in is my thy that for with you your it he she we they but not all was are be as on at from by this his her when there love', marks: null },
  it: { name: 'Italiano', words: 'il lo la le i gli di del della che e non mi ti si ci un una per con da in su come se ma più sol mio mia tuo tua suo sua questo quel dove ogni tutto', marks: /[àìòù]/ },
  es: { name: 'Español', words: 'el la los las de del que y no me te se un una por con en su mi tu al como más para pero si te lo cuando donde todo tan ya', marks: /[ñ¡¿]/ },
  la: { name: 'Latina', words: 'et in qui quae quod cum non est sunt ad de per pro nos vos me te tu ego deus domine dominus sancta gloria pax rex nobis eius tuum omnes', marks: null },
  sv: { name: 'Svenska', words: 'och att en ett den det som är för med inte jag du han hon vi ni de på av till om så här där när men kan vill ska nu mig dig sig min din', marks: /[åäö]/ },
  nl: { name: 'Nederlands', words: 'de het een en van in is dat op te die met zich niet aan voor ik je hij zij wij maar ook nog als naar uit door over mijn jouw zijn haar', marks: /ij/ },
};

const SETS = Object.entries(WORDS).map(([code, spec]) => ({
  code, name: spec.name, marks: spec.marks, set: new Set(spec.words.split(/\s+/)),
}));

const tokens = text => text
  .toLowerCase()
  .replace(/[’']/g, '’')
  .split(/[^\p{L}’]+/u)
  .filter(Boolean)
  // A hyphenated syllable is not a word; join what the score split for singing.
  .flatMap(w => w.split('’'));

/**
 * A guess, or null when the evidence is thin. `confident` says whether the
 * winner was clear enough to name in the interface.
 */
export function detectLanguage(text) {
  if (!text || !text.trim()) return null;

  for (const [pattern, code, name] of SCRIPTS) {
    if (pattern.test(text)) return { code, name, confident: true };
  }

  const words = tokens(text);
  if (words.length < 4) return null;

  const scored = SETS.map(lang => {
    let hits = 0;
    for (const word of words) if (lang.set.has(word)) hits++;
    const marks = lang.marks && lang.marks.test(text) ? 2 : 0;
    return { code: lang.code, name: lang.name, score: hits / words.length * 100 + marks };
  }).sort((a, b) => b.score - a.score);

  const [best, next] = scored;
  if (best.score < 4) return null;                                  // no real evidence
  return { code: best.code, name: best.name, confident: best.score >= next.score * 1.4 };
}

/**
 * Are these two texts in different languages? Only "yes" when both were
 * identified and they disagree — everything else is a "no", which keeps the
 * caller from stacking two stanzas of one poem on top of each other.
 */
export function differentLanguages(a, b) {
  const first = detectLanguage(a);
  const second = detectLanguage(b);
  if (!first || !second) return false;
  return first.code !== second.code;
}
