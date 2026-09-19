/* 마이페이지: the place to look back -- level, today's review, weak spots and
   past sessions. docs/superpowers/specs/2026-09-14-monologue-mypage-design.md.

   Built to the UI stability rules (2026-09-14-monologue-ui-stability-design.md):
   a first load holds a skeleton of each section's own size with the loading
   words over it (R3); a reload (a language switch while here) keeps what is
   painted, dims it and puts it to sleep, and replaces it in place (R2); lines
   and buttons that come and go inside a card keep their row (R5); a card
   leaving the list fades first (R8).

   Imports session.js (the same re-speak and report the session screen uses)
   and nothing imports this but main.js, so no cycle can close through here.

   dom-shim has no selector engine, so nothing here uses querySelector: every
   node this module needs is either an id or a child it found by class walking
   its own tree (`find`). */
import { $, getJSON, postJSON, state, notify, setShown, syncLanguageButtons,
         reducedMotion, LEAVE_MS } from './api.js';
import { play } from './audio.js';
import * as router from './router.js';
import { startRespeak, renderReport, canDo, cancelTurn } from './session.js';
import { openLevelTest, renderLevelResult, levelName } from './leveltest.js';
import { GROWTH_TEXT, summarySkeleton, renderSummary, renderDetails, hasPractice } from './growth.js';

const LEVEL_NAMES = { beginner: '초급', intermediate: '중급', advanced: '고급' };
const MODE_NAMES = { script: '스크립트', free: '자유 상황극', lesson: '수업', timed: '1분 말하기' };

// A shadowing session is stored as a flagged script session (server design:
// docs/superpowers/specs/2026-09-19-monologue-shadowing-design.md), so
// MODE_NAMES alone would call it 스크립트 -- item.shadowing always wins.
function modeName(item) {
  return item.shadowing ? '쉐도잉' : (MODE_NAMES[item.mode] || item.mode);
}
const LOADING = '불러오는 중...';
const FAILED = '불러오지 못했어요';
const PLAY_LABEL = '▶ 듣기';
const MORE_LABEL = '더 보기';
// 복습 shows this many cards at a time: sixteen due is three screens.
const REVIEW_STEP = 5;
// A passed card stays this long, result and all, before it is gone from the
// list -- its fade is the last LEAVE_MS of it.
const PASS_HOLD_MS = 1500;
// A placeholder line needs a character to be a line at all.
const NBSP = String.fromCharCode(0xa0);

const SECTIONS = ['level-card', 'growth-card', 'review-section', 'weak-section', 'history-section'];
const BUSY = '지금은 다른 연습이 진행 중이에요';

// Bumped by every openMypage. A language check alone cannot tell en -> ja ->
// en apart, nor a 더 보기 still out when the page is opened again; an answer
// from any load but the latest is not painted.
let loadToken = 0;

let reviewItems = new Map();     // id -> item, for main.js's delegated clicks
let reviewCounts = null;         // { due, mastered, total } from /stats/mypage, or null
let reviewLeft = 0;              // cards still on the list
let reviewDone = 0;              // cards taken off the list this load
let reviewLimit = 0;             // cards shown at once; 더 보기 raises it
let reportOut = false;           // a 리포트 보기 is waiting for its answer

/* ---------- tabs ---------- */

/* Three tabs, one visible at a time: the page no longer fit on one screen
   with all of it stacked. The last one looked at is remembered (a private
   window or blocked storage just starts on 복습 every time). How practice
   is going is not a tab: it is the card above them (see 성장 below). */
const TABS = ['review', 'weak', 'history'];
const TAB_KEY = 'mypage-tab';
const PANEL = { review: 'review-section', weak: 'weak-section', history: 'history-section' };

// The tab on screen, for when storage cannot say: a language switch on 기록
// reopens the page, and must not drop the learner back on 복습.
let shownTab = null;

function rememberedTab() {
  try {
    const t = globalThis.localStorage?.getItem(TAB_KEY);
    if (TABS.includes(t)) return t;
    // 'growth' (the tab that became the card above) or anything else stored:
    // the page's first tab, not whichever one happened to be on screen.
    if (t) return 'review';
  } catch { /* blocked storage: fall through */ }
  return shownTab || 'review';
}

export function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'review';
  for (const t of TABS) {
    const on = t === name;
    const tab = $(`tab-${t}`);
    tab.setAttribute('aria-selected', String(on));
    tab.setAttribute('tabindex', on ? '0' : '-1');
    $(PANEL[t]).hidden = !on;
  }
  shownTab = name;
  if (focus) $(`tab-${name}`).focus();
  try { globalThis.localStorage?.setItem(TAB_KEY, name); } catch { /* private window: fine */ }
  if (name === 'weak') onWeakShown();
}

/* The coach is asked for only when 약점 is looked at -- it is the one slow
   thing on the page (an LLM read, 10-20 s the first time each day). selectTab
   runs after openMypage bumps loadToken, so this is keyed to the load on screen
   and a reopen or a language switch on 약점 asks again, once. */
function onWeakShown() { loadCoach(); }

/* main.js's keydown on #mypage-tabs: the arrows move along the row (and wrap),
   Home and End go to the ends; the tab moved to is selected and focused.
   The tab is read off its id (tab-<name>), not data-tab: dom-shim builds
   elements from ids alone, and the id is the same fact in a browser. */
