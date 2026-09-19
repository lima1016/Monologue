import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

let mypage;
let instance = 0;
beforeEach(async () => {
  resetDom();
  ['home', 'pick', 'session', 'report', 'mypage'].forEach((s) => router.register(s, s));
  state.language = 'en';
  mypage = await import(`./mypage.js?instance=${++instance}`);
  delete globalThis.localStorage;
});
afterEach(() => { delete globalThis.localStorage; });

const STATS = (over = {}) => ({
  level: { value: null, sessions: 2, utterances: 9, need_sessions: 3, need_utterances: 15 },
  accuracy: { correct: 18, graded: 25 },
  tags: [{ tag: '시제', n: 6, examples: [
    { text: 'I go there yesterday', fixed: 'I went there yesterday.', correction: '지난 일은 과거형으로 말해야 합니다. 이 문장에서는 go가 went가 됩니다.' },
    { text: 'I meet him last week', fixed: 'I met him last week.', correction: '과거형' }] },
  { tag: '관사', n: 3, examples: [] }],
  review: { due: 2, mastered: 1 }, ...over,
});
const ITEMS = [
  { id: 11, text: 'I go there', fixed: 'I went there.', correction: '과거형', tag: '시제', created_at: 'x' },
  { id: 12, text: 'She have', fixed: 'She has.', correction: '수 일치', tag: '단복수', created_at: 'y' },
];
const COACH = {
  status: 'ready', day: '2026-09-19', count: 12, items: [
    { habit: '여러 말을 끊지 않고 이어 말해요', tip: '한 문장 말하고 숨을 한 번 쉬어요', said: 'Yes water please And', fixed: 'Yes, water please.', tag: '어순' },
    { habit: '장소 앞 전치사를 빠뜨려요', tip: '"by the"를 먼저 붙여요', said: 'sit the window', fixed: 'sit by the window.', tag: '어순' },
  ] };
const HISTORY = (n, more = false) => ({ items: Array.from({ length: n }, (_, i) => ({
  id: 100 + i, ended_at: '2026-09-13T05:00:00+00:00', title: `상황 ${i}`, mode: i === 0 ? 'script' : 'free', turns: 8, wrong: 2 })), more });

function routes(extra = {}) {
  const seen = { results: [], audio: [], history: [], reports: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/stats/mypage')) return extra.stats ? extra.stats(url) : jsonResponse(STATS());
    if (url.startsWith('/api/review?')) return extra.review ? extra.review(url) : jsonResponse({ items: extra.items ?? ITEMS });
    if (/\/api\/review\/\d+\/result/.test(url)) {
      const body = JSON.parse(options.body);
      seen.results.push([Number(url.split('/')[3]), body.result]);
      return extra.result ? extra.result(body) : jsonResponse({ id: 11, passes: 1, interval_d: 3, due_date: '2026-09-17', mastered: false });
    }
    if (/\/api\/review\/\d+\/audio/.test(url)) { seen.audio.push(url); return jsonResponse({ audio_key: 'k1' }); }
    if (url.startsWith('/api/sessions/history')) { seen.history.push(url); return extra.historyResponse ? extra.historyResponse(url) : jsonResponse(extra.history ? extra.history(url) : HISTORY(3)); }
    if (/\/api\/sessions\/\d+\/report/.test(url)) { seen.reports.push(url); if (extra.report) return extra.report(url); }
    if (/\/api\/sessions\/\d+\/report/.test(url)) return jsonResponse({ summary: '좋았어요', weak_points: [], expressions: [], next_focus: '', level: 'beginner', mode: 'free', stats: { turns: 3, wrong: 1, minutes: 4, sentences: [] } });
    if (/\/api\/sessions\/\d+$/.test(url)) return jsonResponse({ session: {}, messages: [
      { speaker: 'bot', text: 'Hi.' }, { speaker: 'user', text: 'I go', ok: 0, fixed: 'I went.' }] });
    if (url.startsWith('/api/stats/home')) return jsonResponse({ top_tags: [] });
    if (url.startsWith('/api/mypage/coach')) { seen.coach = (seen.coach || 0) + 1; return extra.coach ? extra.coach(url) : jsonResponse(COACH); }
    return jsonResponse({});
  });
  return seen;
}

test('opening my page shows loading then all four sections', async () => {
  routes();
  const opening = mypage.openMypage();
  assert.equal(router.current(), 'mypage');
  assert.match(text($('level-body')), /불러오는 중\.\.\./);
  await opening;
  assert.match(text($('level-body')), /레벨 판정까지 세션 2\/3 · 발화 9\/15/);
  assert.equal($('review-count').textContent, '오늘의 복습 2개');
  assert.equal($('review-mastered').textContent, '익힌 문장 1개');
  assert.equal($('accuracy-line').textContent, '문장 정확도 72% · 최근 30일 채점된 25문장');
  assert.equal($('history-list').children.length, 3);
});

test('a level is shown once the sample is big enough', async () => {
  routes({ stats: () => jsonResponse(STATS({ level: { value: 'intermediate', sessions: 5, utterances: 40, need_sessions: 3, need_utterances: 15 } })) });
  await mypage.openMypage();
  assert.match(text($('level-body')), /레벨 중급/);
  assert.match(text($('level-body')), /· 최근 세션 판정/);
});

test('listening prepares audio with visible copy, then plays', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const play = findByClass(card, 'play');
  const playing = mypage.playReview(ITEMS[0], play);
  assert.equal(play.textContent, '음성 준비 중...');
  await playing;
  assert.equal(play.textContent, '▶ 듣기');
  assert.equal(seen.audio.length, 1);
});

test('a passed review saves, says when it comes back, and leaves the list', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (target, resultEl, btn, onResult) => onResult(true, 'I went there'));
  assert.deepEqual(seen.results, [[11, 'pass']]);
  assert.match(findByClass(card, 'review-result').textContent, /좋아요! 3일 뒤에 다시 볼게요/);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal($('review-list').children.length, 1);
  assert.equal($('review-count').textContent, '오늘의 복습 1개');
});

test('the third pass says it is mastered', async () => {
  routes({ result: () => jsonResponse({ id: 11, passes: 3, interval_d: 14, due_date: 'z', mastered: true }) });
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(true, 'x'));
  assert.match(findByClass(card, 'review-result').textContent, /익혔어요 🎉/);
});

test('a failed review saves fail and keeps the card; hearing nothing saves nothing', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(false, 'I go'));
  assert.deepEqual(seen.results, [[11, 'fail']]);
  assert.match(findByClass(card, 'review-result').textContent, /조금 달라요\. 내일 다시 볼게요/);
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(null, null));
  assert.equal(seen.results.length, 1);
  assert.match(findByClass(card, 'review-result').textContent, /못 알아들었어요/);
  assert.equal($('review-list').children.length, 2);
});

