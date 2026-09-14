/* The home screen: today's recommended theme, the three mode cards, 이어서 하기,
   this week's practice, and the recent themes. Named in the Phase 2 design
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
import { $, getJSON, postJSON, state, notify, setShown } from './api.js';
import * as router from './router.js';
import { addMessage } from './session.js';
import { setSuggestVisible } from './suggest.js';

// Filled by loadHome (Task 8) once a resumable session is found; read by
// resumeSession (Task 8). Declared here, ahead of either function, so a
// module that only defines one of the two never references an identifier
// the other half hasn't declared yet.
let resumeTarget = null;

const GOAL_MIN = 1;
const GOAL_MAX = 14;
const START_LABELS = { script: '스크립트로 시작', free: '자유 대화로 시작' };
const MODE_NAMES = { script: '스크립트', free: '자유 상황극' };
// A placeholder line needs a character to be a line at all: an empty or
// space-only <p> is zero tall.
const NBSP = String.fromCharCode(0xa0);   // a no-break space

let today = [];            // [current, alternative?] -- swapToday trades them
let week = null;           // { days, sessions, goal } as last painted, or null
let streak = 0;
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

  if (homeEl.dataset.painted === '1') {
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
    weekSkeleton();
  }

  $('home-date').textContent = new Intl.DateTimeFormat('ko-KR', {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());

  try {
    const [{ session }, stats] = await Promise.all([
      getJSON(`/sessions/resumable?language=${lang}`),
      getJSON(`/stats/home?language=${lang}`),
    ]);

    if (state.language !== lang) return; // a newer switch already won

    $('resume-card').hidden = !session;
    if (session) {
      resumeTarget = session;
      $('resume-title').textContent = `이어서 하기 — ${session.title}`;
      $('resume-sub').textContent = `대화 ${session.turns}턴에서 멈췄습니다`;
    }

    $('home-greeting').textContent = stats.has_history
      ? '오늘은 뭘 연습할까요?' : '첫 연습을 시작해 보세요';

    renderToday(stats.recommend);

    const worst = stats.top_tags && stats.top_tags[0];
    $('recommend').hidden = !worst;
    if (worst) {
      $('recommend').textContent =
        `요즘 ${worst.tag}에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`;
    }

    // No numeric goal means the payload is not the one this card is drawn
    // from -- hide the card rather than invent a goal the learner never set.
    if (stats.has_history && stats.week && typeof stats.week.goal === 'number') {
      renderWeek(stats.week, stats.streak);
      renderRecentThemes(stats.recent_themes);
    } else {
      // The content itself changed (no history under this language), so this
      // is the moment the card goes -- not before the request.
      week = null;
      clearWeekSkeleton();
      $('week-card').hidden = true;
      $('recent-themes-wrap').hidden = true;
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
  $('resume-card').hidden = true;
  $('today-alt').hidden = true;
  $('recommend').hidden = true;
  clearWeekSkeleton();
  $('week-card').hidden = true;
  $('recent-themes-wrap').hidden = true;
  $('library-progress').hidden = true;
}

/* Everything loadHome repaints from the response. Dimmed on the cards
   themselves rather than on .home-main/.home-aside: under 880px those two
   are `display: contents` (so the phone order can interleave their children),
   and opacity on a box-less element does nothing. The mode cards are not
   here -- they never depend on the request. */
const REFRESHED = ['today-card', 'today-alt', 'recommend', 'resume-card',
  'week-card', 'recent-themes-wrap', 'library-progress'];

function setRefreshing(on) {
  for (const id of REFRESHED) $(id).classList.toggle('is-refreshing', on);
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
  const actions = el('div', 'today-actions');
  actions.append(el('span', 'skeleton today-skel-btn'), el('span', 'skeleton today-skel-btn'));
  actions.setAttribute('aria-hidden', 'true');
  return [line('today-situations'), line('today-reason'), actions];
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
  $('week-streak').hidden = true;
  $('week-progress').textContent = NBSP;
  $('week-progress').classList.add('skeleton');
  $('week-bar').style.width = '0%';
}

function clearWeekSkeleton() {
  const card = $('week-card');
  if (!card.classList.contains('is-skeleton')) return;
  card.classList.remove('is-skeleton');
  card.removeAttribute('aria-busy');
  $('week-days').replaceChildren();
  $('week-progress').classList.remove('skeleton');
  $('week-progress').textContent = '';
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
  const empty = $('resume-card').hidden && $('week-card').hidden;
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
  body.replaceChildren(
    el('p', 'today-title', current.title),
    el('p', 'today-situations', (current.situations || []).slice(0, 3).join(' · ')),
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

/* ---------- 이번 주 ---------- */

export function renderWeek(data, streakDays) {
  week = { days: data.days || [], sessions: data.sessions || 0, goal: data.goal };
  streak = streakDays || 0;
  paintWeek();
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
  $('week-streak').hidden = !streak;
  $('week-streak').textContent = streak ? `연속 ${streak}일` : '';
  const { sessions: n, goal } = week;
  $('week-progress').textContent = `이번 주 ${n}/${goal} 세션${n >= goal ? ' · 목표 달성!' : ''}`;
  $('week-bar').style.width = `${Math.min(n / goal, 1) * 100}%`;
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
  const list = $('recent-themes');
  list.replaceChildren();
  for (const item of (items || []).slice(0, 4)) {
    const card = el('button', 'recent-theme');
    card.type = 'button';
    card.dataset.theme = item.theme_id;
    card.dataset.mode = item.mode;
    card.append(el('span', 't', item.title), el('span', 'm', MODE_NAMES[item.mode] || item.mode));
    list.append(card);
  }
  $('recent-themes-wrap').hidden = list.children.length === 0;
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
  if (!resumeTarget || busy) return;
  busy = true;
  try {
    // A network round trip with nothing else on screen changing -- the card
    // says what it is doing until the conversation is painted or the attempt
    // fails. Inside the try so no throw can land between `busy = true` and the
    // `finally` that clears it.
    $('resume-status').hidden = false;
    const { session, messages } = await getJSON(`/sessions/${resumeTarget.id}`);
    state.sessionId = resumeTarget.id;
    state.mode = resumeTarget.mode;
    setSuggestVisible(resumeTarget.mode);
    // Same rule startSession follows for a session it just created: the
    // session that actually exists becomes the app's language, not whatever
    // the language segment happens to show. Correct today only because
    // loadHome scopes the resume card to the current language -- but
    // addMessage's reading-aids gate reads state.language directly, so
    // without this line a stray write to it between loadHome and this click
    // (or a future loosening of that scoping) would silently mis-render.
    state.language = session.language;
    router.show('session');
    $('conversation').replaceChildren();
    // GET /sessions/{id} hands back a cache-only audio_key per bot message
    // (null if nothing is cached, never freshly synthesised) -- see
    // _resumable_audio_key in app/api.py. Passing it through means clicking a
    // replayed bot bubble plays the real clip when it is still on disk,
    // rather than main.js's play() reporting a synthesis failure that never
    // happened.
    for (const m of messages) addMessage(m.speaker, m.text, m.audio_key);
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
    $('resume-status').hidden = true;
  }
}