export function onTabKey(e) {
  const current = String(e.target?.id || '').replace(/^tab-/, '');
  const i = TABS.indexOf(current);
  if (i < 0) return;
  const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length,
                 Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(TABS[next], { focus: true });
}

/* ---------- opening ---------- */

/* `tab` picks the tab to open on (home's 복습 card asks for review); without
   it, the one looked at last. */
export async function openMypage({ tab } = {}) {
  // The header button is a way out of a live session that does not reload the
  // page. A listen or a transcription left running on the hidden screen would
  // post a turn and play the reply over this one, so it is thrown away here
  // -- the same as the learner pressing 취소. (A turn already sent is left to
  // finish; the session comes back as 이어서 하기.)
  if (canDo('cancel')) cancelTurn();
  router.show('mypage');
  syncLanguageButtons();
  // Captured at call time: a language switch or a second open meanwhile
  // starts a newer load, and this one's answers must not paint over it.
  const lang = state.language;
  const token = ++loadToken;
  // After the bump, not before: selecting 약점 starts its own load (Task 4's
  // coach), keyed to this token -- selected earlier, it would be stale at once.
  selectTab(tab || rememberedTab());
  const stale = () => token !== loadToken || state.language !== lang;
  const screen = $('mypage');

  if (screen.dataset.painted === '1') {
    for (const id of SECTIONS) setRefreshing(id, true);
  } else {
    paintSkeletons();
  }

  const stats = getJSON(`/stats/mypage?language=${lang}`);
  const items = getJSON(`/review?language=${lang}`);

  const level = stats.then(
    (s) => { if (stale()) return; renderLevel(s.level); settle('level-card'); },
    () => { if (stale()) return; fail('level-card', $('level-body')); },
  );
  const weak = stats.then(
    (s) => { if (stale()) return; renderTags(s.tags, s.accuracy); settle('weak-section'); },
    () => {
      if (stale()) return;
      setShown($('accuracy-line'), false);
      fail('weak-section', $('tag-bars'));
    },
  );
  const review = items.then(
    async ({ items: list }) => {
      // The counts ride on /stats/mypage; without them the list still shows.
      const s = await stats.catch(() => null);
      if (stale()) return;
      renderReviewList(list || [], s ? s.review : null);
      settle('review-section');
    },
    () => {
      if (stale()) return;
      $('review-count').textContent = '오늘의 복습';
      $('tab-review-n').textContent = '';
      $('tab-review').setAttribute('aria-label', '복습');
      $('review-mastered').textContent = '';
      setShown($('btn-review-more'), false);
      fail('review-section', $('review-list'));
    },
  );
  const history = loadHistory({ append: false });
  const growth = loadGrowth();

  await Promise.all([level, weak, review, history, growth]);
  if (!stale()) screen.dataset.painted = '1';
}

/* Dimmed also means asleep: after a language switch the sections still show
   the previous language, and 말해보기 or 다음에 on one of those cards would
   act on it. `inert` takes them out of clicks and focus; .is-refreshing's
   pointer-events: none is the belt. */
function setRefreshing(id, on) {
  const section = $(id);
  section.classList.toggle('is-refreshing', on);
  section.inert = on;
}

function settle(id) {
  setRefreshing(id, false);
  $(id).removeAttribute('aria-busy');
}

function fail(id, body) {
  body.replaceChildren(el('p', 'mypage-error', FAILED));
  settle(id);
}

/* Each placeholder is built from the real thing's classes, so it is the
   height of what replaces it; the loading words sit over the first row
   (.mypage-loading) instead of adding a row of their own. */
function paintSkeletons() {
  for (const id of SECTIONS) $(id).setAttribute('aria-busy', 'true');

  $('level-body').replaceChildren(loadingNote(), skeletonLine('p', 'level-line'));

  $('growth-body').replaceChildren(loadingNote(GROWTH_TEXT.wait), ...summarySkeleton(growthWidth()));
  setShown($('btn-growth-more'), false);

  $('review-count').textContent = NBSP;
  $('review-mastered').textContent = '';
  const cards = [0, 1].map(() => {
    const card = el('div', 'review-card is-skeleton');
    const actions = el('div', 'actions');
    actions.append(el('span', 'skeleton skel-btn'), el('span', 'skeleton skel-btn'));
    card.append(skeletonLine('p', 'said'), skeletonLine('p', 'fixed'), actions);
    return card;
  });
  $('review-list').replaceChildren(loadingNote(), ...cards);
  setShown($('btn-review-more'), false);

  const accuracy = $('accuracy-line');
  accuracy.textContent = NBSP;
  setShown(accuracy, false);
  const bars = [0, 1, 2].map(() => {
    const bar = el('div', 'tag-bar is-skeleton');
    const track = el('div', 'track');
    track.append(el('div', 'fill'));
    bar.append(skeletonLine('span', 'name'), track, skeletonLine('span', 'n'));
    return bar;
  });
  $('tag-bars').replaceChildren(loadingNote(), ...bars);

  const rows = [0, 1, 2].map(() => {
    const li = el('li', 'history-row is-skeleton');
    const head = el('div', 'history-head');
    head.append(skeletonLine('span', 'main'), skeletonLine('span', 'sub'));
    li.append(head);
    return li;
  });
  $('history-list').replaceChildren(loadingNote(), ...rows);
  setShown($('btn-history-more'), false);
}