test('a review result that cannot be saved says so', async () => {
  routes({ result: () => jsonResponse({ detail: 'down' }, { ok: false, status: 500 }) });
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(true, 'x'));
  assert.equal($('notice-text').textContent, '복습 결과를 저장하지 못했어요');
  assert.equal($('review-list').children.length, 2);
});

test('다음에 skips, and an empty list explains itself', async () => {
  const seen = routes({ items: [ITEMS[0]], stats: () => jsonResponse(STATS({ review: { due: 1, mastered: 1, total: 2 } })) });
  await mypage.openMypage();
  await mypage.skipReview(ITEMS[0], $('review-list').children[0]);
  assert.deepEqual(seen.results, [[11, 'skip']]);
  assert.match(text($('review-list')), /오늘 복습할 문장이 없어요/);
});

test('an empty list with nothing ever corrected says where sentences come from', async () => {
  routes({ items: [], stats: () => jsonResponse(STATS({ review: { due: 0, mastered: 0, total: 0 } })) });
  await mypage.openMypage();
  assert.match(text($('review-list')), /오늘 복습할 문장이 없어요/);
  assert.match(text($('review-list')), /대화에서 고친 문장이 여기 모여요/);
  assert.equal($('review-mastered').textContent, '');
});

test('an empty list after corrections were queued does not say where sentences come from', async () => {
  // Queued before and not due today: nothing mastered, nothing due, but not new.
  routes({ items: [], stats: () => jsonResponse(STATS({ review: { due: 0, mastered: 0, total: 3 } })) });
  await mypage.openMypage();
  assert.match(text($('review-list')), /오늘 복습할 문장이 없어요/);
  assert.doesNotMatch(text($('review-list')), /대화에서 고친 문장이 여기 모여요/);
});

test('the heading counts every due sentence, not the twenty on the list', async () => {
  const seen = routes({ items: [ITEMS[0]], stats: () => jsonResponse(STATS({ review: { due: 25, mastered: 0, total: 25 } })) });
  await mypage.openMypage();
  assert.equal($('review-count').textContent, '오늘의 복습 25개');
  await mypage.skipReview(ITEMS[0], $('review-list').children[0]);
  assert.deepEqual(seen.results, [[11, 'skip']]);
  assert.equal($('review-count').textContent, '오늘의 복습 24개');
  // The list ran out before the day's reviews did.
  assert.doesNotMatch(text($('review-list')), /오늘 복습할 문장이 없어요/);
  assert.match(text($('review-list')), /남은 문장 24개는 다시 열면 나와요/);
});

const MANY = (n) => Array.from({ length: n }, (_, i) => ({
  id: 200 + i, text: `said ${i}`, fixed: `fixed ${i}.`, correction: '', tag: '시제', created_at: 'x' }));
const reviewCards = () => Array.from($('review-list').children).filter((c) => c.classList.contains('review-card'));
/* A browser's children is a live HTMLCollection -- indexable and iterable, but
   no filter/map. dom-shim hands back an Array, so the 더 보기 tests put the
   real shape on #review-list and code that treats it as an Array goes red. */
function liveChildren(node) {
  Object.defineProperty(node, 'children', { configurable: true, get() {
    const kids = this.childNodes.filter((n) => typeof n === 'object' && n && 'tagName' in n);
    const coll = { length: kids.length, [Symbol.iterator]: () => kids[Symbol.iterator](),
      item: (i) => kids[i] ?? null };
    kids.forEach((k, i) => { coll[i] = k; });
    return coll;
  } });
}
const shownCards = () => reviewCards().filter((c) => !c.hidden);
const moreShown = () => !$('btn-review-more').classList.contains('is-invisible');

test('복습 shows five at a time; 더 보기 brings the next five and hides when none are left', async () => {
  routes({ items: MANY(12), stats: () => jsonResponse(STATS({ review: { due: 12, mastered: 0, total: 12 } })) });
  liveChildren($('review-list'));
  await mypage.openMypage();
  assert.equal(reviewCards().length, 12);
  assert.equal(shownCards().length, 5);
  assert.deepEqual(shownCards(), reviewCards().slice(0, 5));
  assert.ok(moreShown());
  assert.equal($('btn-review-more').textContent, '더 보기 (7개 남음)');
  assert.equal($('review-count').textContent, '오늘의 복습 12개');
  mypage.showMoreReviews();
  assert.equal(shownCards().length, 10);
  assert.equal($('btn-review-more').textContent, '더 보기 (2개 남음)');
  assert.ok(reviewCards()[5].classList.contains('is-revealed'), 'a revealed card did not fade in');
  mypage.showMoreReviews();
  assert.equal(shownCards().length, 12);
  // The fade-in class is spent by the next paint.
  assert.equal(reviewCards()[5].classList.contains('is-revealed'), false);
  assert.ok(reviewCards()[10].classList.contains('is-revealed'));
  assert.equal(moreShown(), false);
  assert.equal($('btn-review-more').getAttribute('aria-hidden'), 'true');
});

test('three reviews are all shown, with no 더 보기', async () => {
  routes({ items: MANY(3) });
  liveChildren($('review-list'));
  await mypage.openMypage();
  assert.equal(shownCards().length, 3);
  assert.equal(moreShown(), false);
});

test('a card that leaves makes room for the next hidden one; the counts still mean all left', async () => {
  const items = MANY(7);
  routes({ items, stats: () => jsonResponse(STATS({ review: { due: 7, mastered: 0, total: 7 } })) });
  liveChildren($('review-list'));
  await mypage.openMypage();
  const sixth = reviewCards()[5];
  assert.equal(sixth.hidden, true);
  await mypage.skipReview(items[0], reviewCards()[0]);
  assert.equal(shownCards().length, 5);
  assert.equal(sixth.hidden, false, 'the next card did not come out');
  assert.equal($('btn-review-more').textContent, '더 보기 (1개 남음)');
  assert.equal($('review-count').textContent, '오늘의 복습 6개');
  assert.equal($('tab-review-n').textContent, '6');
  await mypage.skipReview(items[1], reviewCards()[0]);
  assert.equal(shownCards().length, 5);
  assert.equal(moreShown(), false);
});

test('opening my page again starts back at five', async () => {
  routes({ items: MANY(12) });
  liveChildren($('review-list'));
  await mypage.openMypage();
  mypage.showMoreReviews();
  assert.equal(shownCards().length, 10);
  await mypage.openMypage();
  assert.equal(shownCards().length, 5);
  assert.equal($('btn-review-more').textContent, '더 보기 (7개 남음)');
  // And a reload that finds nothing due takes 더 보기 away with the cards.
  routes({ items: [], stats: () => jsonResponse(STATS({ review: { due: 0, mastered: 0, total: 12 } })) });
  await mypage.openMypage();
  assert.match(text($('review-list')), /오늘 복습할 문장이 없어요/);
  assert.equal(moreShown(), false);
});

