/* The home screen: today's recommendation and target sentence, the five mode tiles, 이어서 하기,
   내 상태 (the week, the level), and the recent themes. Named in the Phase 2 design
   (docs/superpowers/specs/2026-08-29-monologue-phase2-design.md:325) as its own
   module and split out of session.js, which had grown to four screens. The
   dashboard itself is docs/superpowers/specs/2026-09-14-monologue-home-dashboard-design.md.
   What to practise in a mode -- the wish, the themes, 시작 -- lives on the pick
   screen (pick.js); a start button here only names a theme, and main.js hands
   it to pick.startTheme.

   The dependency runs one way only: home.js imports addMessage from session.js,
   because resuming hands off to the session screen, and pick.js imports the
   start/resume guard from here. session.js must never import from either --
   the moment it does, they are one module again with an import statement
   between them. home.js must not import pick.js either (that would close a
   cycle), which is why the start buttons are wired in main.js. */
import { $, getJSON, postJSON, state, notify, setShown, syncLanguageButtons } from './api.js';
import { play } from './audio.js';
import * as router from './router.js';
import { addMessage } from './session.js';
import { setSuggestVisible } from './suggest.js';
// leveltest.js imports none of home, pick or session, so this closes no cycle.
import { renderLevelResult, levelName, RESULT_TEXT } from './leveltest.js';

// Filled by loadHome (Task 8) once a resumable session is found; read by
// resumeSession (Task 8). Declared here, ahead of either function, so a
// module that only defines one of the two never references an identifier
// the other half hasn't declared yet.
let resumeTarget = null;

// The home review card's due sentence, set by renderReviewHome and read by
// playReviewHome -- same shape and same reason as resumeTarget above.
let reviewFirst = null;

// 오늘의 목표 문장 as last painted ({id, tag, text, fixed}), read by
// playTargetHome -- same shape and reason as reviewFirst.
let target = null;

// This language's latest level test result as the last load found it: the
// result itself, null (none yet), or undefined (unknown -- the request
// failed). Read by showLevelResultHome.
let levelResult;

const GOAL_MIN = 1;
const GOAL_MAX = 14;
const START_LABELS = { script: '스크립트로 시작', free: '자유 대화로 시작' };
const MODE_NAMES = { script: '스크립트', free: '자유 상황극', lesson: '수업', timed: '1분 말하기' };

// Reads an item off /stats/home's `recent_themes` (renderRecentThemes below).
// A shadowing session there is stored as a flagged script session -- its
// `mode` is still "script" -- so MODE_NAMES alone would call it 스크립트;
// `shadowing` (added by app/api.py's _recent_themes) always wins instead.
// Same rule as mypage.js's modeName(); not shared -- the two screens have no
// other reason to move together.
function modeName(item) {
  return item.shadowing ? '쉐도잉' : (MODE_NAMES[item.mode] || item.mode);
}
const REVIEW_PLAY_LABEL = '▶ 듣기';
const TARGET_PLAY_LABEL = '▶ 들어 보기';
const PREPARING = '음성 준비 중...';
// Tile order in index.html's #modes; the key a recent theme is filed under.
const TILE_MODES = ['free', 'script', 'shadow', 'lesson', 'timed'];
const tileMode = (item) => (item.shadowing ? 'shadow' : item.mode);
// The goal ring's circumference: r = 34 in index.html's #week-ring.
const RING_C = 2 * Math.PI * 34;
// A placeholder line needs a character to be a line at all: an empty or
// space-only <p> is zero tall.
const NBSP = String.fromCharCode(0xa0);   // a no-break space

let today = [];            // [current, alternative?] -- swapToday trades them
let week = null;           // { days, sessions, goal } as last painted, or null
let streak = 0;
let accuracy = null;       // { correct, graded } from /stats/home, or null
let savingGoal = false;    // POST /settings/weekly-goal is out

/* Everything on the home screen that depends on history. Fails quietly: a
   learner who wants to practise should never be stopped by a counter -- the
   mode cards are never hidden by anything here.

   `session.turns` here comes from GET /sessions/resumable, which counts
   *every* message in the session (bot and learner) -- not the same "turns"
   db.session_stats reports on the end-of-session screen, which counts only
   the learner's own messages. Relabelling this as "말한 횟수" (times you
   spoke) would overstate the learner's count by roughly double, since every
   learner line in a live conversation is followed by a bot reply. Getting
   the learner-only count would mean fetching this session's full message
   list just to count it, on a load that must stay best-effort and cheap --
   so instead this reads as a plain exchange count ("대화 N턴"), which is
   what the payload actually measures, rather than silently mislabelling it
   as effort. */