function skeletonLine(tag, cls) {
  return el(tag, `${cls} skeleton`, NBSP);
}

function loadingNote(words = LOADING) {
  const note = el('div', 'mypage-loading');
  const dots = el('div', 'thinking');
  dots.append(el('i'), el('i'), el('i'));
  note.append(dots, el('span', '', words));
  return note;
}

/* ---------- level ---------- */

export const LEVEL_TEXT = {
  ielts: (band) => `IELTS 말하기 ${band} 예상`,
  show: '결과 보기',
  retake: '다시 테스트',
  take: '레벨 테스트 (7분)',
};

/* The head line. With a finished level test it is the test's level and what
   it comes to (IELTS for English, JF for Japanese), with 결과 보기 and 다시
   테스트 beside it; without one, the practice sample's line as before, with
   레벨 테스트 (7분) beside it. The buttons sit on the line itself -- see
   .level-line in components.css for the room it holds. */
export function renderLevel(level) {
  const body = $('level-body');
  const test = level && level.test;
  if (test) {
    const line = el('p', 'level-line');
    const words = el('span', 'level-text');
    const scale = test.jf || (test.ielts ? LEVEL_TEXT.ielts(test.ielts) : '');
    words.append(el('b', '', `레벨 ${levelName(test)}`));
    if (scale) words.append(document.createTextNode(` · ${scale}`));
    const show = button('level-show', LEVEL_TEXT.show);
    show.addEventListener('click', () => { dropListen(); return showLevelResult(show); });
    const retake = button('level-retake', LEVEL_TEXT.retake);
    retake.addEventListener('click', () => { dropListen(); return openLevelTest(); });
    line.append(words, actions(show, retake));
    body.replaceChildren(line);
    return;
  }
  const words = el('span', 'level-text');
  if (level && level.value) {
    words.append(el('b', '', `레벨 ${LEVEL_NAMES[level.value] || level.value}`),
      document.createTextNode(' · 최근 세션 판정'));
  } else {
    // Stops at the target: 세션 5/3 next to 발화 9/15 reads as a typo.
    const needSessions = level?.need_sessions ?? 3;
    const needUtterances = level?.need_utterances ?? 15;
    const sessions = Math.min(level?.sessions ?? 0, needSessions);
    const utterances = Math.min(level?.utterances ?? 0, needUtterances);
    words.textContent = `레벨 판정까지 세션 ${sessions}/${needSessions} · 발화 ${utterances}/${needUtterances}`;
  }
  const take = button('level-take', LEVEL_TEXT.take);
  take.addEventListener('click', () => { dropListen(); return openLevelTest(); });
  const line = el('p', 'level-line');
  line.append(words, actions(take));
  body.replaceChildren(line);
}

/* The level line's buttons leave my page, as ← 홈 does: a review card's
   listen still running would go on under the level test's own recording. */
function dropListen() {
  if (canDo('cancel')) cancelTurn();
}

function actions(...buttons) {
  const box = el('span', 'level-actions');
  box.append(...buttons);
  return box;
}

/* 결과 보기: the language's latest result, drawn on the level test screen with
   ← 마이페이지 to come back. A press while one is out asks nothing more; a
   learner who left my page meanwhile is not pulled onto the result. */