test('after 더 보기 the keyboard lands on the first card it brought out, on its 듣기', async () => {
  // With a correction, as real cards have: ▸ 설명 comes first, and is not it.
  routes({ items: MANY(12).map((it) => ({ ...it, correction: '과거형' })) });
  liveChildren($('review-list'));
  await mypage.openMypage();
  mypage.showMoreReviews();
  const sixth = reviewCards()[5];
  assert.ok(findByClass(sixth, 'explain'), 'the card has no ▸ 설명 to skip');
  assert.equal(document.activeElement, findByClass(sixth, 'play'));
});

test('while loading or failed, 복습 has no 더 보기', async () => {
  routes({ items: MANY(12) });
  liveChildren($('review-list'));
  const opening = mypage.openMypage();
  assert.equal(moreShown(), false, 'shown over the skeleton');
  await opening;
  assert.ok(moreShown());
  // Loaded before, so this reload dims instead of painting skeletons.
  routes({ review: () => jsonResponse({}, { ok: false, status: 500 }) });
  await mypage.openMypage();
  assert.match(text($('review-list')), /불러오지 못했어요/);
  assert.equal(moreShown(), false, 'shown under a failed list');
});

test('a review that is gone (404) leaves the list instead of waking again', async () => {
  const seen = routes({ result: () => jsonResponse({ detail: 'no such review' }, { ok: false, status: 404 }) });
  await mypage.openMypage();
  const [first, second] = $('review-list').children;
  await mypage.speakReview(ITEMS[0], first, (t, r, b, onResult) => { onResult(true, 'x'); return true; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal($('review-list').children.includes(first), false, 'a 404 card stayed on the list');
  assert.notEqual($('notice-text').textContent, '복습 결과를 저장하지 못했어요');
  await mypage.skipReview(ITEMS[1], second);
  assert.equal($('review-list').children.includes(second), false);
  assert.equal(seen.results.length, 2);
  assert.equal($('review-count').textContent, '오늘의 복습 0개');
});

test('a result that lands after a reload does not count twice in the new load', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  routes({ result: async () => { await held; return jsonResponse({ id: 11, passes: 3, interval_d: 7, due_date: 'z', mastered: true }); } });
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const speaking = mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => { onResult(true, 'x'); return true; });
  // The reload's answer already counts the pass.
  routes({ items: [ITEMS[1]], stats: () => jsonResponse(STATS({ review: { due: 1, mastered: 2, total: 3 } })),
           result: async () => { await held; return jsonResponse({ id: 11, passes: 3, interval_d: 7, due_date: 'z', mastered: true }); } });
  await mypage.openMypage();
  assert.equal($('review-mastered').textContent, '익힌 문장 2개');
  release();
  await speaking;
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal($('review-mastered').textContent, '익힌 문장 2개', 'the old pass counted again');
  assert.equal($('review-count').textContent, '오늘의 복습 1개', 'the old card counted down the new list');
  assert.equal($('review-list').children.length, 1);
});

test('a report that answers after the learner left my page is not shown', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const report = { summary: 's', weak_points: [], expressions: [], next_focus: '', mode: 'free', stats: { turns: 1, wrong: 0 } };
  const seen = routes({ report: async () => { await held; return jsonResponse(report); } });
  await mypage.openMypage();
  const opening = mypage.openReport(100);
  // A second press while the first is out asks nothing more.
  const again = mypage.openReport(100);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.reports.length, 1);
  router.show('home');
  release();
  await Promise.all([opening, again]);
  assert.equal(router.current(), 'home', 'the report pulled the learner back');
  assert.equal($('report-headline').textContent, '', 'the report was drawn anyway');
});

test('a report that answers after my page was loaded again is not shown', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const report = { summary: 's', weak_points: [], expressions: [], next_focus: '', mode: 'free', stats: { turns: 1, wrong: 0 } };
  routes({ report: async () => { await held; return jsonResponse(report); } });
  await mypage.openMypage();
  const opening = mypage.openReport(100);
  await mypage.openMypage();
  release();
  await opening;
  assert.equal(router.current(), 'mypage');
  // ...and a new press is free to ask again.
  await mypage.openReport(100);
  assert.equal(router.current(), 'report');
});

test('a card fades out before it leaves the list (R8), and goes at once under reduced motion', async () => {
  routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const skipping = mypage.skipReview(ITEMS[0], card);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(card.classList.contains('fade') && card.classList.contains('is-invisible'), 'the card did not fade');
  assert.equal($('review-list').children.includes(card), true, 'the card went before its fade');
  await skipping;
  assert.equal($('review-list').children.includes(card), false);

  const saved = window.matchMedia;
  window.matchMedia = () => ({ matches: true });
  try {
    const other = $('review-list').children[0];
    const going = mypage.skipReview(ITEMS[1], other);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal($('review-list').children.includes(other), false, 'reduced motion still waited for a fade');
    await going;
  } finally {
    window.matchMedia = saved;
  }
});

test('the review buttons whose words change keep one width (R7)', async () => {
  routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  assert.ok(findByClass(card, 'play').classList.contains('btn-stable'));
  assert.ok(findByClass(card, 'speak').classList.contains('btn-stable'));
});

test('the result line and the explanation keep their place: class, not hidden', async () => {
  routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const result = findByClass(card, 'review-result');
  assert.equal(result.hidden, false);
  assert.ok(result.classList.contains('is-invisible'));
  assert.equal(result.dataset.hold, '1');
  const body = findByClass(card, 'explain-body');
  assert.ok(body.classList.contains('is-collapsed'));
  mypage.toggleExplain(card);
  assert.equal(body.classList.contains('is-collapsed'), false);
  assert.match(text(body), /과거형/);
  mypage.toggleExplain(card);
  assert.ok(body.classList.contains('is-collapsed'));
});

test('tag bars scale to the largest count; no tags says so', async () => {
  routes();
  await mypage.openMypage();
  const bars = $('tag-bars').children;
  assert.equal(findByClass(bars[0], 'fill').style.width, '100%');
  assert.equal(findByClass(bars[1], 'fill').style.width, '50%');
  assert.equal(findByClass(bars[1], 'n').textContent, '3회');
  routes({ stats: () => jsonResponse(STATS({ tags: [], accuracy: { correct: 0, graded: 0 } })) });
  await mypage.openMypage();
  assert.match(text($('tag-bars')), /아직 틀린 문장이 없어요/);
  // Held in place rather than removed (R5).
  assert.equal($('accuracy-line').hidden, false);
  assert.ok($('accuracy-line').classList.contains('is-invisible'));
});