export async function loadHome() {
  // Captured at call time: two quick language-switch clicks start two
  // overlapping loads, and without this an older response that resolves last
  // would paint its (now wrong) language's data over the newer, correct one.
  const lang = state.language;
  const homeEl = $('home');
  // Nothing drawn yet: whatever this load reveals appears, it does not move in.
  const firstPaint = homeEl.dataset.painted !== '1';

  if (!firstPaint) {
    // Already drawn (a language switch, or ← 홈): nothing is hidden before the
    // request. Hiding the cards and showing them again moved the week card
    // 85px on every switch. They stay where they are and dim until the answer
    // is painted over them in place (spec R2).
    setRefreshing(true);
  } else {
    // The first load: placeholders the size of what is coming (spec R3). The
    // recommendation is what the screen leads with, so its slot also says it
    // is coming (the user's rule: a wait shows what it is). The week card
    // holds its place too; 이어서 하기 may or may not exist, so it stays
    // hidden -- it sits at the top of the right column and pushes nothing on
    // the left when it appears.
    hideHistory();
    setShown($('today-alt'), false);   // its row is held from the start (R5)
    $('today-card').hidden = false;
    $('today-body').replaceChildren(loadingNote(), ...todaySkeleton());
    // The target panel holds its place only when this language's last answer
    // had a target: most answers have none, and a held panel that then goes
    // away jumps the whole screen (on a phone, everything below it moves up
    // by the panel's height). No memory: no panel, the hero full width.
    if (hadTarget(lang)) targetSkeleton();
    weekSkeleton();
  }

  $('home-date').textContent = new Intl.DateTimeFormat('ko-KR', {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());

  try {
    const [{ session }, stats, latest] = await Promise.all([
      getJSON(`/sessions/resumable?language=${lang}`),
      getJSON(`/stats/home?language=${lang}`),
      // The level test card is a nicety on top of a nicety: a failure here
      // only means no card, never a home that did not load.
      getJSON(`/level-test/latest?language=${lang}`).catch(() => undefined),
    ]);

    if (state.language !== lang) return; // a newer switch already won

    setResumeShown(Boolean(session), { instant: firstPaint });
    resumeTarget = session || null;
    if (session) {
      $('resume-title').textContent = `이어서 하기 — ${session.title}`;
      $('resume-sub').textContent = `대화 ${session.turns}턴에서 멈췄습니다`;
    }

    renderReviewHome(stats.review, { instant: firstPaint });
    renderLevelTestHome(latest, lang, { instant: firstPaint });

    $('home-greeting').textContent = stats.has_history
      ? '오늘은 뭘 연습할까요?' : '첫 연습을 시작해 보세요';

    renderToday(stats.recommend);
    // "요즘 X에서 자주 걸립니다" said what the target panel now shows with the
    // sentence itself, so the line stays shut either way.
    $('recommend').hidden = true;
    renderTarget(stats.target);
    rememberTarget(lang, Boolean(target));

    // No numeric goal means the payload is not the one this card is drawn
    // from -- hide the card rather than invent a goal the learner never set.
    if (stats.has_history && stats.week && typeof stats.week.goal === 'number') {
      renderWeek(stats.week, stats.streak, stats.accuracy);
      renderLevel(latest);
      renderRecentThemes(stats.recent_themes);
    } else {
      // The content itself changed (no history under this language), so this
      // is the moment the card goes -- not before the request.
      week = null;
      clearWeekSkeleton();
      $('week-card').hidden = true;
      $('recent-themes-wrap').hidden = true;
      renderModeRecents([]);
    }

    renderLibraryProgress(stats.library);
    homeEl.dataset.painted = '1';
    homeEl.dataset.paintedLanguage = lang;
    setRefreshing(false);
  } catch {
    // history is a nicety -- never block the learner from starting. Only a
    // newer load may overrule this one, same as on the success path.
    if (state.language !== lang) return;
    setRefreshing(false);
    // What is on screen for this same language is still true, so it stays.
    // Anything else -- the first load's placeholders, or the previous
    // language's card and counters under the newly selected language button --
    // goes: a missing card is honest; a stale one silently lies, and the
    // learner has no way to tell the two apart.
    if (homeEl.dataset.painted === '1' && homeEl.dataset.paintedLanguage === lang) return;
    hideHistory();
    $('today-card').hidden = true;
    delete homeEl.dataset.painted;
    delete homeEl.dataset.paintedLanguage;
  } finally {
    // 성공·실패 두 경로 모두에서 마지막에 한 번. 오른쪽에 보이는 것이 하나도
    // 없는데 트랙만 남으면 화면이 왼쪽으로 쏠린 채 330px 가 빈다.
    syncAside();
  }
}

function hideHistory() {
  setResumeShown(false);
  setReviewHomeShown(false);
  setCollapsedShown($('leveltest-home'), false);
  $('today-alt').hidden = true;
  $('recommend').hidden = true;
  renderTarget(null);
  clearWeekSkeleton();
  $('week-card').hidden = true;
  $('recent-themes-wrap').hidden = true;
  renderModeRecents([]);
  $('library-progress').hidden = true;
}

/* Everything loadHome repaints from the response. Dimmed on the cards
   themselves rather than on .home-main/.home-aside: under 900px those two
   are `display: contents` (so the phone order can interleave their children),
   and opacity on a box-less element does nothing. The mode cards are not
   here -- they never depend on the request. */
const REFRESHED = ['today-card', 'today-alt', 'home-target', 'review-home', 'leveltest-home', 'recommend',
  'resume-card', 'week-card', 'recent-themes-wrap', 'library-progress'];

/* Dimmed also means asleep. After a language switch the cards still show the
   previous language; 계속 on that resume card (or a start button on that
   recommendation) would act on a language the buttons no longer show. `inert`
   takes them out of clicks, focus and the accessibility tree until the answer
   is painted; .is-refreshing's pointer-events: none is the belt for a browser
   without inert. A card that is also shut by its own collapse class (see
   setCollapsedShown below -- #resume-card, #review-home) stays inert even
   once the dim itself lifts. */
function setRefreshing(on) {
  for (const id of REFRESHED) {
    const card = $(id);
    card.classList.toggle('is-refreshing', on);
    card.inert = on || card.classList.contains('is-collapsed');
  }
  // The tiles themselves never depend on the request, but their 최근 lines
  // do: after a language switch they still name the previous language's
  // themes, so they dim with the cards until the answer repaints them.
  for (const mode of TILE_MODES) $(`mode-recent-${mode}`).classList.toggle('is-refreshing', on);
}

/* 이어서 하기 opens and shuts by class, never `hidden`, so CSS can slide it
   (see #resume-card.is-collapsed): a language with a session and one without
   no longer jump the week card by the card's height. A collapsed card is
   still in the tree, so it is also inert and aria-hidden -- its 계속 button
   must not be reachable while it is shut. */
function resumeCollapsed(card = $('resume-card')) {
  return card.id === 'resume-card' && card.classList.contains('is-collapsed');
}

/* Shared by #resume-card and #review-home: both exist only some of the time
   (a session to resume; a nonzero review count) and both used to pop in and
   out, jumping whatever sat below them by the card's own height. Both slide
   instead, by class, never `hidden` -- see their matching CSS in
   components.css.

   `instant`: the first paint's reveal. The card starts collapsed in the
   markup, so without it every fresh page load that finds content would slide
   the card open after the round trip -- new motion on first load. .no-motion
   turns the transition off, the offsetHeight read makes the browser apply the
   open state under it, and taking the class off afterwards leaves later
   language switches sliding as before. */
function setCollapsedShown(card, on, { instant = false } = {}) {
  card.hidden = false;
  if (instant) card.classList.add('no-motion');
  card.classList.toggle('is-collapsed', !on);
  if (instant) {
    void card.offsetHeight;
    card.classList.remove('no-motion');
  }
  card.setAttribute('aria-hidden', String(!on));
  card.inert = !on || card.classList.contains('is-refreshing');
}

function setResumeShown(on, opts) {
  setCollapsedShown($('resume-card'), on, opts);
}

function setReviewHomeShown(on, opts) {
  setCollapsedShown($('review-home'), on, opts);
}

/* ---------- 레벨 테스트 카드 ---------- */

export const LEVEL_TEST_CARD = {
  title: '레벨 테스트',
  en: '7분이면 내 수준과 IELTS·TOEFL 예상 점수를 알 수 있어요',
  ja: '7분이면 내 수준과 JF 스탠다드 레벨을 알 수 있어요',
};

export const LEVEL_TEST_DONE = {
  last: '지난 테스트',
  show: '결과 보기',
  retake: '다시 테스트',
  start: '시작',
};

/* `latest` is /level-test/latest's answer. `{result: null}` -- the server
   saying there is none -- offers a test; a result says when the last one was
   and what it gave, with 결과 보기 and 다시 테스트. No answer at all (the
   request failed, or a reply without `result`) keeps the card shut: a failed
   request is taken as neither "never tested" nor a level. 시작/다시 테스트
   and 결과 보기 are wired in main.js, like every start button on this screen. */
function renderLevelTestHome(latest, lang, { instant = false } = {}) {
  const known = Boolean(latest) && latest.result !== undefined;
  const result = known ? latest.result : undefined;
  levelResult = result;
  const text = $('leveltest-home-text');
  if (result) {
    const when = new Date(result.finished_at);
    const date = Number.isNaN(when.getTime()) ? '' : ` ${when.getMonth() + 1}월 ${when.getDate()}일`;
    text.replaceChildren(el('b', '', LEVEL_TEST_DONE.last),
      document.createTextNode(`${date} · ${levelName(result)}`));
  } else if (result === null) {
    text.replaceChildren(el('b', '', LEVEL_TEST_CARD.title),
      document.createTextNode(` · ${lang === 'ja' ? LEVEL_TEST_CARD.ja : LEVEL_TEST_CARD.en}`));
  }
  if (known) {
    $('leveltest-home-show').hidden = !result;
    $('leveltest-home-start').textContent = result ? LEVEL_TEST_DONE.retake : LEVEL_TEST_DONE.start;
    // 다시 테스트 is a second choice beside 결과 보기, not the card's one action.
    $('leveltest-home-start').classList.toggle('primary', !result);
    $('leveltest-home-start').classList.toggle('ghost', Boolean(result));
  }
  setCollapsedShown($('leveltest-home'), known, { instant });
}

/* 결과 보기: the result this load already has, drawn on the level test screen
   the way my page's 결과 보기 draws it (renderLevelResult), with 홈으로 to come
   back. A dimmed or shut card is asleep, as on every card here. */
export function showLevelResultHome() {
  if (!levelResult || $('leveltest-home').inert) return;
  renderLevelResult(levelResult, { from: 'home' });
}

/* Shaped like paintToday's card -- title line (the wait's own words sit
   there), situations, reason, the two start buttons -- using the same classes,
   so the placeholder is the height of what replaces it. */
function todaySkeleton() {
  const line = (cls) => {
    const p = el('p', `${cls} skeleton`);
    p.textContent = NBSP;
    return p;
  };
  const chips = el('ul', 'today-situations');
  chips.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) chips.append(el('li', 'skeleton today-skel-chip', NBSP));
  const actions = el('div', 'today-actions');
  actions.append(el('span', 'skeleton today-skel-btn'), el('span', 'skeleton today-skel-btn'));
  actions.setAttribute('aria-hidden', 'true');
  return [chips, line('today-reason'), actions];
}

