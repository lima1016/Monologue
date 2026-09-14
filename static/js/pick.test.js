/* The pick screen: a mode is chosen on home, a theme (or a wish) is chosen
 * here, and every long wait says which step it is on. Driven over dom-shim.js
 * with a stubbed fetch.
 *
 * pick.js keeps its selection and the script pick it is holding as module
 * globals, so each test re-imports it under a fresh URL (the same reason and
 * the same technique as home.test.js). home.js is NOT re-imported: pick.js
 * reaches the shared start/resume guard through `./home.js`, and the tests
 * that prove the two doors exclude each other must hold that very instance.
 * Its guard is reset in beforeEach through the same setBusy pick.js uses, so a
 * test that fails with a start still pending cannot turn the next test's own
 * start into a vacuous early return.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import * as home from './home.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

let pick;
let instance = 0;
beforeEach(async () => {
  resetDom();
  router.register('home', 'home');
  router.register('pick', 'pick');
  router.register('session', 'session');
  state.language = 'en';
  state.sessionId = null;
  home.setBusy(false);
  pick = await import(`./pick.js?instance=${++instance}`);
});

const THEMES = [
  { id: 'cafe-restaurant', category: 'daily', title: '카페·음식점 주문', situations: ['메뉴 추천 묻기', '포장 주문'], ready: { free: true, script: 30 } },
  { id: 'shopping', category: 'daily', title: '쇼핑·계산', situations: ['교환·환불'], ready: { free: false, script: 0 } },
  { id: 'hotel', category: 'travel', title: '호텔', situations: ['체크인'], ready: { free: true, script: 30 } },
];

function routes(extra = {}) {
  const seen = { picks: [], sessions: [], generates: [], statuses: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/themes')) return jsonResponse({ themes: THEMES });
    if (url.startsWith('/api/scenarios?')) return jsonResponse({ scenarios: extra.mine || [] });
    if (url === '/api/library/pick') {
      seen.picks.push(JSON.parse(options.body));
      if (extra.pick) return extra.pick(JSON.parse(options.body));
      return jsonResponse({ id: 'lib-hotel-en-07', title: '제목', situation: '체크인' });
    }
    if (url === '/api/scenarios/generate') {
      seen.generates.push(JSON.parse(options.body));
      seen.statuses.push($('start-status-text').textContent);
      return extra.generate ? extra.generate() : jsonResponse({ id: 'user-abc' });
    }
    if (url === '/api/sessions') {
      seen.sessions.push(JSON.parse(options.body));
      seen.statuses.push($('start-status-text').textContent);
      const mode = JSON.parse(options.body).mode;
      return jsonResponse(mode === 'script' ? { session_id: 1, mode, lines: [{ speaker: 'bot', text: 'Hi.' }] }
                                           : { session_id: 1, mode, opening: 'Hi.', opening_audio: null, goal: null });
    }
    return jsonResponse({});
  });
  return seen;
}

const tabs = () => $('category-tabs').children.map((b) => b.textContent);
const cards = () => $('theme-grid').children;

test('a mode opens the pick screen with its name and four category tabs', async () => {
  routes();
  await pick.openPick('script');
  assert.equal(router.current(), 'pick');
  assert.equal(state.mode, 'script');
  assert.equal($('pick-mode').textContent, '스크립트');
  assert.deepEqual(tabs(), ['일상', '여행', '스몰토크', '비즈니스']);
  assert.deepEqual(cards().map((c) => c.dataset.theme), ['cafe-restaurant', 'shopping']);
});

test('내가 만든 것 appears only when there is something in it', async () => {
  routes({ mine: [{ id: 'user-1', title: '이사 견적', type: 'script' }, { id: 'restaurant-seating-en', title: 'builtin' }] });
  await pick.openPick('script');
  assert.deepEqual(tabs(), ['일상', '여행', '스몰토크', '비즈니스', '내가 만든 것']);
  pick.selectCategory('mine');
  assert.deepEqual(cards().map((c) => c.dataset.scenario), ['user-1']);
});

test('a theme that is not ready is disabled and says so', async () => {
  routes();
  await pick.openPick('script');
  const shopping = cards().find((c) => c.dataset.theme === 'shopping');
  assert.equal(shopping.disabled, true);
  assert.match(shopping.children[1].textContent, /준비 중/);
});

test('in script mode choosing a theme picks a script at once, and a new theme picks again', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  pick.selectCategory('travel');
  await pick.selectTheme('hotel');
  assert.deepEqual(seen.picks.map((p) => p.theme_id), ['cafe-restaurant', 'hotel']);
});

test('in free mode choosing a theme does not pick until start', async () => {
  const seen = routes();
  await pick.openPick('free');
  await pick.selectTheme('cafe-restaurant');
  assert.equal(seen.picks.length, 0);
  await pick.startFromPick();
  assert.equal(seen.picks.length, 1);
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
  assert.deepEqual(seen.statuses, ['첫 대사 만드는 중...']);
});

test('script start uses the id picked when the theme was chosen and says the audio is being prepared', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  await pick.startFromPick();
  assert.equal(seen.picks.length, 1);
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
  assert.deepEqual(seen.statuses, ['음성 준비 중...']);
  assert.ok($('start-status').classList.contains('is-invisible'), 'the status clears once the session is open');
  assert.equal($('start-status-text').textContent, '');
});

test('a pick still out when start is pressed shows 대본 고르는 중... first', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes({ pick: async () => { await held; return jsonResponse({ id: 'lib-x', title: 't', situation: 's' }); } });
  await pick.openPick('script');
  pick.selectTheme('cafe-restaurant');
  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('start-status-text').textContent, '대본 고르는 중...');
  release();
  await started;
  assert.deepEqual(seen.statuses, ['음성 준비 중...']);
});

test('typed text makes a new script with two visible steps', async () => {
  const seen = routes();
  await pick.openPick('script');
  $('wish').value = '이사 업체에 견적 묻기';
  await pick.startFromPick();
  assert.equal(seen.generates[0].wish, '이사 업체에 견적 묻기');
  assert.deepEqual(seen.statuses, ['대본 만드는 중...', '음성 준비 중...']);
  assert.equal(seen.sessions[0].scenario_id, 'user-abc');
});

test('typed text in free mode says 상황 만드는 중... then 첫 대사 만드는 중...', async () => {
  const seen = routes();
  await pick.openPick('free');
  $('wish').value = '이사 견적';
  await pick.startFromPick();
  assert.deepEqual(seen.statuses, ['상황 만드는 중...', '첫 대사 만드는 중...']);
});

test('nothing chosen starts a random ready theme from the current tab', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.startFromPick();
  assert.equal(seen.picks[0].theme_id, 'cafe-restaurant', 'shopping is not ready, so the only choice is cafe');
});

test('lesson hides the themes and starts with the topic', async () => {
  const seen = routes();
  await pick.openPick('lesson');
  assert.equal($('pick-themes').hidden, true);
  $('wish').value = '과거형';
  await pick.startFromPick();
  assert.deepEqual(seen.sessions[0], { language: 'en', mode: 'lesson', scenario_id: null, topic: '과거형' });
  assert.deepEqual(seen.statuses, ['첫 대사 만드는 중...']);
});

test('a failed generation clears the status and says what failed', async () => {
  routes({ generate: () => jsonResponse({ detail: 'bad' }, { ok: false, status: 422 }) });
  await pick.openPick('script');
  $('wish').value = 'x';
  await pick.startFromPick();
  assert.ok($('start-status').classList.contains('is-invisible'));
  assert.match($('notice-text').textContent, /대본을 만들지 못했어요/);
  assert.equal($('btn-start').disabled, false);
});

test('a language switch while themes load does not paint the old language', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  stubFetch(async (url) => {
    if (url.startsWith('/api/themes?language=en')) { await held; return jsonResponse({ themes: THEMES }); }
    if (url.startsWith('/api/themes?language=ja')) return jsonResponse({ themes: [THEMES[2]] });
    return jsonResponse({ scenarios: [] });
  });
  const opening = pick.openPick('script');
  state.language = 'ja';
  const reopened = pick.openPick('script');
  release();
  await Promise.all([opening, reopened]);
  pick.selectCategory('travel');
  assert.deepEqual(cards().map((c) => c.dataset.theme), ['hotel']);
  // The travel check alone cannot fail: the en list has hotel under travel
  // too, so a stale en paint looks the same there. Only daily tells them apart.
  pick.selectCategory('daily');
  assert.deepEqual(cards().map((c) => c.dataset.theme), [], 'the en daily themes were painted over ja');
});

/* ---------- moved from home.test.js (were startFromHome) ----------

   /scenarios/generate is a multi-second local-model call, and the language
   segment and the mode cards stay live throughout it. If startFromPick
   re-reads `state` after that await, a switch landing mid-generation posts the
   *new* language (or mode) together with the *old* one's scenario id, and the
   session is stamped one way and bound the other -- permanently, with nothing
   on screen to say so. Both tests must fail if that capture is reverted. */