test('history rows, 더 보기 appends, and the button hides when there is no more', async () => {
  const seen = routes({ history: (url) => (url.includes('offset=20') ? HISTORY(2) : HISTORY(20, true)) });
  await mypage.openMypage();
  assert.equal($('btn-history-more').classList.contains('is-invisible'), false);
  assert.match(text($('history-list').children[0]), /말한 문장 8 · 대본/);
  assert.match(text($('history-list').children[1]), /말한 문장 8 · 고친 곳 2/);
  assert.match(text($('history-list').children[1]), /상황 1 · 자유 상황극/);
  await mypage.loadHistory({ append: true });
  assert.ok(seen.history[1].includes('offset=20'));
  assert.equal($('history-list').children.length, 22);
  assert.equal($('btn-history-more').classList.contains('is-invisible'), true);
});

test('a history row with no graded turns does not claim 고친 곳 0', async () => {
  routes({ history: () => ({ items: [
    { id: 1, ended_at: '2026-09-13T05:00:00+00:00', title: 'a', mode: 'free', turns: 4, wrong: 0, graded: 0 },
    { id: 2, ended_at: '2026-09-13T05:00:00+00:00', title: 'b', mode: 'free', turns: 4, wrong: 0, graded: 3 },
  ], more: false }) });
  await mypage.openMypage();
  const [ungraded, graded] = $('history-list').children;
  assert.equal(findByClass(ungraded, 'sub').textContent, '말한 문장 4');
  assert.equal(findByClass(graded, 'sub').textContent, '말한 문장 4 · 고친 곳 0');
});

/* Task 4: a shadowing row's mode name and subtitle come from `item.shadowing`,
 * not `item.mode` -- the server still stores it as a script session
 * (docs/superpowers/specs/2026-09-19-monologue-shadowing-design.md). */
test('a shadowing history row shows 쉐도잉, not 스크립트', async () => {
  routes({ history: () => ({ items: [
    { id: 1, ended_at: '2026-09-13T05:00:00+00:00', title: 'a', mode: 'script', turns: 3, wrong: 0, graded: 0, shadowing: true },
  ], more: false }) });
  await mypage.openMypage();
  const row = $('history-list').children[0];
  assert.match(text(row), /쉐도잉/);
  assert.doesNotMatch(text(row), /스크립트/);
  assert.equal(findByClass(row, 'sub').textContent, '따라 한 줄 3 · 쉐도잉');
});

test('더 보기 says it is loading while the next page comes', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  routes({ historyResponse: async (url) => {
    if (url.includes('offset=20')) { await held; return jsonResponse(HISTORY(1)); }
    return jsonResponse(HISTORY(20, true));
  } });
  await mypage.openMypage();
  const more = mypage.loadHistory({ append: true });
  assert.equal($('btn-history-more').textContent, '불러오는 중...');
  release();
  await more;
  assert.equal($('btn-history-more').textContent, '더 보기');
});

test('a history row opens its actions by class, and a transcript folds away again', async () => {
  routes();
  await mypage.openMypage();
  const row = $('history-list').children[1];
  const actions = findByClass(row, 'history-actions');
  assert.ok(actions.classList.contains('is-collapsed'));
  mypage.toggleHistoryRow(row);
  assert.equal(actions.classList.contains('is-collapsed'), false);
  const slot = findByClass(row, 'history-slot');
  await mypage.openTranscript(101, slot);
  assert.match(text(slot), /→ I went\./);
  assert.equal(slot.classList.contains('is-collapsed'), false);
  await mypage.openTranscript(101, slot);
  assert.ok(slot.classList.contains('is-collapsed'), 'a second press did not fold the transcript');
  mypage.toggleHistoryRow(row);
  assert.ok(actions.classList.contains('is-collapsed'));
});

test('opening a report shows the report screen with a way back', async () => {
  routes();
  await mypage.openMypage();
  await mypage.openReport(100);
  assert.equal(router.current(), 'report');
  assert.equal($('btn-report-back').hidden, false);
  assert.equal(state.mode, 'free');
});

/* Task 4: openReport just hands whatever /sessions/{id}/report returns to
 * session.renderReport -- a shadowing report (kind: 'shadow') gets the same
 * shadowing layout there as ending a live session would. */
test('opening a shadowing report draws the shadowing report', async () => {
  routes({ report: () => jsonResponse({
    kind: 'shadow', mode: 'script', shadowing: true,
    stats: { turns: 3, minutes: 2 },
    shadow: {
      lines: 16, done: 3, matched: 2, peeked: 1,
      hard: [{ index: 1, said: 'banana', target: 'Yes, I am ready.', message_id: 5, audio_key: 'k' }],
    },
  }) });
  await mypage.openMypage();
  await mypage.openReport(100);
  assert.equal(router.current(), 'report');
  assert.equal($('report-headline').textContent, '3줄을 따라 말했어요.');
  assert.match(text($('report-body')), /어려웠던 줄/);
  assert.equal($('report-weak').hidden, true);
});

test('a transcript lists both sides and the fix under my line', async () => {
  routes();
  await mypage.openMypage();
  const slot = document.createElement('div');
  await mypage.openTranscript(100, slot);
  assert.match(text(slot), /Hi\./);
  assert.match(text(slot), /→ I went\./);
});

test('a stale response for another language is dropped', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  routes({ stats: async (url) => { if (url.includes('language=en')) { await held; } return jsonResponse(STATS({ level: { value: url.includes('ja') ? 'advanced' : 'beginner', sessions: 9, utterances: 99, need_sessions: 3, need_utterances: 15 } })); } });
  const first = mypage.openMypage();
  state.language = 'ja';
  await mypage.openMypage();
  release();
  await first;
  assert.match(text($('level-body')), /고급/);
});

test('one section failing says so there and leaves the others', async () => {
  routes({ review: () => jsonResponse({ detail: 'x' }, { ok: false, status: 500 }) });
  await mypage.openMypage();
  assert.match(text($('review-list')), /불러오지 못했어요/);
  assert.match(text($('level-body')), /레벨 판정까지 세션 2\/3/);
  assert.equal($('history-list').children.length, 3);
});

test('the level counts use the targets the server sends', async () => {
  routes({ stats: () => jsonResponse(STATS({ level: { value: null, sessions: 7, utterances: 9, need_sessions: 4, need_utterances: 20 } })) });
  await mypage.openMypage();
  assert.match(text($('level-body')), /세션 4\/4 · 발화 9\/20/);
});

test('a label and its sentence are two words, not one', async () => {
  routes();
  await mypage.openMypage();
  const said = findByClass($('review-list').children[0], 'said');
  assert.equal(said.childNodes[1].textContent, ' ');
});

/* Task 4: a normal review card still reads 내가 한 말 / 고친 문장 with the
 * wrong sentence struck through -- only a shadowing card (below) changes. */