/* The target panel on a first load: its own lines as blank placeholders, so
   the hero is already split the way a target will split it. */
function targetSkeleton() {
  const panel = $('home-target');
  panel.hidden = false;
  panel.setAttribute('aria-busy', 'true');
  $('home-hero').classList.add('has-target');
  for (const id of ['home-target-tag', 'home-target-fixed']) {
    $(id).textContent = NBSP;
    $(id).classList.add('skeleton');
  }
  setShown($('home-target-play'), false);   // its row is held: .is-invisible, not hidden
}

/* Whether this language's last answer had a target -- a per-viewer
   convenience in localStorage, only ever used to decide whether the first
   paint holds the panel's place. Storage that throws (a private window,
   blocked site data) or is missing reads as "no". */
const TARGET_KEY = (lang) => `home-target-${lang}`;

function hadTarget(lang) {
  try { return globalThis.localStorage?.getItem(TARGET_KEY(lang)) === '1'; } catch { return false; }
}

function rememberTarget(lang, has) {
  try { globalThis.localStorage?.setItem(TARGET_KEY(lang), has ? '1' : '0'); } catch { /* fine */ }
}

function clearTargetSkeleton() {
  const panel = $('home-target');
  panel.removeAttribute('aria-busy');
  for (const id of ['home-target-tag', 'home-target-fixed']) $(id).classList.remove('skeleton');
  setShown($('home-target-play'), true);
}

