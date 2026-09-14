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

const LEVEL_NAMES = { beginner: '초급', intermediate: '중급', advanced: '고급' };
const MODE_NAMES = { script: '스크립트', free: '자유 상황극', lesson: '수업' };
const LOADING = '불러오는 중...';
const FAILED = '불러오지 못했어요';
const PLAY_LABEL = '▶ 듣기';
const MORE_LABEL = '더 보기';
// A passed card stays this long, result and all, before it is gone from the
// list -- its fade is the last LEAVE_MS of it.
const PASS_HOLD_MS = 1500;
// A placeholder line needs a character to be a line at all.
const NBSP = String.fromCharCode(0xa0);

const SECTIONS = ['level-card', 'review-section', 'weak-section', 'history-section'];
const BUSY = '지금은 다른 연습이 진행 중이에요';

// Bumped by every openMypage. A language check alone cannot tell en -> ja ->
// en apart, nor a 더 보기 still out when the page is opened again; an answer
// from any load but the latest is not painted.
let loadToken = 0;

let reviewItems = new Map();     // id -> item, for main.js's delegated clicks
let reviewCounts = null;         // { due, mastered } from /stats/mypage, or null
let reviewLeft = 0;              // cards still on the list

/* ---------- opening ---------- */

export async function openMypage() {
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
      $('review-mastered').textContent = '';
      fail('review-section', $('review-list'));
    },
  );
  const history = loadHistory({ append: false });

  await Promise.all([level, weak, review, history]);
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

  $('level-body').replaceChildren(loadingNote(),
    skeletonLine('p', 'level-value'), skeletonLine('p', 'level-note'));

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

function loadingNote() {
  const note = el('div', 'mypage-loading');
  const dots = el('div', 'thinking');
  dots.append(el('i'), el('i'), el('i'));
  note.append(dots, el('span', '', LOADING));
  return note;
}

/* ---------- level ---------- */

export function renderLevel(level) {
  const body = $('level-body');
  if (level && level.value) {
    body.replaceChildren(
      el('p', 'level-value', `지금 레벨 ${LEVEL_NAMES[level.value] || level.value}`),
      el('p', 'level-note', '최근 세션들에서 가장 많이 나온 판정이에요'),
    );
    return;
  }
  // Stops at the target: 세션 5/3 next to 발화 9/15 reads as a typo.
  const needSessions = level?.need_sessions ?? 3;
  const needUtterances = level?.need_utterances ?? 15;
  const sessions = Math.min(level?.sessions ?? 0, needSessions);
  const utterances = Math.min(level?.utterances ?? 0, needUtterances);
  body.replaceChildren(
    el('p', 'level-value', '판정하기엔 아직 일러요'),
    el('p', 'level-note', `세션 ${sessions}/${needSessions} · 발화 ${utterances}/${needUtterances}`),
  );
}

/* ---------- today's review ---------- */

export function renderReviewList(items, counts) {
  reviewItems = new Map(items.map((item) => [String(item.id), item]));
  reviewCounts = counts ? { ...counts } : null;
  reviewLeft = items.length;
  paintReviewHead();
  const list = $('review-list');
  if (!items.length) {
    paintReviewEmpty();
    return;
  }
  list.replaceChildren(...items.map(reviewCard));
}

function paintReviewHead() {
  $('review-count').textContent = `오늘의 복습 ${reviewLeft}개`;
  const mastered = reviewCounts ? reviewCounts.mastered : 0;
  $('review-mastered').textContent = mastered > 0 ? `익힌 문장 ${mastered}개` : '';
}

function paintReviewEmpty() {
  const empty = el('div', 'review-empty');
  empty.append(el('p', '', '오늘 복습할 문장이 없어요'));
  if (reviewCounts && reviewCounts.mastered === 0 && reviewCounts.due === 0) {
    empty.append(el('p', 'hint', '대화에서 고친 문장이 여기 모여요'));
  }
  $('review-list').replaceChildren(empty);
}