test('a normal review card keeps 내가 한 말 / 고친 문장 and its strikethrough', () => {
  mypage.renderReviewList(
    [{ id: 1, text: 'I go there', fixed: 'I went there.', correction: '', tag: '시제', created_at: 'x' }], null,
  );
  const card = $('review-list').children[0];
  const said = findByClass(card, 'said');
  const fixed = findByClass(card, 'fixed');
  assert.equal(findByClass(said, 'label').textContent, '내가 한 말');
  assert.equal(findByClass(fixed, 'label').textContent, '고친 문장');
  assert.ok(!said.children.some((c) => c.tagName === 'S'), '내가 한 말에는 취소선을 긋지 않는다');
  assert.ok(said.children.some((c) => c.classList.contains('said-text')), '내가 한 말은 흐린 글씨로만 구분한다');
  assert.equal(findByClass(card, 'tag').textContent, '시제');
});

/* A shadowing card has nothing "wrong" to strike through -- 내 말 is just
 * what the learner said back to the script, and the tag chip's spot always
 * reads 쉐도잉 regardless of item.tag (there is no grammar tag to show). */
test('a shadowing review card reads 내 말 / 대본, no strikethrough, tag 쉐도잉', () => {
  mypage.renderReviewList(
    [{ id: 2, text: 'banana', fixed: 'Yes, I am ready.', correction: '', tag: null, shadowing: true, created_at: 'x' }], null,
  );
  const card = $('review-list').children[0];
  const said = findByClass(card, 'said');
  const fixed = findByClass(card, 'fixed');
  assert.equal(findByClass(said, 'label').textContent, '내 말');
  assert.equal(findByClass(fixed, 'label').textContent, '대본');
  assert.ok(!said.children.some((c) => c.tagName === 'S'), '쉐도잉 카드는 취소선이 없다');
  assert.equal(findByClass(card, 'tag').textContent, '쉐도잉');
});

test("opening an old report leaves the app's own mode alone", async () => {
  routes();
  await mypage.openMypage();
  state.mode = 'script';
  try {
    await mypage.openReport(100);
    assert.equal(state.mode, 'script');
    // ...while the report itself was drawn as the free session it was.
    assert.equal($('report-headline').textContent, '오늘 3턴을 주고받았어요.');
  } finally {
    state.mode = 'free';
  }
});

test('a second quick press cannot save a second result', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes({ result: async (body) => { await held; return jsonResponse({ id: 11, passes: 0, interval_d: 1, due_date: 'z', mastered: false }); } });
  await mypage.openMypage();
  const [first, second] = $('review-list').children;
  const skips = [mypage.skipReview(ITEMS[0], first), mypage.skipReview(ITEMS[0], first)];
  const speaking = mypage.speakReview(ITEMS[1], second, (t, r, b, onResult) => onResult(false, 'x'));
  const again = mypage.speakReview(ITEMS[1], second, (t, r, b, onResult) => onResult(false, 'x'));
  release();
  await Promise.all([...skips, speaking, again]);
  assert.deepEqual(seen.results, [[11, 'skip'], [12, 'fail']]);
  assert.equal(second.inert, false, 'a kept card stayed asleep after its result was saved');
});

test('a result that fails to save wakes the card again', async () => {
  routes({ result: () => jsonResponse({ detail: 'down' }, { ok: false, status: 500 }) });
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(true, 'x'));
  assert.equal(card.inert, false);
});

test('an older load for the same language does not paint over a newer one (en -> ja -> en)', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  let calls = 0;
  routes({ historyResponse: async () => {
    calls += 1;
    if (calls === 1) { await held; return jsonResponse(HISTORY(5)); }
    return jsonResponse(HISTORY(2));
  } });
  const first = mypage.openMypage();
  state.language = 'ja';
  await mypage.openMypage();
  state.language = 'en';
  await mypage.openMypage();
  release();
  await first;
  assert.equal($('history-list').children.length, 2);
});

test('a 더 보기 still out when my page is opened again is not appended', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  routes({ historyResponse: async (url) => {
    if (url.includes('offset=20')) { await held; return jsonResponse(HISTORY(1)); }
    return jsonResponse(HISTORY(20, true));
  } });
  await mypage.openMypage();
  const more = mypage.loadHistory({ append: true });
  await mypage.openMypage();
  release();
  await more;
  assert.equal($('history-list').children.length, 20);
});

/* A respeak stand-in that holds the listen open until the test delivers. */
function heldRespeak(started = true) {
  const h = { calls: 0 };
  h.fn = (target, resultEl, btn, onResult, opts = {}) => {
    h.calls += 1;
    h.lastOnResult = onResult;
    if (h.calls === 1) { h.onResult = onResult; h.onCancel = opts.onCancel; }
    return started;
  };
  return h;
}

test('while 말해보기 listens, 듣기 and 다음에 on that card stay out of it', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const play = findByClass(card, 'play');
  const skip = findByClass(card, 'skip');
  const h = heldRespeak();
  const speaking = mypage.speakReview(ITEMS[0], card, h.fn);
  assert.equal(play.disabled, true, '듣기 is live during the listen');
  assert.equal(skip.disabled, true, '다음에 is live during the listen');
  // Pressed anyway (a delegated click reaches these whatever `disabled` says).
  await mypage.skipReview(ITEMS[0], card);
  play.disabled = false;
  await mypage.playReview(ITEMS[0], play);
  assert.deepEqual(seen.results, [], 'a skip during the listen was saved');
  assert.equal(seen.audio.length, 0, 'the app spoke into the listen');
  assert.equal($('review-list').children.includes(card), true);
  // A second 말해보기 on the same card still reaches the re-speak (it stops it).
  mypage.speakReview(ITEMS[0], card, h.fn);
  assert.equal(h.calls, 2);
  assert.equal(h.lastOnResult, null, 'the stop press started a second attempt of its own');
  assert.equal(skip.disabled, true, 'the stop press woke the card before the verdict');
  h.onResult(false, 'I go');
  await speaking;
  assert.deepEqual(seen.results, [[11, 'fail']], 'the verdict was not saved exactly once');
  assert.equal(play.disabled, false);
  assert.equal(skip.disabled, false);
  await mypage.playReview(ITEMS[0], play);
  assert.equal(seen.audio.length, 1, '듣기 stayed dead after the verdict');
  await mypage.skipReview(ITEMS[0], card);
  assert.deepEqual(seen.results, [[11, 'fail'], [11, 'skip']]);
});

test('a 듣기 still preparing when 말해보기 starts stays asleep for the listen', async () => {
  routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const play = findByClass(card, 'play');
  const playing = mypage.playReview(ITEMS[0], play);
  const h = heldRespeak();
  mypage.speakReview(ITEMS[0], card, h.fn);
  await playing;
  assert.equal(play.disabled, true, 'the finished 듣기 woke up in the middle of the listen');
  h.onResult(null, null);
  assert.equal(play.disabled, false);
});