/* The week card on a first load: seven day cells built like paintWeek's (a
   blank label and the dot) and a one-line progress bar, so the right column
   is already its final height. The goal stepper keeps its space but is not
   shown (see #week-card.is-skeleton in components.css) -- there is no goal
   to step yet. */
function weekSkeleton() {
  const card = $('week-card');
  card.hidden = false;
  card.classList.add('is-skeleton');
  card.setAttribute('aria-busy', 'true');
  const days = $('week-days');
  days.replaceChildren();
  for (let i = 0; i < 7; i += 1) {
    const cell = el('span', 'day skeleton');
    cell.append(el('span', 'dl', NBSP), el('i', 'dot'));
    days.append(cell);
  }
  // The numbers and the level lines hold their rows with a blank character;
  // the ring shows its empty track.
  for (const id of SKELETON_LINES) {
    setShown($(id), true);
    $(id).textContent = NBSP;
    $(id).classList.add('skeleton');
  }
  paintRing(0, null);
}

const SKELETON_LINES = ['week-streak', 'home-accuracy', 'home-level', 'home-level-scale'];

function clearWeekSkeleton() {
  const card = $('week-card');
  if (!card.classList.contains('is-skeleton')) return;
  card.classList.remove('is-skeleton');
  card.removeAttribute('aria-busy');
  $('week-days').replaceChildren();
  for (const id of SKELETON_LINES) {
    $(id).classList.remove('skeleton');
    $(id).textContent = '';
  }
}

