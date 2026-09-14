/* The pick screen: a mode was chosen on home, and here the learner chooses what
   to practise in it -- a theme from the library, one of their own scenarios, or
   a wish typed into #wish -- and presses 시작.

   Every wait on this screen says which step it is on (#start-status). A
   script start can be several model calls long, and a spinner with no words
   reads the same at second two as at second twenty.

   Imports run one way: this module uses startSession from session.js and the
   start/resume guard from home.js. Neither of those imports this one. */
import { $, getJSON, postJSON, state, notify } from './api.js';
import * as router from './router.js';
import { startSession } from './session.js';
import { isBusy, setBusy } from './home.js';

export const STATUS = {
  pickScript: '대본 고르는 중...',
  audio: '음성 준비 중...',
  makeScript: '대본 만드는 중...',
  makeScene: '상황 만드는 중...',
  opening: '첫 대사 만드는 중...',
};

export const CATEGORY_LABELS = {
  daily: '일상', travel: '여행', smalltalk: '스몰토크', business: '비즈니스', mine: '내가 만든 것',
};

// Same order as config.THEME_CATEGORIES on the server.
const THEME_CATEGORIES = ['daily', 'travel', 'smalltalk', 'business'];

const MODE_LABELS = { free: '자유 상황극', script: '스크립트', lesson: '수업' };

let themes = [];          // GET /themes for the language this screen was loaded under
let mine = [];            // the learner's own scenarios (ids starting `user-`)
let category = THEME_CATEGORIES[0];
let selected = null;      // { kind: 'theme' | 'scenario', id } | null
/* A script mode theme card sends /library/pick the moment it is pressed, so the
   server can start synthesising that script's audio while the learner is still
   reaching for 시작. This holds that request -- the promise itself, not its
   result, so a 시작 pressed before it lands waits on the same request rather
   than sending a second one. */
let pending = null;       // { themeId, language, mode, promise, done } | null
let locked = false;       // a start is in flight: tabs, cards and the field are off

const isReady = (theme, mode) => (mode === 'script' ? theme.ready.script > 0 : Boolean(theme.ready.free));

export function setStatus(text) {
  $('start-status-text').textContent = text || '';
  $('start-status').hidden = !text;
}

/* Both language segments (home's and this screen's) show the one state.language. */
export function syncLanguageButtons() {
  for (const seg of [$('language-seg'), $('pick-language-seg')]) {
    for (const b of seg.children) b.classList.toggle('on', b.dataset.language === state.language);
  }
}

export async function openPick(mode) {
  state.mode = mode;
  router.show('pick');
  $('pick-mode').textContent = MODE_LABELS[mode] || mode;
  const lesson = mode === 'lesson';
  $('pick-themes').hidden = lesson;
  $('wish').value = '';
  $('wish').placeholder = lesson ? '예: 과거형, 식당에서 쓰는 표현' : '직접 만들기: 예) 이사 업체에 견적 묻기';
  $('wish-hint').textContent = lesson ? '비워두면 선생님이 골라줍니다' : '목록에 없는 상황을 쓰면 새로 만들어요';
  syncLanguageButtons();
  setStatus(null);
  await loadThemes();
}

/* The themes and the learner's own scenarios for the current language and
   mode. Clears the selection: a theme chosen under one language is not a
   choice under the other.

   Captured at call time, the same rule loadHome follows: two quick language
   clicks start two overlapping loads, and if the older one resolves last it
   would paint its now-wrong themes -- clickable ones, whose pick would then be
   sent under the other language. */
export async function loadThemes() {
  const language = state.language;
  const mode = state.mode;
  themes = [];
  mine = [];
  category = THEME_CATEGORIES[0];
  selected = null;
  pending = null;
  render();
  if (mode === 'lesson') return;   // lesson takes a topic, not a theme
  try {
    const [themeList, own] = await Promise.all([
      getJSON(`/themes?language=${language}`),
      getJSON(`/scenarios?language=${language}&mode=${mode}`),
    ]);
    if (state.language !== language || state.mode !== mode) return; // a newer switch already won
    themes = themeList.themes || [];
    mine = (own.scenarios || []).filter((s) => String(s.id).startsWith('user-'));
    render();
  } catch (err) {
    if (state.language !== language || state.mode !== mode) return;
    notify(`테마를 불러오지 못했어요: ${err.message}`);
  }
}

export function selectCategory(key) {
  category = key;
  render();
}

export async function selectTheme(themeId) {
  if (locked) return;
  const mode = state.mode;
  const language = state.language;
  const theme = themes.find((t) => t.id === themeId);
  if (!theme || !isReady(theme, mode)) return;
  selected = { kind: 'theme', id: themeId };
  render();
  if (mode !== 'script') { pending = null; return; }
  const entry = sendPick(themeId, language, mode);
  pending = entry;
  try {
    await entry.promise;
  } catch (err) {
    if (pending !== entry) return;   // a newer card already replaced this one
    pending = null;
    selected = null;
    render();
    notify(err.message);
  }
}