/* `release` resolves the pending /scenarios/generate call, and `sessionBody`
   is whatever POST /sessions was finally sent. */
function stubStartPath() {
  const seen = { sessionBody: null };
  let release;
  const generated = new Promise((resolve) => { release = resolve; });

  stubFetch(async (url, options) => {
    if (url.startsWith('/api/scenarios?')) return jsonResponse({ scenarios: [] });
    if (url === '/api/scenarios/generate') {
      await generated;                       // the generation wait, held open
      return jsonResponse({ id: 'user-en-free-1' });
    }
    if (url === '/api/sessions') {
      seen.sessionBody = JSON.parse(options.body);
      return jsonResponse({ session_id: 7, mode: 'free', opening: 'Hi.',
                            opening_audio: null, goal: 'g' });
    }
    return jsonResponse({});
  });

  return { seen, release: () => release() };
}

test('a language switch during generation does not change the session being created', async () => {
  state.language = 'en';
  state.mode = 'free';
  $('wish').value = '병원 접수';
  const { seen, release } = stubStartPath();

  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));   // let it reach the generate await
  state.language = 'ja';                        // the learner presses 日本語 while it thinks
  release();
  await started;

  assert.equal(seen.sessionBody.language, 'en',
    'POST /sessions carried the language the scenario was generated under');
  assert.equal(seen.sessionBody.scenario_id, 'user-en-free-1');
});