function loadingNote() {
  const wrap = el('div', 'today-loading');
  const dots = el('div', 'thinking');
  dots.append(el('i'), el('i'), el('i'));
  wrap.append(dots, el('span', '', '오늘의 추천 불러오는 중...'));
  return wrap;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/* 오른쪽 칸에 보이는 패널이 하나도 없으면 한 칸으로 접는다.
   querySelector 를 쓰지 않는 것은 취향이 아니다 -- dom-shim.js 는 CSS 선택자를
   구현하지 않고 항상 null 을 돌려주므로, 선택자로 쓰면 이 함수는 테스트에서
   조용히 아무것도 안 하게 된다. */
function syncAside() {
  const shut = (id) => $(id).classList.contains('is-collapsed');
  const empty = resumeCollapsed() && $('week-card').hidden && shut('review-home') && shut('leveltest-home');
  $('home').classList.toggle('no-aside', empty);
}

/* ---------- 오늘의 추천 ---------- */

export function renderToday(recs) {
  today = (recs || []).slice(0, 2);
  paintToday();
}

/* 또는: -- trades the big card and the alternative. No request, no start.
   paintToday rebuilds #today-alt's button as a new node, so the one the
   learner just pressed is gone from the tree and focus would otherwise fall
   back to <body>. The only way in is that button, so the replacement is
   always the right thing to focus next. */
export function swapToday() {
  if (today.length < 2) return;
  today = [today[1], today[0]];
  // Swapped at once (the refocus below and its tests need the new button now),
  // then eased in: #today-body carries .fade, so dropping .is-invisible after
  // a forced style flush fades the new card up over 150ms (spec R8) instead
  // of the text snapping from one theme to the other.
  const body = $('today-body');
  paintToday();
  body.classList.add('is-invisible');
  void body.offsetWidth;
  body.classList.remove('is-invisible');
  $('today-alt').children[0]?.focus();
}

function paintToday() {
  const body = $('today-body');
  const alt = $('today-alt');
  const [current, other] = today;
  if (!current) {
    body.replaceChildren(el('p', 'today-empty',
      '새 대본을 준비하고 있어요. 그동안 직접 만들기나 수업으로 연습해 보세요.'));
    alt.replaceChildren();
    setShown(alt, false);
    return;
  }
  const actions = el('div', 'today-actions');
  for (const mode of ['script', 'free']) {
    const ready = mode === 'script' ? (current.ready?.script || 0) > 0 : Boolean(current.ready?.free);
    const button = el('button', `btn-stable${mode === 'script' ? ' primary' : ''}`, START_LABELS[mode]);
    button.type = 'button';
    button.dataset.mode = mode;
    button.dataset.theme = current.theme_id;
    button.disabled = !ready;
    actions.append(button);
    if (!ready) actions.append(el('span', 'today-note', '대본 준비 중'));
  }
  const chips = el('ul', 'today-situations');
  chips.setAttribute('aria-label', '상황');
  for (const s of (current.situations || []).slice(0, 3)) chips.append(el('li', '', s));
  body.replaceChildren(
    el('p', 'today-title', current.title),
    chips,
    ...(current.reason ? [el('p', 'today-reason', current.reason)] : []),
    actions,
  );
  // Kept in place when there is no alternative (spec R5): the line below it
  // (약점 줄, then the mode cards) must not move up and down between loads.
  setShown(alt, Boolean(other));
  if (other) {
    const swap = el('button', 'ghost', `또는: ${other.title} →`);
    swap.type = 'button';
    alt.replaceChildren(swap);
  } else {
    alt.replaceChildren();
  }
}

/* ---------- 오늘의 목표 문장 ---------- */

/* `t` is /stats/home's `target`: the newest sentence under the learner's most
   frequent mistake tag, or null (no tag has come up three times yet). With
   one, the hero splits in two; without, the recommendation has all of it. */
export function renderTarget(t) {
  clearTargetSkeleton();
  const show = Boolean(t && t.fixed);
  target = show ? t : null;
  $('home-target').hidden = !show;
  $('home-hero').classList.toggle('has-target', show);
  if (show) {
    $('home-target-tag').textContent = `초점: ${t.tag}`;
    $('home-target-fixed').textContent = t.fixed;
  } else {
    $('home-target-tag').textContent = '';
    $('home-target-fixed').textContent = '';
  }
}

/* ▶ 들어 보기: the same path as the review card's ▶ 듣기 (playFixed below), for
   the target's own message. */
export function playTargetHome() {
  if (!target || $('home-target').hidden || $('home-target').inert) return undefined;
  return playFixed($('home-target-play'), TARGET_PLAY_LABEL, `/messages/${target.id}/fixed-audio`, target.fixed);
}

/* ---------- 내 상태 ---------- */

export function renderWeek(data, streakDays, acc = null) {
  week = { days: data.days || [], sessions: data.sessions || 0, goal: data.goal };
  streak = streakDays || 0;
  accuracy = acc && typeof acc.graded === 'number' ? acc : null;
  paintWeek();
}

/* The level beside the ring: the latest level test's CEFR and step with the
   scale it comes to (JF for Japanese, IELTS for English), `레벨 테스트 전`
   with no test yet, and a dash when the request failed -- not knowing is not
   the same as "not tested". The scale line keeps its row either way; its
   IELTS wording is the result screen's own (leveltest.js RESULT_TEXT). */
const NO_TEST = '레벨 테스트 전';
// Not known, or nothing to show: the level on a failed request, and the
// accuracy with nothing graded.
const DASH = '—';

export function renderLevel(latest) {
  const known = Boolean(latest) && latest.result !== undefined;
  const r = known ? latest.result : undefined;
  $('home-level').textContent = r ? levelName(r) : (known ? NO_TEST : DASH);
  const scale = r ? (r.jf || (r.ielts ? RESULT_TEXT.ielts(r.ielts) : '')) : '';
  $('home-level-scale').textContent = scale || NBSP;
}

/* The goal ring: an arc of `ratio` of the circle, drawn once per paint -- a
   static shape, never animated. An empty arc is hidden rather than drawn at
   zero length, which a round line cap would still show as a dot. */
function paintRing(ratio, label) {
  const fill = $('week-ring-fill');
  const r = Math.max(0, Math.min(ratio, 1));
  fill.setAttribute('stroke-dasharray', `${(RING_C * r).toFixed(2)} ${RING_C.toFixed(2)}`);
  // classList, not className: an SVG element's className is not a string.
  fill.classList.toggle('is-empty', r === 0);
  if (label) $('week-ring').setAttribute('aria-label', label);
}

function paintWeek() {
  clearWeekSkeleton();
  $('week-card').hidden = false;
  const days = $('week-days');
  days.replaceChildren();
  for (const d of week.days) {
    const cell = el('span', 'day');
    cell.classList.toggle('practiced', Boolean(d.practiced));
    cell.classList.toggle('today', Boolean(d.today));
    cell.classList.toggle('future', Boolean(d.future));
    cell.setAttribute('title', d.date);
    cell.append(el('span', 'dl', d.label), el('i', 'dot'));
    days.append(cell);
  }
  // Both numbers always have their cell: a zero streak is 0일, and a month
  // with nothing graded is a dash rather than a made-up 0%.
  $('week-streak').textContent = `${streak}일`;
  $('home-accuracy').textContent = accuracy && accuracy.graded > 0
    ? `${Math.round((accuracy.correct / accuracy.graded) * 100)}%` : DASH;
  const { sessions: n, goal } = week;
  $('week-ring-num').textContent = `${n}/${goal}`;
  $('week-ring-sub').textContent = n >= goal ? '목표 달성!' : '이번 주';
  paintRing(n / goal, `이번 주 목표 ${goal}세션 중 ${n}세션`);
  $('goal-value').textContent = String(goal);
  paintGoalButtons();
}

function paintGoalButtons() {
  const goal = week ? week.goal : GOAL_MIN;
  $('goal-minus').disabled = savingGoal || goal <= GOAL_MIN;
  $('goal-plus').disabled = savingGoal || goal >= GOAL_MAX;
}

/* − / +: the screen moves first, the save follows, and a failed save puts the
   old value back. Only a goal on the card this call changed is rolled back --
   a loadHome that landed meanwhile painted the server's answer, which wins.

   paintWeek disables both buttons for as long as the save is out, which (a
   real browser, unlike this app's own state) drops focus off the one the
   learner just pressed. `pressed` is the button's own id, not read from an
   event -- delta's sign already says which of the two fixed goal-minus/
   goal-plus buttons this call is for, and both callers are exactly those two
   clicks (see main.js). Refocusing them is safe whether or not a newer
   loadHome landed meanwhile: they are static elements paintWeek only
   enables/disables, never replaces. */
export async function changeGoal(delta) {
  if (!week || savingGoal) return;
  const shown = week;
  const before = shown.goal;
  const next = Math.min(GOAL_MAX, Math.max(GOAL_MIN, before + delta));
  if (next === before) return;
  const pressed = delta < 0 ? 'goal-minus' : 'goal-plus';
  shown.goal = next;
  savingGoal = true;
  paintWeek();
  try {
    await postJSON('/settings/weekly-goal', { goal: next });
  } catch {
    if (week === shown) shown.goal = before;
    notify('목표를 저장하지 못했어요');
  } finally {
    savingGoal = false;
    if (week === shown) paintWeek();
    else paintGoalButtons();
    $(pressed).focus();
  }
}

/* ---------- 최근 테마, 대본 준비 상태 ---------- */

export function renderRecentThemes(items) {
  renderModeRecents(items);
  const list = $('recent-themes');
  list.replaceChildren();
  for (const item of (items || []).slice(0, 6)) {
    const card = el('button', 'recent-theme');
    card.type = 'button';
    card.dataset.theme = item.theme_id;
    // startThemeButton (main.js) hands this straight to startTheme(mode, …),
    // which -- like openPick -- only recognises 'shadow' as its own mode; the
    // server-side mode ('script') would start a plain script session instead.
    card.dataset.mode = item.shadowing ? 'shadow' : item.mode;
    card.append(el('span', 't', item.title), el('span', 'm', modeName(item)));
    list.append(card);
  }
  $('recent-themes-wrap').hidden = list.children.length === 0;
}

/* Each mode tile's last line: the newest recent theme practised in that mode,
   or nothing. Only what `recent_themes` already says -- a mode with no entry
   there gets no line (CSS holds the line's height either way, so the tiles
   never change size). */
export function renderModeRecents(items) {
  for (const mode of TILE_MODES) {
    const line = $(`mode-recent-${mode}`);
    const item = (items || []).find((i) => tileMode(i) === mode);
    if (item) line.replaceChildren(document.createTextNode('최근 '), el('b', '', item.title));
    else line.replaceChildren();
  }
}

export function renderLibraryProgress(library) {
  const line = $('library-progress');
  const incomplete = Boolean(library) && library.scripts < library.target;
  line.textContent = incomplete ? `새 대본 준비 중 · ${library.scripts}/${library.target}편` : '';
  if (library && !incomplete) {
    // The library is complete: the line is never coming back, so it gives its
    // space up rather than holding an empty row forever.
    line.hidden = true;
    line.classList.remove('is-invisible');
    line.removeAttribute('aria-hidden');
  } else {
    setShown(line, incomplete);      // unknown or incomplete: keep the row (R5)
  }
}

/* ---------- 오늘 복습 ---------- */

/* Painted from /stats/home's `review: {due, first}`, next to (and following
   the same rules as) the week card and the resume card. `first` is only ever
   used to fill the card and to know what 듣기 plays -- reviewFirst holds it
   for playReviewHome the same way resumeTarget holds a session for
   resumeSession. `instant` is passed straight through to setCollapsedShown;
   loadHome supplies its own firstPaint flag, and no other caller needs it. */
export function renderReviewHome(review, { instant = false } = {}) {
  const due = (review && review.due) || 0;
  const first = (review && review.first) || null;
  const show = due > 0 && Boolean(first);
  reviewFirst = show ? first : null;
  if (show) {
    $('review-home-count').textContent = `오늘 복습할 문장 ${due}개`;
    $('review-home-first').textContent = first.fixed;
  }
  setReviewHomeShown(show, { instant });
}

/* ▶ 듣기 -> 음성 준비 중... -> ▶ 듣기, the same shape as mypage.js's playReview
   for a review card there: POST synthesises (or reuses) the clip, and a
   failed synthesis falls back to the browser's own voice rather than leaving
   the learner with a dead button. Guarded by #review-home's own `inert`, the
   same way resumeSession reads #resume-card's -- a dimmed card is one
   loadHome is about to repaint, possibly for another language. */
export async function playReviewHome() {
  if (!reviewFirst || $('review-home').inert) return;
  const item = reviewFirst;
  await playFixed($('review-home-play'), REVIEW_PLAY_LABEL, `/review/${item.id}/audio`, item.fixed);
}

/* One press of a ▶ button that speaks a fixed sentence: the label says
   음성 준비 중... while `url` makes (or reuses) the clip, then goes back. The
   button is .btn-stable, so the label change does not move it. */
async function playFixed(btn, label, url, text) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = PREPARING;
  try {
    let key = null;
    try {
      ({ audio_key: key } = await postJSON(url, {}));
    } catch {
      key = null;   // play(null, …) is the browser's voice
    }
    play(key || null, text);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* The one thing that knows a session is already being opened -- by either door.

   Opening one is a multi-second local-model call, and #wish (Enter), the theme
   cards and the tabs all reach startFromPick (pick.js) while #btn-start is
   disabled, so disabling that one button is not a guard. Two Enter presses
   create *two* sessions; the loser is left open holding only its bot opening
   line, and would then be offered back as the resume card. Same defect and
   same shape as the `ending` flag in session.js (and as commit 07caa64 for
   sendTurn): a flag, not a disabled attribute, because the entry points are
   not all buttons.

   One flag rather than one per door, because what is being guarded is one
   resource -- state.sessionId and the session screen painted from it -- and two
   flags could only ever give two answers to the single question "is a session
   already being opened". 이어서 하기 pressed during a generation wait used to set
   state.sessionId to the resume target and show the session screen, and the
   in-flight startSession then overwrote it, re-showed the screen and wiped
   #conversation: nothing corrupted, but the learner watched the conversation
   they had just asked for be replaced by a different one.

   It lives here, next to resumeSession, and pick.js reads and writes it
   through isBusy/setBusy: pick.js already sits above home.js in the import
   order, so this adds no edge that could close a cycle, and session.js still
   imports neither.

   Every path that sets it must clear it in a `finally`, or one failed start or
   resume locks both screens for the rest of the page's life. */
let busy = false;

export function isBusy() { return busy; }
export function setBusy(value) { busy = Boolean(value); }

/* 이어서 하기: attach to the existing session rather than starting a new one.
   GET /sessions/{id} already returns every message, so replaying them is
   enough to restore the conversation on screen.

   resumable_session (db.py) already excludes mode === 'script' sessions --
   the learner's position in a script (scriptIndex) lives only in the
   browser and is never persisted, so there is nothing server-side to place
   them back into. That exclusion predates this task (it shipped with
   GET /sessions/resumable itself); resumeSession does not need its own
   guard for it because resumeTarget can never hold a script session. */
export async function resumeSession() {
  // A dimmed card is one loadHome is about to repaint -- possibly for another
  // language. inert already stops the click; this stops every other caller.
  if (!resumeTarget || busy || $('resume-card').inert) return;
  busy = true;
  try {
    // A network round trip with nothing else on screen changing -- the card
    // says what it is doing until the conversation is painted or the attempt
    // fails. Inside the try so no throw can land between `busy = true` and the
    // `finally` that clears it.
    // It takes the subtitle's place in the same line (.resume-line stacks
    // both in one cell), so the card does not grow a line when 계속 is
    // pressed and shrink again when the attempt ends.
    setShown($('resume-status'), true);
    setShown($('resume-sub'), false);
    const { session, messages } = await getJSON(`/sessions/${resumeTarget.id}`);
    state.sessionId = resumeTarget.id;
    state.mode = resumeTarget.mode;
    // A resumed session is never shadowing (script sessions are not
    // resumable), and this path does not go through startSession, which is
    // what otherwise puts the shadowing card and its hidden dock controls away.
    state.shadowing = false;
    $('shadow-card').hidden = true;
    $('text-input').hidden = false;
    $('btn-send').hidden = false;
    $('btn-next').hidden = true;
    setSuggestVisible(resumeTarget.mode);
    // Same rule startSession follows for a session it just created: the
    // session that actually exists becomes the app's language, not whatever
    // the language segment happens to show. Correct today only because
    // loadHome scopes the resume card to the current language -- but
    // addMessage's reading-aids gate reads state.language directly, so
    // without this line a stray write to it between loadHome and this click
    // (or a future loosening of that scoping) would silently mis-render.
    state.language = session.language;
    syncLanguageButtons();
    router.show('session');
    $('conversation').replaceChildren();
    // GET /sessions/{id} hands back a cache-only audio_key per bot message
    // (null if nothing is cached, never freshly synthesised) -- see
    // _resumable_audio_key in app/api.py. Passing it through means clicking a
    // replayed bot bubble plays the real clip when it is still on disk,
    // rather than main.js's play() reporting a synthesis failure that never
    // happened.
    //
    // Painted all at once, so the replayed bubbles skip their enter animation
    // (.msg.replayed): a whole conversation easing in together reads as the
    // screen flashing. Marked per bubble rather than with a class on
    // #conversation removed afterwards -- removing that would switch their
    // animation from none back on and start every one of them right then.
    for (const m of messages) addMessage(m.speaker, m.text, m.audio_key).classList.add('replayed');
    // Same rule as startSession: the side panel holds only 목표 or 대본, so a
    // resumed session with no goal (lesson mode, or free mode with none set)
    // hides the panel rather than showing the "목표" heading over nothing.
    const goal = resumeTarget.goal || '';
    $('panel-title').textContent = '목표';
    $('panel-body').textContent = goal;
    $('side-panel').hidden = !goal;
    notify('');
  } catch (err) {
    notify(`이어서 하지 못했습니다: ${err.message}`);
  } finally {
    busy = false;
    setShown($('resume-status'), false);
    setShown($('resume-sub'), true);
  }
}