export function selectScenario(scenarioId) {
  if (locked) return;
  selected = { kind: 'scenario', id: scenarioId };
  pending = null;
  render();
}

function sendPick(themeId, language, mode) {
  const entry = { themeId, language, mode, done: false };
  entry.promise = postJSON('/library/pick', { language, mode, theme_id: themeId })
    .finally(() => { entry.done = true; });
  return entry;
}

function lock(on) {
  locked = on;
  $('btn-start').disabled = on;
  $('wish').disabled = on;
  render();
}

/* 시작. In order: lesson takes the field as its topic; otherwise text in the
   field builds a new scenario; otherwise one of the learner's own; otherwise
   the chosen theme, or a ready one from the current tab when nothing is. */
export async function startFromPick() {
  if (isBusy()) return;
  // Captured once, here, and used for every request below -- never re-read
  // from `state` after an await. /scenarios/generate is a local model call
  // that takes seconds, and the language segments stay live throughout it: a
  // switch landing mid-generation would otherwise post the new language with
  // the old language's scenario id, creating a session stamped `ja` bound to
  // an `en` scenario, whose turns then feed the wrong language's history
  // forever with nothing on screen to say so.
  const language = state.language;
  const mode = state.mode;
  const script = mode === 'script';
  let failure = '시작하지 못했어요';
  // Inside the try, not before it: a throw between setting the guard and the
  // `finally` that clears it latches it for the life of the page, and every
  // start and resume then silently stops working.
  try {
    setBusy(true);
    const wish = $('wish').value.trim();
    lock(true);

    if (mode === 'lesson') {
      setStatus(STATUS.opening);
      await startSession({ language, mode, topic: wish || null });
      return;
    }

    let scenarioId;
    if (wish) {
      failure = script ? '대본을 만들지 못했어요' : '상황을 만들지 못했어요';
      setStatus(script ? STATUS.makeScript : STATUS.makeScene);
      const made = await postJSON('/scenarios/generate', { language, mode, wish });
      failure = '시작하지 못했어요';
      scenarioId = made.id;
    } else {
      let choice = selected;
      if (!choice) choice = drawFromTab(mode);
      if (!choice) { notify('고를 수 있는 테마가 없어요. 다른 탭을 고르거나 직접 만들어 보세요.'); return; }
      if (choice.kind === 'scenario') {
        scenarioId = choice.id;
      } else if (script) {
        const held = pending && pending.themeId === choice.id
          && pending.language === language && pending.mode === mode;
        const entry = held ? pending : sendPick(choice.id, language, mode);
        if (!entry.done) setStatus(STATUS.pickScript);
        scenarioId = (await entry.promise).id;
      } else {
        setStatus(STATUS.opening);
        scenarioId = (await postJSON('/library/pick', { language, mode, theme_id: choice.id })).id;
      }
    }

    setStatus(script ? STATUS.audio : STATUS.opening);
    await startSession({ language, mode, scenarioId, topic: null });
  } catch (err) {
    notify(`${failure}: ${err.message}`);
  } finally {
    setBusy(false);
    lock(false);
    setStatus(null);
  }
}

/* Nothing chosen: a ready theme from the tab the learner is looking at (or one
   of their own, on 내가 만든 것). "고르세요" is what this screen exists to avoid. */
function drawFromTab(mode) {
  const pool = category === 'mine'
    ? mine.map((s) => ({ kind: 'scenario', id: s.id }))
    : themes.filter((t) => t.category === category && isReady(t, mode)).map((t) => ({ kind: 'theme', id: t.id }));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

function render() {
  const tabs = $('category-tabs');
  tabs.replaceChildren();
  const keys = mine.length ? [...THEME_CATEGORIES, 'mine'] : THEME_CATEGORIES;
  for (const key of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(key === category));
    b.dataset.category = key;
    b.textContent = CATEGORY_LABELS[key];
    if (key === category) b.className = 'on';
    b.disabled = locked;
    tabs.append(b);
  }

  const grid = $('theme-grid');
  grid.replaceChildren();
  if (category === 'mine') {
    for (const s of mine) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'theme-card';
      card.dataset.scenario = s.id;
      card.classList.toggle('on', selected?.kind === 'scenario' && selected.id === s.id);
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = s.title;
      card.append(t);
      card.disabled = locked;
      grid.append(card);
    }
    return;
  }
  for (const theme of themes.filter((x) => x.category === category)) {
    const ready = isReady(theme, state.mode);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.theme = theme.id;
    card.classList.toggle('on', selected?.kind === 'theme' && selected.id === theme.id);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = theme.title;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = ready ? (theme.situations || []).join(' · ') : '준비 중';
    card.append(t, s);
    card.disabled = locked || !ready;
    grid.append(card);
  }
}
