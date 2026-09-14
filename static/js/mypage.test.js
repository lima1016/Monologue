import { beforeEach, test } from 'node:test';
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
});

const STATS = (over = {}) => ({
  level: { value: null, sessions: 2, utterances: 9, need_sessions: 3, need_utterances: 15 },
  accuracy: { correct: 18, graded: 25 }, tags: [{ tag: '시제', n: 6 }, { tag: '관사', n: 3 }],
  review: { due: 2, mastered: 1 }, ...over,
});
const ITEMS = [
  { id: 11, text: 'I go there', fixed: 'I went there.', correction: '과거형', tag: '시제', created_at: 'x' },
  { id: 12, text: 'She have', fixed: 'She has.', correction: '수 일치', tag: '단복수', created_at: 'y' },
];
const HISTORY = (n, more = false) => ({ items: Array.from({ length: n }, (_, i) => ({
  id: 100 + i, ended_at: '2026-09-13T05:00:00+00:00', title: `상황 ${i}`, mode: i === 0 ? 'script' : 'free', turns: 8, wrong: 2 })), more });

function routes(extra = {}) {
  const seen = { results: [], audio: [], history: [] };
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
    if (/\/api\/sessions\/\d+\/report/.test(url)) return jsonResponse({ summary: '좋았어요', weak_points: [], expressions: [], next_focus: '', level: 'beginner', mode: 'free', stats: { turns: 3, wrong: 1, minutes: 4, sentences: [] } });
    if (/\/api\/sessions\/\d+$/.test(url)) return jsonResponse({ session: {}, messages: [
      { speaker: 'bot', text: 'Hi.' }, { speaker: 'user', text: 'I go', ok: 0, fixed: 'I went.' }] });
    if (url.startsWith('/api/stats/home')) return jsonResponse({ top_tags: [] });
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
  assert.match(text($('level-body')), /판정하기엔 아직 일러요/);
  assert.match(text($('level-body')), /세션 2\/3 · 발화 9\/15/);
  assert.equal($('review-count').textContent, '오늘의 복습 2개');
  assert.equal($('review-mastered').textContent, '익힌 문장 1개');
  assert.equal($('accuracy-line').textContent, '문장 정확도 72% · 최근 30일 채점된 25문장');
  assert.equal($('history-list').children.length, 3);
});

test('a level is shown once the sample is big enough', async () => {
  routes({ stats: () => jsonResponse(STATS({ level: { value: 'intermediate', sessions: 5, utterances: 40, need_sessions: 3, need_utterances: 15 } })) });
  await mypage.openMypage();
  assert.match(text($('level-body')), /지금 레벨 중급/);
  assert.match(text($('level-body')), /최근 세션들에서 가장 많이 나온 판정이에요/);
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
  const seen = routes({ items: [ITEMS[0]] });
  await mypage.openMypage();
  await mypage.skipReview(ITEMS[0], $('review-list').children[0]);
  assert.deepEqual(seen.results, [[11, 'skip']]);
  assert.match(text($('review-list')), /오늘 복습할 문장이 없어요/);
});

test('an empty list with nothing ever corrected says where sentences come from', async () => {
  routes({ items: [], stats: () => jsonResponse(STATS({ review: { due: 0, mastered: 0 } })) });
  await mypage.openMypage();
  assert.match(text($('review-list')), /오늘 복습할 문장이 없어요/);
  assert.match(text($('review-list')), /대화에서 고친 문장이 여기 모여요/);
  assert.equal($('review-mastered').textContent, '');
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
  assert.match(text($('level-body')), /판정하기엔 아직 일러요/);
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

function findByClass(el, cls) {
  if (el.classList && el.classList.contains(cls)) return el;
  for (const c of el.children || []) { const hit = findByClass(c, cls); if (hit) return hit; }
  return null;
}
/* Same helpers as home.test.js: dom-shim's textContent does not gather children. */
const text = (n) => (n.textContent || '') + (n.childNodes || []).map(text).join(' ');
const hasClass = (node, cls) => node.classList.contains(cls)
  || node.children.some((c) => hasClass(c, cls));