test('hearing nothing, a cancel, or a refused start each wake the card', async () => {
  routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const skip = findByClass(card, 'skip');
  const heard = heldRespeak();
  const speaking = mypage.speakReview(ITEMS[0], card, heard.fn);
  heard.onResult(null, null);
  await speaking;
  assert.equal(skip.disabled, false, 'hearing nothing left the card busy');

  const cancelled = heldRespeak();
  mypage.speakReview(ITEMS[0], card, cancelled.fn);
  assert.equal(skip.disabled, true);
  cancelled.onCancel();
  assert.equal(skip.disabled, false, 'a cancel left the card busy');

  mypage.speakReview(ITEMS[0], card, heldRespeak(false).fn);
  assert.equal(skip.disabled, false, 'a refused start left the card busy');
});

test('a pass that is removed keeps 듣기 and 다음에 asleep until it goes', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const h = heldRespeak();
  const speaking = mypage.speakReview(ITEMS[0], card, h.fn);
  h.onResult(true, 'I went there');
  await speaking;
  assert.equal(card.inert, true);
  await mypage.skipReview(ITEMS[0], card);
  assert.deepEqual(seen.results, [[11, 'pass']]);
});

test('after a fail, and after a save that failed, focus goes back to 말해보기', async () => {
  routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const speak = findByClass(card, 'speak');
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => { onResult(false, 'I go'); return true; });
  assert.equal(document.activeElement, speak, 'a fail left focus nowhere');

  routes({ result: () => jsonResponse({ detail: 'down' }, { ok: false, status: 500 }) });
  speak.blur();
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => { onResult(true, 'x'); return true; });
  assert.equal(document.activeElement, speak, 'a failed save left focus nowhere');
});

/* ---------- tabs: 복습 | 약점 | 기록, and the level as one line ---------- */

function stubStorage(initial = {}) {
  const data = { ...initial };
  globalThis.localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
  return data;
}

test('my page opens on the review tab by default and on the remembered tab after', async () => {
  routes();
  const store = stubStorage();
  await mypage.openMypage();
  assert.equal($('tab-review').getAttribute('aria-selected'), 'true');
  assert.equal($('weak-section').hidden, true);
  mypage.selectTab('history');
  assert.equal(store['mypage-tab'], 'history');
  assert.equal($('history-section').hidden, false);
  assert.equal($('review-section').hidden, true);
  assert.equal($('tab-history').getAttribute('tabindex'), '0');
  assert.equal($('tab-review').getAttribute('tabindex'), '-1');
  await mypage.openMypage();
  assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
});

test('an explicit tab wins over the remembered one (home review card)', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage({ tab: 'review' });
  assert.equal($('review-section').hidden, false);
});

test('a storage that throws still opens on review', async () => {
  routes();
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  await mypage.openMypage();
  assert.equal($('review-section').hidden, false);
  mypage.selectTab('weak');            // must not throw
  assert.equal($('weak-section').hidden, false);
});

test('a storage that throws still reopens on the tab last shown', async () => {
  routes();
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  await mypage.openMypage();
  mypage.selectTab('history');
  await mypage.openMypage();
  assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
  assert.equal($('history-section').hidden, false);
  assert.equal($('review-section').hidden, true);
});

test('an unknown remembered tab falls back to review', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'nonsense' });
  await mypage.openMypage();
  assert.equal($('review-section').hidden, false);
});

test('arrow keys move between tabs and wrap', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  const key = (k, from) => {
    let prevented = false;
    mypage.onTabKey({ key: k, target: $(from), preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(key('ArrowRight', 'tab-review'), true);
  assert.equal($('tab-weak').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, $('tab-weak'));
  key('ArrowLeft', 'tab-weak');
  key('ArrowLeft', 'tab-review');
  assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
  key('Home', 'tab-history');
  assert.equal($('tab-review').getAttribute('aria-selected'), 'true');
  assert.equal(key('End', 'tab-review'), true);
  assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, $('tab-history'));
  assert.equal(key('a', 'tab-history'), false);
});

test('the review tab carries the count of reviews left', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  assert.equal($('tab-review-n').textContent, '2');
});

test('the review tab is named in words, not "복습2"', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  assert.equal($('tab-review').getAttribute('aria-label'), '복습, 남은 문장 2개');
  routes({ stats: () => jsonResponse(STATS({ review: { due: 0, mastered: 1 } })), items: [] });
  await mypage.openMypage();
  assert.equal($('tab-review-n').textContent, '');
  assert.equal($('tab-review').getAttribute('aria-label'), '복습');
});

test('the level is one line in the head', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  assert.match(text($('level-body')), /레벨 판정까지 세션 2\/3 · 발화 9\/15/);
  routes({ stats: () => jsonResponse(STATS({ level: { value: 'intermediate', sessions: 5, utterances: 40, need_sessions: 3, need_utterances: 15 } })) });
  await mypage.openMypage();
  assert.match(text($('level-body')), /레벨 중급/);
});

/* ---------- the UI stability rules (spec 2026-09-14-monologue-ui-stability) ---------- */

test('the first load holds a skeleton of each section with the loading words (R3)', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const wait = async (body) => { await held; return jsonResponse(body); };
  routes({ stats: () => wait(STATS()), review: () => wait({ items: ITEMS }), historyResponse: () => wait(HISTORY(3)) });
  const opening = mypage.openMypage();
  await new Promise((r) => setTimeout(r, 0));
  for (const id of ['level-body', 'review-list', 'tag-bars', 'history-list']) {
    assert.match(text($(id)), /불러오는 중\.\.\./, `#${id} does not say it is loading`);
    assert.ok(hasClass($(id), 'skeleton'), `#${id} has no skeleton`);
  }
  // The skeleton rows are not history rows: 더 보기 must not count them.
  assert.equal($('history-list').children.filter((c) => c.dataset.id).length, 0);
  release();
  await opening;
  for (const id of ['level-body', 'review-list', 'tag-bars', 'history-list']) {
    assert.equal(hasClass($(id), 'skeleton'), false, `#${id} kept its skeleton`);
  }
});

test('reloading my page keeps what is painted, dimmed and asleep, and replaces it in place (R2)', async () => {
  routes();
  await mypage.openMypage();
  let release;
  const held = new Promise((r) => { release = r; });
  const wait = async (body) => { await held; return jsonResponse(body); };
  routes({ stats: () => wait(STATS({ review: { due: 1, mastered: 4 } })), review: () => wait({ items: [ITEMS[1]] }), historyResponse: () => wait(HISTORY(2)) });
  state.language = 'ja';
  const reloading = mypage.openMypage();
  await new Promise((r) => setTimeout(r, 0));
  for (const id of ['level-card', 'review-section', 'weak-section', 'history-section']) {
    assert.ok($(id).classList.contains('is-refreshing'), `#${id} is not dimmed`);
    assert.equal($(id).inert, true, `#${id} is dimmed but usable`);
  }
  assert.equal($('review-list').children.length, 2, 'the painted cards went before the answer');
  assert.equal($('history-list').children.length, 3);
  assert.equal(hasClass($('review-list'), 'skeleton'), false, 'a reload drew skeletons over painted content');
  release();
  await reloading;
  for (const id of ['level-card', 'review-section', 'weak-section', 'history-section']) {
    assert.equal($(id).classList.contains('is-refreshing'), false, `#${id} stayed dimmed`);
    assert.equal($(id).inert, false, `#${id} stayed asleep`);
  }
  assert.equal($('review-list').children.length, 1);
  assert.equal($('review-mastered').textContent, '익힌 문장 4개');
  assert.equal($('history-list').children.length, 2);
});