function reviewCard(item) {
  const card = el('div', 'review-card');
  card.dataset.id = String(item.id);

  // A space between label and sentence, so they never read as one word
  // (copied text, a screen reader, or a stylesheet that drops the margin).
  const said = el('p', 'said');
  said.append(el('span', 'label', '내가 한 말'), document.createTextNode(' '), el('s', '', item.text));
  const fixed = el('p', 'fixed');
  fixed.append(el('span', 'label', '고친 문장'), document.createTextNode(' '), el('b', '', item.fixed));
  card.append(said, fixed);
  if (item.tag) card.append(el('span', 'tag', item.tag));

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
  if (btn.disabled) return;
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
    btn.disabled = false;
    btn.textContent = PLAY_LABEL;
  }
}

/* The same re-speak, and the same verdict, as the session screen's chip.
   startRespeak writes its own 듣는 중... / 받아쓰는 중... / comparison into the
   result line; the verdict below overwrites that. Resolves once the verdict
   is handled -- never, if the re-speak was refused (startRespeak says why). */
export function speakReview(item, card, respeak = startRespeak) {
  // A card whose result is being saved, or that is on its way out, takes no
  // second attempt.
  if (card.inert) return Promise.resolve();
  const resultEl = find(card, 'review-result');
  const btn = find(card, 'speak');
  return new Promise((resolve) => {
    respeak(item.fixed, resultEl, btn, (good, spoken) => {
      judged(item, card, resultEl, good, spoken).finally(resolve);
    }, { busy: BUSY });
  });
}

async function judged(item, card, resultEl, good) {
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
  } catch {
    card.inert = false;
    notify('복습 결과를 저장하지 못했어요');
    return;
  }
  if (!good) {
    card.inert = false;
    say('조금 달라요. 내일 다시 볼게요', 'bad');
    return;
  }
  if (saved.mastered && reviewCounts) reviewCounts.mastered += 1;
  say(saved.mastered ? '익혔어요 🎉' : `좋아요! ${saved.interval_d}일 뒤에 다시 볼게요`, 'good');
  // Done with: it stays asleep while it waits to go.
  const fadeAt = reducedMotion() ? PASS_HOLD_MS : PASS_HOLD_MS - LEAVE_MS;
  setTimeout(() => { removeCard(card); }, fadeAt);
}

export async function skipReview(item, card) {
  if (card.inert) return;
  card.inert = true;
  try {
    await postJSON(`/review/${item.id}/result`, { result: 'skip' });
  } catch {
    card.inert = false;
    notify('복습 결과를 저장하지 못했어요');
    return;
  }
  await removeCard(card);
}

/* Fades the card out, then takes it off the list and counts it down (R8);
   under reduced motion it goes at once. */
function removeCard(card) {
  const done = () => {
    if (!card.parentNode) return;
    card.remove();
    reviewItems.delete(card.dataset.id);
    reviewLeft = Math.max(0, reviewLeft - 1);
    paintReviewHead();
    if (reviewLeft === 0) paintReviewEmpty();
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
    const bar = el('div', 'tag-bar');
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${(t.n / max) * 100}%`;
    track.append(fill);
    bar.append(el('span', 'name', t.tag), track, el('span', 'n', `${t.n}회`));
    return bar;
  }));
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
    el('span', 'main', `${date} · ${item.title} · ${MODE_NAMES[item.mode] || item.mode}`),
    el('span', 'sub', item.mode === 'script'
      ? `말한 문장 ${item.turns} · 대본`
      : `말한 문장 ${item.turns} · 고친 곳 ${item.wrong}`),
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

export async function openReport(sessionId) {
  const row = Array.from($('history-list').children).find((c) => c.dataset.id === String(sessionId));
  const status = row ? find(row, 'history-status') : null;
  if (status) {
    status.textContent = LOADING;
    setShown(status, true);
  }
  try {
    const data = await getJSON(`/sessions/${sessionId}/report`);
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