test('a mode switch during generation does not change the session being created', async () => {
  state.language = 'en';
  state.mode = 'free';
  $('wish').value = '병원 접수';
  const { seen, release } = stubStartPath();

  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));
  state.mode = 'lesson';                        // lesson would null the scenario_id out
  release();
  await started;

  assert.equal(seen.sessionBody.mode, 'free',
    'POST /sessions carried the mode the scenario was generated under');
  assert.equal(seen.sessionBody.scenario_id, 'user-en-free-1');
  assert.equal(seen.sessionBody.topic, null);
});

/* Same capture rule through the theme door: nothing typed, nothing chosen, so
   a ready theme is drawn and /library/pick is sent under the captured
   language. The window opens once that pick resolves and closes at POST
   /sessions -- the id it handed back must be posted under the language it was
   picked for, not whatever the segment says by then. */
test('a language switch while the pick is out does not change the session being created', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes({ pick: async (body) => { await held; return jsonResponse({ id: `lib-${body.language}`, title: 't', situation: 's' }); } });
  await pick.openPick('free');

  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));
  state.language = 'ja';
  release();
  await started;

  assert.equal(seen.picks[0].language, 'en');
  assert.deepEqual([seen.sessions[0].language, seen.sessions[0].scenario_id], ['en', 'lib-en']);
});

/* Fills resumeTarget the only way anything can: through loadHome. */
async function armResumeCard() {
  stubFetch(async (url) => {
    if (url.startsWith('/api/sessions/resumable')) {
      return jsonResponse({ session: { id: 42, mode: 'free', title: '병원 접수',
                                       goal: '접수한다', turns: 4 } });
    }
    if (url.startsWith('/api/stats/home')) {
      return jsonResponse({ streak: 1, week_turns: 4, fixed_total: 0, top_tags: [] });
    }
    return jsonResponse({});
  });
  await home.loadHome();
}

