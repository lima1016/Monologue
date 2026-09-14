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
  assert.equal($('start-status').hidden, true, 'the status clears once the session is open');
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
  assert.equal($('start-status').hidden, true);
  assert.match($('notice').textContent, /대본을 만들지 못했어요/);
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