async function showLevelResult(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const token = loadToken;
  const lang = state.language;
  try {
    const { result } = await getJSON(`/level-test/latest?language=${lang}`);
    if (router.current() !== 'mypage' || token !== loadToken || state.language !== lang) return;
    if (!result) { notify(FAILED); return; }
    renderLevelResult(result, { from: 'mypage' });
  } catch {
    if (router.current() === 'mypage') notify(FAILED);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- today's review ---------- */

export function renderReviewList(items, counts) {
  reviewItems = new Map(items.map((item) => [String(item.id), item]));
  reviewCounts = counts ? { ...counts } : null;
  reviewLeft = items.length;
  reviewDone = 0;
  reviewLimit = REVIEW_STEP;
  paintReviewHead();
  const list = $('review-list');
  if (!items.length) {
    paintReviewEmpty();
    return;
  }
  list.replaceChildren(...items.map(reviewCard));
  paintReviewLimit();
}

/* The first `reviewLimit` cards on the list are shown, the rest [hidden] --
   out of the layout and the tab order. A card that leaves makes room for the
   next, so the list stays at the limit while more are waiting. Returns the
   cards this call brought out. */
function paintReviewLimit() {
  // A live HTMLCollection in a browser: no filter until it is an array.
  const cards = Array.from($('review-list').children).filter((c) => c.classList.contains('review-card'));
  const revealed = [];
  cards.forEach((card, i) => {
    const hide = i >= reviewLimit;
    // The fade-in is spent by the next paint; a card keeps no stale class.
    card.classList.remove('is-revealed');
    if (card.hidden && !hide) {
      card.classList.add('is-revealed');
      revealed.push(card);
    }
    card.hidden = hide;
  });
  const waiting = Math.max(0, cards.length - reviewLimit);
  const more = $('btn-review-more');
  if (waiting) more.textContent = `${MORE_LABEL} (${waiting}개 남음)`;
  setShown(more, waiting > 0);
  return revealed;
}

/* main.js's #btn-review-more: five more, and the keyboard lands on the first
   one's 듣기 (its first action, not ▸ 설명) rather than staying on a button
   that may now be gone. */
export function showMoreReviews() {
  reviewLimit += REVIEW_STEP;
  const [first] = paintReviewLimit();
  const actions = first && find(first, 'actions');
  const target = actions && findTag(actions, 'BUTTON');
  if (target) target.focus();
}

/* The list stops at twenty; the heading counts the day's reviews the server
   has, less the ones done here. Without counts, the list is all there is. */
function reviewsLeft() {
  return reviewCounts ? Math.max(reviewLeft, reviewCounts.due - reviewDone) : reviewLeft;
}

function paintReviewHead() {
  const left = reviewsLeft();
  $('review-count').textContent = `오늘의 복습 ${left}개`;
  // The tab says it too, so 복습 is worth a look from 약점 or 기록.
  $('tab-review-n').textContent = left > 0 ? String(left) : '';
  // Its name, said whole: a screen reader would read the badge as "복습2".
  $('tab-review').setAttribute('aria-label', left > 0 ? `복습, 남은 문장 ${left}개` : '복습');
  const mastered = reviewCounts ? reviewCounts.mastered : 0;
  $('review-mastered').textContent = mastered > 0 ? `익힌 문장 ${mastered}개` : '';
}

function paintReviewEmpty() {
  const empty = el('div', 'review-empty');
  const more = reviewsLeft();
  if (more > 0) {
    // The twenty on the list are done; the rest come with the next load.
    empty.append(el('p', '', `남은 문장 ${more}개는 다시 열면 나와요`));
  } else {
    empty.append(el('p', '', '오늘 복습할 문장이 없어요'));
  }
  // Only for a learner who has never had a correction queued.
  if (!more && reviewCounts && reviewCounts.total === 0) {
    empty.append(el('p', 'hint', '대화에서 고친 문장이 여기 모여요'));
  }
  $('review-list').replaceChildren(empty);
  setShown($('btn-review-more'), false);
}

function reviewCard(item) {
  const card = el('div', 'review-card');
  card.dataset.id = String(item.id);

  // A space between label and sentence, so they never read as one word
  // (copied text, a screen reader, or a stylesheet that drops the margin).
  const said = el('p', 'said');
  const fixed = el('p', 'fixed');
  if (item.shadowing) {
    // Nothing was "wrong" here -- 내 말 is just what the learner said back to
    // the script, so it gets no strikethrough, and there is no grammar tag
    // to show in the chip's spot, so it always reads 쉐도잉 instead.
    said.append(el('span', 'label', '내 말'), document.createTextNode(' '), el('span', '', item.text));
    fixed.append(el('span', 'label', '대본'), document.createTextNode(' '), el('b', '', item.fixed));
  } else {
    said.append(el('span', 'label', '내가 한 말'), document.createTextNode(' '), el('span', 'said-text', item.text));
    fixed.append(el('span', 'label', '고친 문장'), document.createTextNode(' '), el('b', '', item.fixed));
  }
  card.append(said, fixed);
  if (item.shadowing) card.append(el('span', 'tag', '쉐도잉'));
  else if (item.tag) card.append(el('span', 'tag', item.tag));

  if (item.correction) {
    const explain = button('explain', '▸ 설명');
    explain.setAttribute('aria-expanded', 'false');
    card.append(explain, fold('explain-body', el('p', '', item.correction)));
  }

  const actions = el('div', 'actions');
  const result = el('p', 'review-result', NBSP);
  // Holds its row while empty (R5); startRespeak shows and hides it by class.
  result.dataset.hold = '1';
  setShown(result, false);
  actions.append(
    button('play btn-stable', PLAY_LABEL),
    button('speak btn-stable', '🎤 말해보기'),
    button('skip', '다음에'),
    result,
  );
  card.append(actions);
  return card;
}

export function toggleExplain(card) {
  const body = find(card, 'explain-body');
  const btn = find(card, 'explain');
  if (!body) return;
  const open = body.classList.toggle('is-collapsed') === false;
  if (btn) btn.setAttribute('aria-expanded', String(open));
}

export async function playReview(item, btn) {
  // The app's own voice into a listening mic could pass the review for the
  // learner: a card whose 말해보기 is listening plays nothing.
  if (btn.disabled || isListening(cardOf(btn))) return;
  btn.disabled = true;
  btn.textContent = '음성 준비 중...';
  try {
    let key = null;
    try {
      ({ audio_key: key } = await postJSON(`/review/${item.id}/audio`, {}));
    } catch {
      key = null;   // play(null, …) is the browser's voice
    }
    play(key || null, item.fixed);
  } finally {
    // A listen started meanwhile keeps it asleep.
    btn.disabled = isListening(cardOf(btn));
    btn.textContent = PLAY_LABEL;
  }
}

/* The same re-speak, and the same verdict, as the session screen's chip.
   startRespeak writes its own 듣는 중... / 받아쓰는 중... / comparison into the
   result line; the verdict below overwrites that. Resolves once the verdict
   is handled, the listen is cancelled, or the re-speak was refused
   (startRespeak says why).

   While it listens the card is busy: 듣기 would play the app's own voice into
   the mic, and 다음에 would save a skip the verdict then contradicts. Both
   are disabled and refused until the attempt is over, whatever the outcome. */
export function speakReview(item, card, respeak = startRespeak) {
  // A card whose result is being saved, or that is on its way out, takes no
  // second attempt.
  if (card.inert) return Promise.resolve();
  const resultEl = find(card, 'review-result');
  const btn = find(card, 'speak');
  if (isListening(card)) {
    // This press is 그만 말하기: startRespeak stops its own listen, and the
    // attempt already running still delivers the verdict.
    respeak(item.fixed, resultEl, btn, null, { busy: BUSY });
    return Promise.resolve();
  }
  const token = loadToken;
  return new Promise((resolve) => {
    let over = false;
    const finish = () => {
      if (over) return false;
      over = true;
      setListening(card, false);
      return true;
    };
    setListening(card, true);
    const started = respeak(item.fixed, resultEl, btn, (good) => {
      if (!finish()) return;
      judged(item, card, resultEl, good, btn, token).finally(resolve);
    }, { busy: BUSY, onCancel: () => { if (finish()) resolve(); } });
    if (!started && finish()) resolve();
  });
}

function isListening(card) {
  return Boolean(card && card.dataset.listening === '1');
}

function setListening(card, on) {
  card.dataset.listening = on ? '1' : '';
  for (const cls of ['play', 'skip']) {
    const b = find(card, cls);
    if (b) b.disabled = on;
  }
}

/* The card a button sits in (dom-shim has no closest). */
function cardOf(node) {
  let n = node;
  while (n && !(n.classList && n.classList.contains('review-card'))) n = n.parentNode;
  return n || null;
}

async function judged(item, card, resultEl, good, btn = null, token = loadToken) {
  const say = (words, tone) => {
    setShown(resultEl, true);
    resultEl.classList.remove('good', 'bad');
    if (tone) resultEl.classList.add(tone);
    resultEl.textContent = words;
  };
  if (good === null) {
    say('못 알아들었어요. 다시 해보세요');
    return;
  }
  let saved;
  // Asleep while the result is out, so a quick second press cannot save a
  // second one.
  card.inert = true;
  try {
    saved = await postJSON(`/review/${item.id}/result`, { result: good ? 'pass' : 'fail' });
  } catch (err) {
    if (gone(err, card, token)) return;
    wake(card, btn);
    notify('복습 결과를 저장하지 못했어요');
    return;
  }
  if (!good) {
    wake(card, btn);
    say('조금 달라요. 내일 다시 볼게요', 'bad');
    return;
  }
  // A reload since has its own counts, which already include this pass.
  if (saved.mastered && reviewCounts && token === loadToken) reviewCounts.mastered += 1;
  say(saved.mastered ? '익혔어요 🎉' : `좋아요! ${saved.interval_d}일 뒤에 다시 볼게요`, 'good');
  // Done with: it stays asleep while it waits to go.
  const fadeAt = reducedMotion() ? PASS_HOLD_MS : PASS_HOLD_MS - LEAVE_MS;
  setTimeout(() => { removeCard(card, token); }, fadeAt);
}

/* Asleep (inert) drops focus from the card; the learner's place comes back
   to the 말해보기 they pressed. */
function wake(card, btn) {
  card.inert = false;
  if (btn) btn.focus();
}

/* A 404: the review is not there any more (undone with its turn, say).
   Waking the card would only fail again, so it leaves the list. */
function gone(err, card, token) {
  if (!err || err.status !== 404) return null;
  return removeCard(card, token);
}

export async function skipReview(item, card) {
  if (card.inert || isListening(card)) return;
  const token = loadToken;
  card.inert = true;
  try {
    await postJSON(`/review/${item.id}/result`, { result: 'skip' });
  } catch (err) {
    const removal = gone(err, card, token);
    if (removal) {
      await removal;
      return;
    }
    card.inert = false;
    notify('복습 결과를 저장하지 못했어요');
    return;
  }
  await removeCard(card, token);
}

/* Fades the card out, then takes it off the list and counts it down (R8);
   under reduced motion it goes at once. A card from an earlier load (`token`)
   counts nothing down: the list it belonged to has been replaced. */
function removeCard(card, token = loadToken) {
  const done = () => {
    if (!card.parentNode || token !== loadToken) return;
    card.remove();
    reviewItems.delete(card.dataset.id);
    reviewLeft = Math.max(0, reviewLeft - 1);
    reviewDone += 1;
    paintReviewHead();
    if (reviewLeft === 0) paintReviewEmpty();
    else paintReviewLimit();
  };
  if (reducedMotion()) {
    done();
    return Promise.resolve();
  }
  card.classList.add('fade', 'is-invisible');
  return new Promise((resolve) => setTimeout(() => { done(); resolve(); }, LEAVE_MS));
}

/* main.js's delegated click on #review-list. */
export function onReviewClick(e) {
  const card = e.target.closest('.review-card');
  const item = card && reviewItems.get(card.dataset.id);
  if (!item) return;
  const pressed = e.target.closest('button');
  if (!pressed) return;
  if (pressed.classList.contains('play')) playReview(item, pressed);
  else if (pressed.classList.contains('speak')) speakReview(item, card);
  else if (pressed.classList.contains('skip')) skipReview(item, card);
  else if (pressed.classList.contains('explain')) toggleExplain(card);
}

/* ---------- weak spots ---------- */

export function renderTags(tags, accuracy) {
  const line = $('accuracy-line');
  const graded = accuracy ? accuracy.graded : 0;
  if (graded > 0) {
    line.textContent = `문장 정확도 ${Math.round((accuracy.correct / graded) * 100)}% · 최근 30일 채점된 ${graded}문장`;
    setShown(line, true);
  } else {
    line.textContent = NBSP;
    setShown(line, false);
  }
  const bars = $('tag-bars');
  if (!tags || !tags.length) {
    bars.replaceChildren(el('p', 'hint', '아직 틀린 문장이 없어요'));
    return;
  }
  const max = Math.max(...tags.map((t) => t.n));
  bars.replaceChildren(...tags.map((t) => {
    const item = el('div', 'tag-item');
    const examples = t.examples || [];
    // Only a bar with sentences behind it is a button: one with nothing to
    // open would be a press that does nothing.
    const bar = examples.length ? button('tag-bar', '') : el('div', 'tag-bar');
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${(t.n / max) * 100}%`;
    track.append(fill);
    bar.append(el('span', 'name', t.tag), track, el('span', 'n', `${t.n}회${examples.length ? ' ▸' : ''}`));
    item.append(bar);
    if (examples.length) {
      bar.setAttribute('aria-expanded', 'false');
      item.append(fold('tag-examples', ...examples.map(tagExample)));
    }
    return item;
  }));
}

/* 내 말 / 고친 문장 / why -- own class names: .said elsewhere (the report's
   .fix-row) strikes its text through, and the learner's words are not wrong
   to look at here. */
function tagExample(e) {
  const box = el('div', 'tag-ex');
  box.append(labelled('tag-ex-mine', '내 말', e.text), labelled('tag-ex-fixed', '고친 문장', e.fixed || ''));
  if (e.correction) box.append(button('tag-ex-why', e.correction));
  return box;
}

/* A space between label and sentence, as on the review cards: copied text
   and a screen reader must not run them into one word. */
function labelled(cls, label, value) {
  const p = el('p', cls);
  p.append(el('span', 'tag-ex-label', label), document.createTextNode(' '), el('span', 'tag-ex-text', value));
  return p;
}

export function toggleTagItem(item) {
  const box = find(item, 'tag-examples');
  const head = find(item, 'tag-bar');
  if (!box) return;
  const open = box.classList.toggle('is-collapsed') === false;
  if (head) head.setAttribute('aria-expanded', String(open));
  // ▸ closed, ▾ open: the same width, so the count does not shift.
  const n = head && find(head, 'n');
  if (n) n.textContent = n.textContent.replace(open ? '▸' : '▾', open ? '▾' : '▸');
}

/* main.js's delegated click on #tag-bars: a bar folds its sentences open, a
   clipped why opens to its full length. */
export function onTagClick(e) {
  const why = e.target.closest('.tag-ex-why');
  if (why) { why.classList.toggle('is-open'); return; }
  const item = e.target.closest('.tag-item');
  if (item && e.target.closest('.tag-bar')) toggleTagItem(item);
}

/* ---------- the coach ---------- */

/* Not part of paintSkeletons/setRefreshing: it has its own wait, started only
   when 약점 is shown. */
const COACH_WAIT = '코치가 최근 문장을 읽는 중이에요 · 10~20초';
let coachFor = '';     // `${loadToken}:${language}` the coach was asked for
let coachCall = 0;     // the latest ask: a 다시 시도 outruns one still out

export async function loadCoach({ force = false } = {}) {
  const lang = state.language;
  const token = loadToken;
  const key = `${token}:${lang}`;
  if (!force && coachFor === key) return;
  coachFor = key;
  const call = ++coachCall;
  const stale = () => token !== loadToken || state.language !== lang || call !== coachCall;
  const body = $('coach-body');
  $('coach-day').textContent = '';
  // Two skeleton items built from the real item's classes, the wait words
  // over the first: the block is the height of a two-item answer throughout.
  body.replaceChildren(loadingNote(COACH_WAIT), ...[0, 1].map(coachSkeleton));
  body.setAttribute('aria-busy', 'true');
  try {
    const c = await getJSON(`/mypage/coach?language=${lang}`);
    if (stale()) return;
    if (c.status === 'too_few') {
      body.replaceChildren(el('p', 'hint', `최근 30일 틀린 문장이 ${c.need}개 모이면 코치가 짚어 줘요 (지금 ${c.count}개)`));
    } else {
      body.replaceChildren(...(c.items || []).map(coachItem));
      $('coach-day').textContent = '오늘 만듦';
    }
  } catch {
    if (stale()) return;
    coachFor = '';     // the next look at 약점 asks again
    const row = el('div', 'coach-fail');
    row.append(el('p', 'mypage-error', '코치 한마디를 만들지 못했어요'), button('coach-retry', '다시 시도'));
    body.replaceChildren(row);
  } finally {
    if (!stale()) {
      body.removeAttribute('aria-busy');
      // 다시 시도 was pressed and is gone with what it replaced: focus goes to
      // the answer (tabindex="-1"), not back to the page's start.
      if (force) body.focus();
    }
  }
}

function coachItem(i) {
  const box = el('div', 'coach-item');
  box.append(el('p', 'coach-habit', i.habit), el('p', 'coach-tip', `→ ${i.tip}`),
             labelled('tag-ex-mine', '내 말', i.said), labelled('tag-ex-fixed', '고친 문장', i.fixed));
  return box;
}

function coachSkeleton() {
  const box = el('div', 'coach-item is-skeleton');
  box.append(skeletonLine('p', 'coach-habit'), skeletonLine('p', 'coach-tip'),
             skeletonLine('p', 'tag-ex-mine'), skeletonLine('p', 'tag-ex-fixed'));
  return box;
}

/* ---------- 성장: the summary card ---------- */

/* Loaded with the rest of the page (openMypage), under the same load token
   and language: a first load holds summarySkeleton, the calendar's own box
   and the card's lines; a reload dims what is painted (SECTIONS) and
   replaces it in place. The charts wait under 자세히 보기 and are drawn when
   the fold is open -- the first time it is opened for this answer, or at
   once when the answer lands with it already open -- at the width they are
   shown at. */
let growthData = null;      // the answer on the card, for the fold to draw
let growthDrawn = false;    // renderDetails has run for growthData
let growthCall = 0;         // the latest ask: a 다시 시도 outruns one still out

/* The width the charts are drawn at: the card body's own. dom-shim has none,
   so a sensible default. */
function growthWidth() {
  const w = Number($('growth-body').clientWidth) || 0;
  return w > 0 ? w : 560;
}

function growthOpen() {
  return $('btn-growth-more').getAttribute('aria-expanded') === 'true';
}

export async function loadGrowth({ force = false } = {}) {
  const lang = state.language;
  const token = loadToken;
  const call = ++growthCall;
  const stale = () => token !== loadToken || state.language !== lang || call !== growthCall;
  const body = $('growth-body');
  const more = $('btn-growth-more');
  if (force) {
    // 다시 시도: the failure row goes, the card's own skeleton holds its room.
    body.replaceChildren(loadingNote(GROWTH_TEXT.wait), ...summarySkeleton(growthWidth()));
    body.setAttribute('aria-busy', 'true');
    setShown(more, false);
  }
  try {
    const g = await getJSON(`/stats/growth?language=${lang}`);
    if (stale()) return;
    growthData = g;
    growthDrawn = false;
    body.replaceChildren(...renderSummary(g, growthWidth()));
    if (hasPractice(g)) {
      setShown(more, true);
      setGrowthOpen(growthOpen());      // its label, from the fold's state
      if (growthOpen()) drawDetails();
      else $('growth-details-body').replaceChildren();
    } else {
      // Nothing under the fold but four empty states: no 자세히 보기.
      setGrowthOpen(false);
      more.hidden = true;
    }
  } catch {
    if (stale()) return;
    growthData = null;
    setGrowthOpen(false);
    more.hidden = true;
    const row = el('div', 'growth-fail');
    row.append(el('p', 'mypage-error', FAILED), button('growth-retry', '다시 시도'));
    body.replaceChildren(row);
  } finally {
    if (!stale()) {
      settle('growth-card');
      body.removeAttribute('aria-busy');
      if (force) body.focus();
    }
  }
}

function drawDetails() {
  if (!growthData || growthDrawn) return;
  growthDrawn = true;
  const inner = $('growth-details-body');
  const w = Number(inner.clientWidth) || growthWidth();
  inner.replaceChildren(...renderDetails(growthData, w));
}

function setGrowthOpen(open) {
  const more = $('btn-growth-more');
  more.setAttribute('aria-expanded', String(open));
  more.textContent = open ? GROWTH_TEXT.less : GROWTH_TEXT.more;
  $('growth-details').classList.toggle('is-collapsed', !open);
}

/* main.js's #btn-growth-more: 자세히 보기 ▾ opens the fold (drawing the
   charts the first time, once it is open and has its width), 접기 ▴ shuts it. */
export function toggleGrowthDetails() {
  const open = !growthOpen();
  setGrowthOpen(open);
  if (open) drawDetails();
}

/* ---------- history ---------- */

export async function loadHistory({ append = false } = {}) {
  const lang = state.language;
  const token = loadToken;
  const stale = () => token !== loadToken || state.language !== lang;
  const list = $('history-list');
  const more = $('btn-history-more');
  // Only real rows count -- the first load's skeleton rows have no id.
  const offset = append ? Array.from(list.children).filter((c) => c.dataset.id).length : 0;
  if (append) {
    more.disabled = true;
    more.textContent = LOADING;
  }
  try {
    const page = await getJSON(`/sessions/history?language=${lang}&offset=${offset}`);
    if (stale()) return;
    const rows = (page.items || []).map(historyRow);
    if (append) list.append(...rows);
    else list.replaceChildren(...rows);
    if (!append && !rows.length) list.replaceChildren(el('li', 'hint history-empty', '아직 끝낸 세션이 없어요'));
    setShown(more, Boolean(page.more));
    if (!append) settle('history-section');
  } catch {
    if (stale()) return;
    if (append) {
      notify('기록을 더 불러오지 못했어요');
    } else {
      setShown(more, false);
      list.replaceChildren(el('li', 'mypage-error', FAILED));
      settle('history-section');
    }
  } finally {
    if (append) {
      more.disabled = false;
      more.textContent = MORE_LABEL;
    }
  }
}

function historyRow(item) {
  const li = el('li', 'history-row');
  li.dataset.id = String(item.id);
  const when = new Date(item.ended_at);
  const date = Number.isNaN(when.getTime()) ? '' : `${when.getMonth() + 1}월 ${when.getDate()}일`;
  const head = button('history-head', '');
  head.setAttribute('aria-expanded', 'false');
  head.append(
    el('span', 'main', `${date} · ${item.title} · ${modeName(item)}`),
    el('span', 'sub', historySub(item)),
  );
  const row = el('div', 'history-buttons');
  row.append(button('report', '리포트 보기'), button('transcript', '대화 보기'));
  const status = el('span', 'history-status hint', LOADING);
  setShown(status, false);
  row.append(status);
  const slot = el('div', 'history-slot fold is-collapsed');
  slot.append(el('div', 'fold-inner'));
  li.append(head, fold('history-actions', row, slot));
  return li;
}

/* A session none of whose turns was graded (an old one, or grading was down
   throughout) has no 고친 곳 to count: 0 would read as a flawless session. */
function historySub(item) {
  if (item.shadowing) return `따라 한 줄 ${item.turns} · 쉐도잉`;
  if (item.mode === 'script') return `말한 문장 ${item.turns} · 대본`;
  // 1분 말하기 counts rounds, not turns: one round is a minute of speaking.
  if (item.mode === 'timed') {
    const rounds = item.rounds ?? 0;
    return item.graded === 0 ? `${rounds}회` : `${rounds}회 · 고친 곳 ${item.wrong}`;
  }
  if (item.graded === 0) return `말한 문장 ${item.turns}`;
  return `말한 문장 ${item.turns} · 고친 곳 ${item.wrong}`;
}

export function toggleHistoryRow(row) {
  const actions = find(row, 'history-actions');
  const head = find(row, 'history-head');
  if (!actions) return;
  const open = actions.classList.toggle('is-collapsed') === false;
  if (head) head.setAttribute('aria-expanded', String(open));
}

/* main.js's delegated click on #history-list. */
export function onHistoryClick(e) {
  const row = e.target.closest('.history-row');
  if (!row || !row.dataset.id) return;
  const pressed = e.target.closest('button');
  if (!pressed) return;
  if (pressed.classList.contains('history-head')) toggleHistoryRow(row);
  else if (pressed.classList.contains('report')) openReport(Number(row.dataset.id));
  else if (pressed.classList.contains('transcript')) openTranscript(Number(row.dataset.id), find(row, 'history-slot'));
}

/* my page's ← 홈. A listen on a review card would otherwise run on behind
   the home screen and save a verdict nobody saw: thrown away, as 취소. */
export function leaveMypage() {
  if (canDo('cancel')) cancelTurn();
  router.show('home');
}

export async function openReport(sessionId) {
  // One at a time: a second press while the first is out asks nothing more.
  if (reportOut) return;
  reportOut = true;
  const token = loadToken;
  const row = Array.from($('history-list').children).find((c) => c.dataset.id === String(sessionId));
  const status = row ? find(row, 'history-status') : null;
  if (status) {
    status.textContent = LOADING;
    setShown(status, true);
  }
  try {
    const data = await getJSON(`/sessions/${sessionId}/report`);
    // The learner left, or my page loaded again, while it was on its way:
    // pulling them onto the report now would be a jump they did not ask for.
    if (router.current() !== 'mypage' || token !== loadToken) {
      if (status) setShown(status, false);
      return;
    }
    router.show('report');
    // renderReport reads state.mode, synchronously; a session still open
    // underneath reads it too (sendHeard), so it gets its own mode back.
    const mode = state.mode;
    state.mode = data.mode;
    try {
      renderReport(data);
    } finally {
      state.mode = mode;
    }
    $('btn-report-back').hidden = false;
    if (status) setShown(status, false);
  } catch {
    if (status) status.textContent = FAILED;
  } finally {
    reportOut = false;
  }
}

/* The conversation, folded open under the row; a second press folds it away.
   Plain text on both sides -- no reading aids here. */
export async function openTranscript(sessionId, slot) {
  if (!slot.classList.contains('fold')) slot.classList.add('fold', 'is-collapsed');
  let inner = find(slot, 'fold-inner');
  if (!inner) {
    inner = el('div', 'fold-inner');
    slot.append(inner);
  }
  if (slot.dataset.open === '1') {
    slot.dataset.open = '';
    slot.classList.add('is-collapsed');
    return;
  }
  slot.dataset.open = '1';
  inner.replaceChildren(el('p', 'hint', LOADING));
  slot.classList.remove('is-collapsed');
  try {
    const { messages } = await getJSON(`/sessions/${sessionId}`);
    const lines = el('ul', 'transcript');
    for (const m of messages || []) {
      const li = el('li', m.speaker === 'user' ? 'user' : 'bot', m.text);
      lines.append(li);
      if (m.speaker === 'user' && m.fixed && m.ok === 0) lines.append(el('li', 'user fix', `→ ${m.fixed}`));
    }
    inner.replaceChildren(lines);
  } catch {
    inner.replaceChildren(el('p', 'mypage-error', FAILED));
  }
}

/* ---------- helpers ---------- */

/* Opens and shuts by class (grid rows 0fr -> 1fr, see .fold in
   components.css), the same way the correction chip's detail does. */
function fold(cls, ...children) {
  const outer = el('div', `${cls} fold is-collapsed`);
  const inner = el('div', 'fold-inner');
  inner.append(...children);
  outer.append(inner);
  return outer;
}

function button(cls, label) {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

function findTag(node, tag) {
  for (const c of node.children || []) {
    if (c.tagName === tag) return c;
    const hit = findTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

function find(node, cls) {
  if (node.classList && node.classList.contains(cls)) return node;
  for (const c of node.children || []) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
