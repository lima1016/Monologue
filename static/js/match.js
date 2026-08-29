/* Did the learner actually say the corrected sentence?

   Browser speech recognition returns no punctuation and arbitrary casing, so
   requiring an exact match against `fixed` would fail even when the learner
   said it perfectly. Normalise both sides, then allow a small edit distance:
   the point is to confirm they produced the sentence, not to grade dictation.

   No imports: this file is pure so `node --test` can run it without a DOM. */

const PUNCT = /[.,!?;:'"()\[\]{}\-–—…·、。！？「」『』（）]/g;

/* Punctuation is dropped, not replaced with a space: Japanese has no word
   spaces, so turning `、` into a space would invent a token boundary that was
   never there, and in English it also keeps contractions like "don't" as one
   word instead of splitting them into "don" and "t". */
export function normalize(text) {
  return (text || '').toLowerCase().replace(PUNCT, '').replace(/\s+/g, ' ').trim();
}

/* Tokens are words in English and characters in Japanese, which is not written
   with spaces between words. */
function tokenize(text, language) {
  const cleaned = normalize(text);
  if (!cleaned) return [];
  return language === 'ja' ? [...cleaned.replace(/\s/g, '')] : cleaned.split(' ');
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export function similarity(spoken, target, language) {
  const a = tokenize(spoken, language);
  const b = tokenize(target, language);
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

export const PASS_THRESHOLD = 0.9;

export function matches(spoken, target, language) {
  return similarity(spoken, target, language) >= PASS_THRESHOLD;
}