test('이어서 하기 during a generation wait does not hijack the session being started', async () => {
  state.language = 'en';
  state.mode = 'free';
  await armResumeCard();

  $('wish').value = '병원 접수';
  const { seen, release } = stubStartPath();
  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));

  await home.resumeSession();          // the learner presses 계속 while it thinks
  assert.equal(state.sessionId, null,
    'resume attached to session 42 while a start was already in flight');

  release();
  await started;
  assert.equal(state.sessionId, 7);      // the session that was actually asked for
  assert.equal(seen.sessionBody.language, 'en');
});

test('시작 during a resume does not overwrite the conversation being restored', async () => {
  state.language = 'en';
  routes();
  await pick.openPick('free');           // themes loaded, so 시작 has something to start
  await armResumeCard();

  let releaseMessages;
  const messages = new Promise((r) => { releaseMessages = r; });
  let sessionPosts = 0;
  stubFetch(async (url) => {
    if (url === '/api/sessions/42') {
      await messages;
      return jsonResponse({ session: { id: 42, language: 'en' }, messages: [] });
    }
    if (url === '/api/library/pick') return jsonResponse({ id: 'lib-x', title: 't', situation: 's' });
    if (url === '/api/sessions') { sessionPosts += 1; return jsonResponse({ session_id: 9, mode: 'free' }); }
    return jsonResponse({});
  });

  const resuming = home.resumeSession();
  await new Promise((r) => setTimeout(r, 0));

  $('wish').value = '';
  await pick.startFromPick();          // the learner presses 시작 while the resume is in flight
  assert.equal(sessionPosts, 0, 'a new session was created on top of an in-flight resume');

  releaseMessages();
  await resuming;
  assert.equal(state.sessionId, 42);
});

/* A resume that fails must not leave the pick screen permanently unable to
   start anything -- the failure mode a guard flag without a `finally` has. */
test('a failed resume releases the guard', async () => {
  await armResumeCard();
  stubFetch(async (url) => {
    if (url === '/api/sessions/42') return jsonResponse({ detail: 'gone' }, { ok: false, status: 500 });
    return jsonResponse({});
  });
  await home.resumeSession();
  assert.equal(state.sessionId, null);

  state.mode = 'free';
  $('wish').value = '병원 접수';
  const { seen, release } = stubStartPath();
  const started = pick.startFromPick();
  release();
  await started;
  assert.ok(seen.sessionBody, 'the start was still locked after a failed resume');
});

/* ---------- clicking the card that is already chosen ---------- */

test('clicking the selected theme again while its pick is out does not pick twice', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes({ pick: async () => { await held; return jsonResponse({ id: 'lib-x', title: 't', situation: 's' }); } });
  await pick.openPick('script');
  const first = pick.selectTheme('cafe-restaurant');
  const second = pick.selectTheme('cafe-restaurant');
  release();
  await Promise.all([first, second]);
  assert.equal(seen.picks.length, 1);
});

test('clicking the selected theme again after its pick landed does not pick twice', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  await pick.selectTheme('cafe-restaurant');
  assert.equal(seen.picks.length, 1);
  await pick.startFromPick();
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
});

test('a theme whose pick failed can be clicked again and picks again', async () => {
  let n = 0;
  const seen = routes({ pick: async () => (++n === 1
    ? jsonResponse({ detail: '이 테마는 아직 준비되지 않았어요' }, { ok: false, status: 409 })
    : jsonResponse({ id: 'lib-y', title: 't', situation: 's' })) });
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  await pick.selectTheme('cafe-restaurant');
  assert.equal(seen.picks.length, 2);
});

/* ---------- leaving and coming back during a start ----------

   ← 홈 stays live during a start, and home's mode cards call openPick. If
   openPick reset the screen, the learner who looked away would come back to
   an unlocked screen with no status while a model call is still running --
   the one thing this screen promises never to do. */