/* ---------- 약점: the coach, and a tag's own sentences ---------- */

const settleAll = async () => { for (let i = 0; i < 20; i += 1) await new Promise(setImmediate); };

test('the coach is asked for only when 약점 is opened, once per load', async () => {
  const seen = routes();
  stubStorage();
  await mypage.openMypage();
  assert.equal(seen.coach, undefined);
  mypage.selectTab('weak');
  mypage.selectTab('review');
  mypage.selectTab('weak');
  await settleAll();
  assert.equal(seen.coach, 1);
  assert.match(text($('coach-body')), /여러 말을 끊지 않고 이어 말해요/);
  assert.match(text($('coach-body')), /한 문장 말하고 숨을 한 번 쉬어요/);
  assert.match(text($('coach-body')), /내 말\s+Yes water please And/);
  assert.match(text($('coach-body')), /고친 문장\s+Yes, water please\./);
  assert.equal($('coach-day').textContent, '오늘 만듦');
});

test('while the coach is being made the wait is said on screen', async () => {
  let release;
  routes({ coach: () => new Promise((r) => { release = () => r(jsonResponse(COACH)); }) });
  stubStorage();
  await mypage.openMypage();
  mypage.selectTab('weak');
  assert.match(text($('coach-body')), /코치가 최근 문장을 읽는 중이에요/);
  assert.equal($('coach-body').getAttribute('aria-busy'), 'true');
  await settleAll();
  release();
  await settleAll();
  assert.doesNotMatch(text($('coach-body')), /읽는 중/);
  assert.equal($('coach-body').getAttribute('aria-busy'), null);
});

test('too few wrong sentences says how many are needed', async () => {
  routes({ coach: () => jsonResponse({ status: 'too_few', count: 3, need: 5 }) });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  await settleAll();
  assert.match(text($('coach-body')), /^최근 30일 틀린 문장이 5개 모이면 코치가 짚어 줘요 \(지금 3개\)/);
  assert.equal($('coach-day').textContent, '');
});

test('a failed coach offers 다시 시도 and it asks again', async () => {
  let fail = true;
  const seen = routes({ coach: () => (fail ? jsonResponse({ detail: 'x' }, { ok: false, status: 503 }) : jsonResponse(COACH)) });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  await settleAll();
  assert.match(text($('coach-body')), /코치 한마디를 만들지 못했어요/);
  assert.ok(findByClass($('coach-body'), 'coach-retry'), 'no 다시 시도 button');
  fail = false;
  await mypage.loadCoach({ force: true });
  assert.equal(seen.coach, 2);
  assert.match(text($('coach-body')), /여러 말을 끊지 않고/);
});

test('after 다시 시도, focus lands on the coach, whatever came back', async () => {
  let answer = () => jsonResponse({ detail: 'x' }, { ok: false, status: 503 });
  routes({ coach: () => answer() });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  await settleAll();
  assert.notEqual(document.activeElement, $('coach-body'), 'a plain load took focus');
  for (const next of [() => jsonResponse(COACH), () => jsonResponse({ status: 'too_few', count: 3, need: 5 }),
                      () => jsonResponse({ detail: 'x' }, { ok: false, status: 503 })]) {
    answer = next;
    $('coach-body').blur();
    await mypage.loadCoach({ force: true });
    assert.equal(document.activeElement, $('coach-body'));
  }
});

test('the coach body can take focus (tabindex="-1" in index.html)', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="coach-body"[^>]*\stabindex="-1"/);
});

test('a coach answer from an older load or language is not painted', async () => {
  let release;
  routes({ coach: () => new Promise((r) => { release = () => r(jsonResponse(COACH)); }) });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  state.language = 'ja';
  const seen = routes({ coach: () => jsonResponse({ status: 'too_few', count: 1, need: 5 }) });
  await mypage.openMypage();
  await settleAll();
  assert.equal(seen.coach, 1, 'the new load did not ask for its own coach');
  release();
  await settleAll();
  assert.match(text($('coach-body')), /지금 1개/);
});

test('a tag opens to its newest sentences, without a strike-through class', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  const item = $('tag-bars').children.find((c) => c.classList.contains('tag-item'));
  const fold = item.children.find((c) => c.classList.contains('tag-examples'));
  assert.ok(fold.classList.contains('is-collapsed'));
  const head = item.children.find((c) => c.classList.contains('tag-bar'));
  assert.equal(head.tagName, 'BUTTON');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  const n = head.children.find((c) => c.classList.contains('n'));
  assert.equal(n.textContent, '6회 ▸');
  mypage.toggleTagItem(item);
  assert.ok(!fold.classList.contains('is-collapsed'));
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(n.textContent, '6회 ▾');
  assert.match(text(fold), /내 말\s+I go there yesterday/);
  assert.match(text(fold), /고친 문장\s+I went there yesterday\./);
  assert.match(text(fold), /지난 일은 과거형으로/);
  assert.equal(hasClass(fold, 'said'), false, 'a .said class is struck through elsewhere');
  assert.equal(hasTag(fold, 'S'), false, 'the learner\'s words sit in an <s>');
  mypage.toggleTagItem(item);
  assert.ok(fold.classList.contains('is-collapsed'));
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(n.textContent, '6회 ▸');
});

test('a tag with no sentences stays a plain bar', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  const items = $('tag-bars').children.filter((c) => c.classList.contains('tag-item'));
  const plain = items[1];
  assert.equal(plain.children.some((c) => c.classList.contains('tag-examples')), false);
  const bar = plain.children.find((c) => c.classList.contains('tag-bar'));
  assert.notEqual(bar.tagName, 'BUTTON');
  assert.equal(bar.getAttribute('aria-expanded'), null);
});

function findByClass(el, cls) {
  if (el.classList && el.classList.contains(cls)) return el;
  for (const c of el.children || []) { const hit = findByClass(c, cls); if (hit) return hit; }
  return null;
}
/* Same helpers as home.test.js: dom-shim's textContent does not gather children. */
const text = (n) => (n.textContent || '') + (n.childNodes || []).map(text).join(' ');
const hasClass = (node, cls) => node.classList.contains(cls)
  || node.children.some((c) => hasClass(c, cls));
