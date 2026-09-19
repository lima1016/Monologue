/* 1분 말하기's numbers: which counts a round shows, how two rounds compare, and
   how one count is written. A leaf on purpose -- it imports nothing -- so the
   timed screen (timed.js) and the report (session.js) can both use it without
   one of them importing the other. */

/* The four counts a round shows, in the order they are read. `up`: more is
   better (you said more, and faster); otherwise fewer is (fewer long pauses,
   fewer places that needed fixing). */
export const METRICS = [
  { key: 'words', up: true },
  { key: 'wpm', up: true },
  { key: 'long_pauses', up: false },
  { key: 'fixed', up: false },
];

/* Japanese counts characters, not words (the server's count_words does the
   same), so the first count is named for what it counts. */
export function metricLabel(key, language) {
  if (key === 'words') return language === 'ja' ? '글자' : '단어';
  if (key === 'wpm') return '분당';
  if (key === 'long_pauses') return '긴 멈춤';
  return '고친 곳';
}

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/* One entry per metric: `after` is this round, `before` the first round (null
   when there is nothing to compare to -- the first round itself), `better`
   true only when it moved the good way. Equal is not better. */
export function compareRounds(first, current) {
  return METRICS.map(({ key, up }) => {
    const after = count(current && current[key]);
    const before = first ? count(first[key]) : null;
    const better = before !== null && (up ? after > before : after < before);
    return { key, before, after, better };
  });
}

/* `단어 87`, or against the first round `단어 87 → 112`. */
export function formatMetric(m, language) {
  const label = metricLabel(m.key, language);
  return m.before === null ? `${label} ${m.after}` : `${label} ${m.before} → ${m.after}`;
}

/* How many sentences of a graded round needed fixing: the server marks those
   ok false (a filler line or a correct one is not a fix). */
export function fixedCount(sentences) {
  return (sentences || []).filter((s) => s && (s.ok === false || s.ok === 0)).length;
}