test('going home and back during a held generation keeps the status, the lock and the wish', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes({ generate: async () => { await held; return jsonResponse({ id: 'user-abc' }); } });
  await pick.openPick('script');
  $('wish').value = '이사 업체에 견적 묻기';
  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));

  router.show('home');                 // ← 홈
  await pick.openPick('free');         // a different mode card on home
  assert.equal(router.current(), 'pick');
  assert.equal($('start-status').classList.contains('is-invisible'), false);
  assert.equal($('start-status-text').textContent, '대본 만드는 중...');
  assert.equal($('btn-start').disabled, true);
  assert.equal($('wish').value, '이사 업체에 견적 묻기');
  assert.equal($('pick-mode').textContent, '스크립트');
  assert.equal(state.mode, 'script');

  release();
  await started;
  assert.equal(seen.sessions[0].mode, 'script');
  assert.equal(seen.sessions[0].scenario_id, 'user-abc');
});

test('a mode card pressed while a resume is in flight does nothing', async () => {
  routes();
  await pick.openPick('script');
  router.show('home');
  home.setBusy(true);                  // what resumeSession holds while it loads
  await pick.openPick('free');
  assert.equal(router.current(), 'home');
  assert.equal(state.mode, 'script');
});

/* ---------- the tab you are looking at is what 시작 starts ---------- */

test('switching tabs drops the theme chosen on the old tab, so 시작 draws from the tab on screen', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  pick.selectCategory('travel');
  assert.equal(cards().some((c) => c.classList.contains('on')), false);
  await pick.startFromPick();
  assert.deepEqual(seen.picks.map((p) => p.theme_id), ['cafe-restaurant', 'hotel']);
});

test('pressing the tab already on screen keeps the choice', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  pick.selectCategory('daily');
  await pick.startFromPick();
  assert.deepEqual(seen.picks.map((p) => p.theme_id), ['cafe-restaurant']);
});

/* ---------- one failure, one notice ---------- */

test('a held pick that fails during a waiting start is reported once, by the start', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  routes({ pick: async () => { await held; return jsonResponse({ detail: '이 테마는 아직 준비되지 않았어요' }, { ok: false, status: 409 }); } });
  await pick.openPick('script');
  const notices = [];
  const el = $('notice-text');
  let text = el.textContent;
  Object.defineProperty(el, 'textContent', { get: () => text, set: (v) => { text = v; if (v) notices.push(v); } });
  const choosing = pick.selectTheme('cafe-restaurant');
  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));
  release();
  await Promise.all([choosing, started]);
  assert.deepEqual(notices, ['시작하지 못했어요: 이 테마는 아직 준비되지 않았어요']);
});

test('a pick that fails with no start waiting still says why', async () => {
  routes({ pick: async () => jsonResponse({ detail: '이 테마는 아직 준비되지 않았어요' }, { ok: false, status: 409 }) });
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  assert.equal($('notice-text').textContent, '이 테마는 아직 준비되지 않았어요');
});

/* ---------- starting a theme straight from home ---------- */

test('startTheme opens the mode, selects the theme in its own tab, and starts with visible steps', async () => {
  const seen = routes();
  await pick.startTheme('script', 'hotel');
  assert.equal(state.mode, 'script');
  assert.equal(seen.picks[0].theme_id, 'hotel');
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
  assert.deepEqual(seen.statuses, ['음성 준비 중...']);
});

test('startTheme in free mode starts the theme it was given, not one drawn from the tab', async () => {
  const seen = routes();
  await pick.startTheme('free', 'hotel');
  assert.deepEqual(seen.picks.map((p) => [p.mode, p.theme_id]), [['free', 'hotel']]);
  assert.deepEqual(seen.statuses, ['첫 대사 만드는 중...']);
});

test('startTheme does nothing while a start is already running', async () => {
  const seen = routes();
  // The list is already loaded and #pick is on screen (a start in flight
  // shows it), so a refused openPick alone would not stop the rest: without
  // its own guard startTheme would flip the tab and send a pick in the middle
  // of the other start.
  await pick.openPick('script');
  home.setBusy(true);
  await pick.startTheme('script', 'hotel');
  home.setBusy(false);
  assert.equal(seen.picks.length, 0);
  assert.equal($('notice-text').textContent, '');
});