const hasTag = (node, tag) => node.tagName === tag
  || node.children.some((c) => hasTag(c, tag));

/* 1분 말하기 (Task 5): its rows count rounds (one minute of speaking each), not
 * turns, and an ungraded one does not claim 고친 곳 0. */
test('a 1분 말하기 history row reads 1분 말하기 and counts rounds', async () => {
  routes({ history: () => ({ items: [
    { id: 1, ended_at: '2026-09-13T05:00:00+00:00', title: 'q', mode: 'timed', turns: 5, rounds: 2, wrong: 3, graded: 5 },
    { id: 2, ended_at: '2026-09-13T05:00:00+00:00', title: 'q', mode: 'timed', turns: 0, rounds: 1, wrong: 0, graded: 0 },
  ], more: false }) });
  await mypage.openMypage();
  const [graded, ungraded] = $('history-list').children;
  assert.match(text(graded), /q · 1분 말하기/);
  assert.equal(findByClass(graded, 'sub').textContent, '2회 · 고친 곳 3');
  assert.equal(findByClass(ungraded, 'sub').textContent, '1회');
});

/* ---------- the level line with a level test ---------- */

const TEST_EN = { cefr: 'B1', step: '상위', ielts: '4.5–5.0', toefl: { band: '3.5', old: '18–19' }, jf: null, finished_at: 'x' };
const TEST_JA = { cefr: 'B1', step: '하위', ielts: null, toefl: null, jf: 'JF 스탠다드 B1', finished_at: 'x' };
const LT_RESULT = {
  test_id: 3, language: 'en', cefr: 'B1', step: '상위', app_level: 'intermediate',
  ei: { score: 27, max: 48, by_level: { A1: [8, 8] } }, answers: [],
  ielts: '4.5–5.0', toefl: { band: '3.5', old: '18–19' }, jf: null, note: '말하기만 본 추정이에요 · 공식 점수가 아니에요',
};
const flat = (n) => (n.textContent || '') + (n.childNodes || []).map(flat).join('');
function byCls(node, cls, out = []) {
  if (node.classList && node.classList.contains(cls)) out.push(node);
  for (const c of node.children || []) byCls(c, cls, out);
  return out;
}
const levelButtons = () => byCls($('level-body'), 'level-actions')[0].children;
const withTest = (test, value = 'intermediate') => STATS({ level: { value, sessions: 0, utterances: 0,
  need_sessions: 3, need_utterances: 15, test } });

test('a finished level test is the head line: its level and IELTS, with 결과 보기 and 다시 테스트 on the line', async () => {
  routes({ stats: () => jsonResponse(withTest(TEST_EN)) });
  await mypage.openMypage();
  const line = $('level-body').children;
  assert.equal(line.length, 1, 'one line');
  assert.equal(flat(byCls($('level-body'), 'level-text')[0]), '레벨 B1 상위 · IELTS 말하기 4.5–5.0 예상');
  assert.deepEqual(levelButtons().map((b) => b.textContent), ['결과 보기', '다시 테스트']);
  assert.ok(levelButtons().every((b) => b.tagName === 'BUTTON' && b.type === 'button'));
  // The buttons are on the line itself, not a row of their own.
  assert.equal(byCls(line[0], 'level-actions').length, 1);
});

test('in Japanese the head line names JF Standard', async () => {
  state.language = 'ja';
  routes({ stats: () => jsonResponse(withTest(TEST_JA)) });
  await mypage.openMypage();
  assert.equal(flat(byCls($('level-body'), 'level-text')[0]), '레벨 B1 하위 · JF 스탠다드 B1');
  state.language = 'en';
});

test('no level test: the line as before, with 레벨 테스트 (7분) beside it', async () => {
  routes();
  await mypage.openMypage();
  assert.equal(flat(byCls($('level-body'), 'level-text')[0]), '레벨 판정까지 세션 2/3 · 발화 9/15');
  assert.deepEqual(levelButtons().map((b) => b.textContent), ['레벨 테스트 (7분)']);
  routes({ stats: () => jsonResponse(STATS({ level: { value: 'advanced', sessions: 9, utterances: 99, need_sessions: 3, need_utterances: 15, test: null } })) });
  await mypage.openMypage();
  assert.equal(flat(byCls($('level-body'), 'level-text')[0]), '레벨 고급 · 최근 세션 판정');
  assert.deepEqual(levelButtons().map((b) => b.textContent), ['레벨 테스트 (7분)']);
});

test('결과 보기 fetches this language\'s latest result and opens it on the level test screen, with ← 마이페이지', async () => {
  router.register('leveltest', 'leveltest');
  const asked = [];
  routes({ stats: () => jsonResponse(withTest(TEST_EN)) });
  await mypage.openMypage();
  const show = levelButtons()[0];
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('/api/level-test/latest')) { asked.push(url); return jsonResponse({ result: LT_RESULT }); }
    return base(url, opts);
  };
  await show.listeners.click[0]();
  assert.deepEqual(asked, ['/api/level-test/latest?language=en']);
  assert.equal(router.current(), 'leveltest');
  assert.equal($('lt-result').hidden, false);
  assert.equal($('lt-intro').hidden, true);
  assert.equal($('lt-result-back').textContent, '← 마이페이지');
  assert.equal(byCls($('lt-result-body'), 'lt-cefr')[0].textContent, 'B1 상위');
});

test('결과 보기 does not pull a learner who left my page meanwhile onto the result', async () => {
  router.register('leveltest', 'leveltest');
  routes({ stats: () => jsonResponse(withTest(TEST_EN)) });
  await mypage.openMypage();
  const show = levelButtons()[0];
  let release;
  const held = new Promise((r) => { release = r; });
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('/api/level-test/latest')) { await held; return jsonResponse({ result: LT_RESULT }); }
    return base(url, opts);
  };
  const pressing = show.listeners.click[0]();
  router.show('home');
  release();
  await pressing;
  assert.equal(router.current(), 'home');
  assert.equal(show.disabled, false);
});

test('다시 테스트 and 레벨 테스트 (7분) open the test at its intro', async () => {
  router.register('leveltest', 'leveltest');
  const lt = await import('./leveltest.js');
  routes({ stats: () => jsonResponse(withTest(TEST_EN)) });
  await mypage.openMypage();
  levelButtons()[1].listeners.click[0]();
  assert.equal(router.current(), 'leveltest');
  assert.equal(lt.levelTestState().step, 'intro');
  assert.equal($('lt-intro').hidden, false);
  lt.leaveLevelTest();

  routes();
  await mypage.openMypage();
  levelButtons()[0].listeners.click[0]();
  assert.equal(router.current(), 'leveltest');
  assert.equal(lt.levelTestState().step, 'intro');
  lt.leaveLevelTest();
});