test('← 홈 while startTheme waits for the themes cancels the start', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes();
  const base = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.startsWith('/api/themes')) await held;
    return base(url, options);
  };
  const starting = pick.startTheme('script', 'hotel');
  await new Promise((r) => setTimeout(r, 0));
  router.show('home');                   // the learner backs out
  release();
  await starting;
  assert.equal(seen.picks.length, 0);
  assert.equal(seen.sessions.length, 0);
  assert.equal(router.current(), 'home');
});

test('startTheme on a theme that is not ready says so and stays on the pick screen', async () => {
  const seen = routes();
  await pick.startTheme('script', 'shopping');
  assert.equal(seen.sessions.length, 0);
  assert.match($('notice-text').textContent, /이 테마는 아직 준비되지 않았어요/);
  assert.equal(router.current(), 'pick');
});

test('startTheme whose pick fails does not start a different theme from the tab', async () => {
  const seen = routes({ pick: async () => jsonResponse({ detail: '대본이 없어요' }, { ok: false, status: 409 }) });
  await pick.startTheme('script', 'hotel');
  assert.equal(seen.picks.length, 1);
  assert.equal(seen.sessions.length, 0);
  assert.equal($('notice-text').textContent, '대본이 없어요');
});

/* ---------- while the themes load ---------- */

function holdThemes() {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = { picks: [], sessions: 0 };
  stubFetch(async (url) => {
    if (url.startsWith('/api/themes')) { await held; return jsonResponse({ themes: THEMES }); }
    if (url.startsWith('/api/scenarios?')) return jsonResponse({ scenarios: [] });
    if (url === '/api/library/pick') { seen.picks.push(url); return jsonResponse({ id: 'lib-x', title: 't', situation: 's' }); }
    if (url === '/api/sessions') { seen.sessions += 1; return jsonResponse({ session_id: 1, mode: 'script', lines: [{ speaker: 'bot', text: 'Hi.' }] }); }
    return jsonResponse({});
  });
  return { seen, release: () => release() };
}

test('while the themes load the grid says so and 시작 is off', async () => {
  const { release } = holdThemes();
  const opening = pick.openPick('script');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(cards().filter((c) => !c.classList.contains('skeleton')).map((c) => c.textContent),
    ['테마 불러오는 중...']);
  assert.equal($('btn-start').disabled, true);
  release();
  await opening;
  assert.equal($('btn-start').disabled, false);
  assert.deepEqual(cards().map((c) => c.dataset.theme), ['cafe-restaurant', 'shopping']);
});

/* The grid holds card-sized placeholders while it waits (R3), so the list does
   not grow out of nothing and push 직접 만들기 and 시작 down when it lands. */
test('while themes load the grid holds theme-sized skeleton cards', async () => {
  const { release } = holdThemes();
  const opening = pick.openPick('script');
  await new Promise((r) => setTimeout(r, 0));
  const skeletons = cards().filter((c) => c.classList.contains('skeleton'));
  assert.equal(skeletons.length, 5);
  assert.ok(skeletons.every((c) => c.classList.contains('theme-card') && !c.dataset.theme),
    'a placeholder must not be a theme a click could pick');
  release();
  await opening;
  assert.equal(cards().filter((c) => c.classList.contains('skeleton')).length, 0);
});

test('the step line keeps its place when idle', async () => {
  routes();
  await pick.openPick('script');
  assert.equal($('start-status').hidden, false);
  assert.ok($('start-status').classList.contains('is-invisible'));
  assert.equal($('start-status').getAttribute('aria-hidden'), 'true');
});

test('시작 (or Enter) while the themes load does not claim there is no theme', async () => {
  const { seen, release } = holdThemes();
  const opening = pick.openPick('script');
  await new Promise((r) => setTimeout(r, 0));
  await pick.startFromPick();
  assert.equal($('notice-text').textContent, '', 'said there was nothing to choose while the list was still coming');
  release();
  await opening;
  await pick.startFromPick();
  assert.equal(seen.picks.length, 1);
  assert.equal(seen.sessions, 1);
});
