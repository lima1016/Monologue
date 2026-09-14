/* The home screen's resume path and history panels, driven over dom-shim.js
 * with a stubbed fetch. The start path (and the tests proving start and resume
 * exclude each other) moved to pick.test.js with startFromPick.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { document, jsonResponse, resetDom, stubFetch } from './dom-shim.js';

/* home.js keeps `busy` and `resumeTarget` as module globals and node evaluates
   this file's module graph once, so without a reset every test inherits the
   previous one's state -- and a failure can convert a later test into a
   *vacuous pass*. Demonstrated: with the resume gate reverted, the full-suite
   run fails two tests and "시작 during a resume..." passes, because the
   preceding failure left the start's promise pending with `busy === true`,
   so that test's own start returned at the guard and asserted
   nothing. Run alone against the same revert it fails correctly. A suite that
   reports green because an earlier test broke is the same failure class as a
   guard that swallows a missing element.

   Reset by re-importing home.js under a fresh URL rather than by exporting a
   test-only reset from it: the query string yields a genuinely new module
   instance, so *every* module global it has -- including any added later --
   starts clean, with nothing test-only in production code and no hand-kept
   list to rot. home.js's own imports (api.js, session.js, router.js) resolve
   to their already-cached URLs, so `state` and `startSession` stay the single
   shared ones these assertions read. */
let home;
let instance = 0;

beforeEach(async () => {
  // Elements are memoised by id in dom-shim, so the tree is module-global too.
  resetDom();
  home = await import(`./home.js?instance=${++instance}`);
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

/* session.js's startSession sets state.language from the session it actually
   created rather than trusting the language button, because a switch can
   land between the request and the response. addMessage's reading-aids gate
   reads state.language directly, and today resumeSession never touches it --
   correct only because loadHome scopes the resume card to the current
   language, which is a coincidence this test does not rely on: it sets
   state.language to something *other* than the resumed session's language
   before resuming, and asserts resumeSession corrects it. */
test('resumeSession sets state.language from the session actually being resumed', async () => {
  router.register('session', 'session');
  state.language = 'ja'; // deliberately wrong, to prove resumeSession corrects it
  state.mode = 'free';
  state.sessionId = null;
  await armResumeCard(); // resume card is offered under "ja" per loadHome's own scoping

  stubFetch(async (url) => {
    if (url === '/api/sessions/42') {
      return jsonResponse({ session: { id: 42, language: 'en' }, messages: [] });
    }
    return jsonResponse({});
  });

  await home.resumeSession();
  assert.equal(state.language, 'en');
});

/* GET /sessions/{id} hands back a cache-only audio_key per bot message (never
   freshly synthesised -- see _resumable_audio_key in app/api.py). Without
   this passthrough, every replayed bot bubble has no audio key at all, and
   main.js's play branch would report a synthesis failure that never
   happened the moment the learner clicks one to hear it again. */
test('resumeSession carries each message\'s cached audio key into its bubble', async () => {
  router.register('session', 'session'); // main.js does this in the real app; this test drives home.js alone
  state.language = 'en';
  state.mode = 'free';
  state.sessionId = null;
  await armResumeCard();

  stubFetch(async (url) => {
    if (url === '/api/sessions/42') {
      return jsonResponse({
        session: { id: 42, language: 'en' },
        messages: [
          { speaker: 'bot', text: 'Hi.', audio_key: 'cachedkey123' },
          { speaker: 'user', text: 'Hello.', audio_key: null },
        ],
      });
    }
    return jsonResponse({});
  });

  await home.resumeSession();
  const [botBubble, userBubble] = $('conversation').children;
  assert.equal(botBubble.dataset.audioKey, 'cachedkey123');
  assert.equal(userBubble.dataset.audioKey, undefined,
    'a message with no cached clip must not get a dataset.audioKey the click handler would try to play');
});

/* 이어서 하기 is a network round trip with nothing else on screen changing, so
   the card says what it is doing while it waits -- and stops saying it on
   both the success and the failure path. */
test('the resume card says 대화 불러오는 중... while the conversation loads', async () => {
  router.register('session', 'session');
  state.language = 'en';
  state.sessionId = null;
  await armResumeCard();

  let release;
  const held = new Promise((r) => { release = r; });
  let failNext = false;
  stubFetch(async (url) => {
    if (url === '/api/sessions/42') {
      await held;
      if (failNext) return jsonResponse({ detail: 'gone' }, { ok: false, status: 500 });
      return jsonResponse({ session: { id: 42, language: 'en' }, messages: [] });
    }
    return jsonResponse({});
  });

  const resuming = home.resumeSession();
  assert.equal($('resume-status').hidden, false, 'nothing said the resume was loading');
  release();
  await resuming;
  assert.equal($('resume-status').hidden, true);

  failNext = true;
  const failing = home.resumeSession();
  assert.equal($('resume-status').hidden, false);
  await failing;
  assert.equal($('resume-status').hidden, true, 'a failed resume left the loading line up');
});

/* The right-hand column (이어서 하기 / 이번 주) collapses when there is nothing
   in it to show, and comes back the moment there is. */
test('첫 실행 — 오른쪽에 보일 것이 하나도 없으면 한 칸으로 접는다', async () => {
  stubFetch(async (url) => {
    if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
    if (url.startsWith('/api/stats/home')) {
      return jsonResponse({ streak: 0, week_turns: 0, fixed_total: 0, top_tags: [], recent: [] });
    }
    return jsonResponse({});
  });

  await home.loadHome();

  assert.ok($('home').classList.contains('no-aside'),
    '이어서 하기·이번 주가 모두 없으면 오른쪽 330px 트랙이 빈 채로 남는다');
});

test('볼 것이 하나라도 생기면 두 칸으로 되돌린다', async () => {
  $('home').classList.add('no-aside');   // 앞선 첫 실행 상태
  homeRoutes(PAYLOAD());                  // 기록이 있으니 이번 주 카드가 보인다

  await home.loadHome();

  assert.ok(!$('home').classList.contains('no-aside'));
});

test('요청이 실패해도 한 칸으로 접는다', async () => {
  stubFetch(async () => { throw new Error('down'); });

  await home.loadHome();

  assert.ok($('home').classList.contains('no-aside'),
    'catch 경로도 오른쪽 칸을 다 숨긴다 -- 숨긴 채로 트랙만 남기면 안 된다');
});

/* ---------- the dashboard: today, the week, recent themes ---------- */

/* dom-shim's textContent is a plain field (reading.test.js relies on that), so
   it does not include children the way a browser's does. This reads a subtree
   the way the browser would. */
const text = (n) => (n.textContent || '') + (n.childNodes || []).map(text).join('');

const PAYLOAD = (over = {}) => ({
  streak: 2, week_turns: 10, fixed_total: 3, top_tags: [], recent: [],
  has_history: true,
  week: { sessions: 3, goal: 5, days: [
    { date: '2026-09-14', label: '월', practiced: true, today: false, future: false },
    { date: '2026-09-15', label: '화', practiced: false, today: false, future: false },
    { date: '2026-09-16', label: '수', practiced: true, today: true, future: false },
    { date: '2026-09-17', label: '목', practiced: false, today: false, future: true },
    { date: '2026-09-18', label: '금', practiced: false, today: false, future: true },
    { date: '2026-09-19', label: '토', practiced: false, today: false, future: true },
    { date: '2026-09-20', label: '일', practiced: false, today: false, future: true },
  ] },
  recommend: [
    { theme_id: 'hotel', title: '호텔', category: 'travel', situations: ['체크인', '방 문제 알리기', '짐 맡기기', '체크아웃 연장'], reason: '아직 안 해본 테마예요', ready: { free: true, script: 3 } },
    { theme_id: 'meetings', title: '회의', category: 'business', situations: ['의견 말하기'], reason: '어제 연습했어요', ready: { free: false, script: 3 } },
  ],
  recent_themes: [{ theme_id: 'cafe-restaurant', title: '카페·음식점 주문', mode: 'script' }],
  library: { scripts: 312, target: 600 },
  ...over,
});

function homeRoutes(payload, extra = {}) {
  const seen = { goals: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
    if (url.startsWith('/api/stats/home')) return extra.stats ? extra.stats(url) : jsonResponse(payload);
    if (url === '/api/settings/weekly-goal') {
      seen.goals.push(JSON.parse(options.body).goal);
      return extra.goal ? extra.goal() : jsonResponse({ goal: JSON.parse(options.body).goal });
    }
    return jsonResponse({});
  });
  return seen;
}

test('while home loads the recommendation slot says so', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD()); } });
  const loading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(text($('today-body')), /오늘의 추천 불러오는 중\.\.\./);
  assert.ok($('today-body').children.some((c) => c.classList.contains('thinking')
    || c.children.some((g) => g.classList.contains('thinking'))), 'the wait has no moving dots');
  release();
  await loading;
  assert.match(text($('today-body')), /호텔/);
});

/* True if `node` or anything under it carries `cls`. dom-shim does not parse
   index.html's children, so this only sees what the JS itself appended. */
const hasClass = (node, cls) => node.classList.contains(cls)
  || node.children.some((c) => hasClass(c, cls));

/* Reloading (a language switch, or ← 홈) must not hide what is already on
   screen: hiding the cards before the request and showing them after moved
   the week card 85px on every switch. The cards stay and dim instead (R2). */
test('reloading home keeps the painted cards in place and dims them while it waits', async () => {
  let release;
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD()); } });
  const reloading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('week-card').hidden, false, 'the week card must not collapse during a reload');
  assert.equal($('today-card').hidden, false);
  assert.equal($('recent-themes-wrap').hidden, false);
  assert.match(text($('today-body')), /호텔/, 'the painted recommendation must stay while it reloads');
  assert.ok($('today-card').classList.contains('is-refreshing'));
  assert.ok($('week-card').classList.contains('is-refreshing'));
  release();
  await reloading;
  assert.equal($('today-card').classList.contains('is-refreshing'), false);
  assert.equal($('week-card').classList.contains('is-refreshing'), false);
});

/* A failed reload for the language already on screen keeps it (it is still
   true); one for a different language hides it -- the old language's week and
   themes must never sit under the new language's button. */
/* After a language switch the previous language's cards stay on screen,
   dimmed, until the new answer lands. Dimmed must mean asleep: 계속 on the old
   language's resume card would set state.language back to that language
   behind the new language button. */
test('the dimmed cards cannot be used while home reloads after a language switch', async () => {
  router.register('session', 'session');
  state.language = 'en';
  state.sessionId = null;
  await armResumeCard();
  assert.equal($('resume-card').hidden, false);

  let release;
  const held = new Promise((r) => { release = r; });
  const opened = [];
  stubFetch(async (url) => {
    if (url.startsWith('/api/sessions/resumable')) { await held; return jsonResponse({ session: null }); }
    if (url.startsWith('/api/stats/home')) { await held; return jsonResponse(PAYLOAD()); }
    if (url.startsWith('/api/sessions/')) opened.push(url);
    return jsonResponse({ session: { id: 42, language: 'en' }, messages: [] });
  });
  state.language = 'ja';
  const reloading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));

  for (const id of ['today-card', 'resume-card', 'week-card', 'recent-themes-wrap']) {
    assert.equal($(id).inert, true, `#${id} is dimmed but still usable`);
  }
  await home.resumeSession();
  assert.deepEqual(opened, [], 'a dimmed resume card resumed a session');
  assert.equal(state.language, 'ja', 'a dimmed resume card changed the language');
  assert.equal(state.sessionId, null);

  release();
  await reloading;
  for (const id of ['today-card', 'resume-card', 'week-card', 'recent-themes-wrap']) {
    assert.equal($(id).inert, false, `#${id} stayed inert after the reload finished`);
  }
  state.language = 'en';
});

/* resumeSession makes the resumed session's language the app's; the language
   segments must say so too, or the next home load paints that language under
   the other button. */
test('resumeSession moves the language buttons to the resumed language', async () => {
  router.register('session', 'session');
  state.language = 'en';
  state.sessionId = null;
  const make = (lang) => { const b = document.createElement('button'); b.dataset.language = lang; return b; };
  const segs = [$('language-seg'), $('pick-language-seg')];
  for (const seg of segs) seg.replaceChildren(make('en'), make('ja'));
  await armResumeCard();
  stubFetch(async () => jsonResponse({ session: { id: 42, language: 'ja' }, messages: [] }));
  await home.resumeSession();
  assert.equal(state.language, 'ja');
  for (const seg of segs) {
    assert.deepEqual(seg.children.map((b) => b.classList.contains('on')), [false, true]);
  }
  state.language = 'en';
});

test('a failed reload keeps the same language painted but hides another language', async () => {
  state.language = 'en';
  homeRoutes(PAYLOAD());
  await home.loadHome();
  stubFetch(async () => { throw new Error('down'); });
  await home.loadHome();
  assert.equal($('today-card').hidden, false);
  assert.equal($('week-card').hidden, false);
  assert.equal($('today-card').classList.contains('is-refreshing'), false);

  state.language = 'ja';
  await home.loadHome();
  assert.equal($('today-card').hidden, true);
  assert.equal($('week-card').hidden, true);
  assert.equal($('today-card').classList.contains('is-refreshing'), false);
  state.language = 'en';
});

test('a newer switch that lands first clears the dimming even though the stale one lands later', async () => {
  state.language = 'en';
  homeRoutes(PAYLOAD());
  await home.loadHome();
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async (url) => {
    if (url.includes('language=en')) { await held; return jsonResponse(PAYLOAD()); }
    return jsonResponse(PAYLOAD());
  } });
  const stale = home.loadHome();
  state.language = 'ja';
  await home.loadHome();
  assert.equal($('today-card').classList.contains('is-refreshing'), false);
  release();
  await stale;
  assert.equal($('today-card').classList.contains('is-refreshing'), false);
  state.language = 'en';
});

test('the first load shows skeletons where the cards will be', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD()); } });
  const loading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(hasClass($('today-body'), 'skeleton'));
  assert.equal($('week-card').hidden, false, 'the week card holds its place on the first load');
  assert.ok($('week-card').classList.contains('is-skeleton'));
  assert.equal($('week-days').children.filter((c) => c.classList.contains('skeleton')).length, 7);
  // The streak line's row is held too, so a streak arriving does not grow the card.
  assert.equal($('week-streak').hidden, false, 'the streak row is not held on the first load');
  assert.ok($('week-streak').classList.contains('skeleton'));
  assert.equal($('week-streak').textContent, String.fromCharCode(0xa0));
  release();
  await loading;
  assert.equal($('week-streak').classList.contains('skeleton'), false);
  assert.equal($('week-streak').classList.contains('is-invisible'), false);
  assert.equal($('week-streak').textContent, '연속 2일');
  assert.equal(hasClass($('today-body'), 'skeleton'), false);
  assert.equal($('week-card').classList.contains('is-skeleton'), false);
  assert.equal(hasClass($('week-days'), 'skeleton'), false);
  assert.equal($('week-progress').classList.contains('skeleton'), false);
});

test('the alternative line keeps its place when there is no alternative', async () => {
  homeRoutes(PAYLOAD({ recommend: [PAYLOAD().recommend[0]] }));
  await home.loadHome();
  assert.equal($('today-alt').hidden, false);
  assert.ok($('today-alt').classList.contains('is-invisible'));
});

test('the start buttons on the recommendation keep one width whichever card is up', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const buttons = $('today-body').children.flatMap((c) => c.children || []).filter((b) => b.dataset.mode);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((b) => b.classList.contains('btn-stable')));
});

test("today's card shows the reason, disables a mode that is not ready, and swaps with the alternative", async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  assert.match(text($('today-body')), /아직 안 해본 테마예요/);
  assert.match(text($('today-body')), /체크인 · 방 문제 알리기 · 짐 맡기기/);
  assert.equal(text($('today-alt')), '또는: 회의 →');
  home.swapToday();
  assert.match(text($('today-body')), /회의/);
  const free = $('today-body').children.flatMap((c) => c.children || []).find((b) => b.dataset && b.dataset.mode === 'free');
  assert.equal(free.disabled, true);
  assert.equal(free.dataset.theme, 'meetings', 'the start button must carry the theme it starts');
  assert.match(text($('today-body')), /대본 준비 중/);
  assert.equal(text($('today-alt')), '또는: 호텔 →', 'the card that was swapped out becomes the alternative');
});

test('swapToday refocuses the new 또는 button, not the one the re-render replaced', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const before = $('today-alt').children[0];
  before.focus();
  assert.equal(document.activeElement, before);
  home.swapToday();
  const after = $('today-alt').children[0];
  assert.notEqual(after, before, 'paintToday rebuilds the button node');
  assert.equal(document.activeElement, after);
});

test('an empty library says scripts are being prepared', async () => {
  homeRoutes(PAYLOAD({ recommend: [] }));
  await home.loadHome();
  assert.match(text($('today-body')), /새 대본을 준비하고 있어요/);
  assert.equal($('today-alt').hidden, false);
  assert.ok($('today-alt').classList.contains('is-invisible'));
});

test('a first-time learner gets the welcome and no week or recent themes', async () => {
  homeRoutes(PAYLOAD({ has_history: false, recent_themes: [] }));
  await home.loadHome();
  assert.equal($('home-greeting').textContent, '첫 연습을 시작해 보세요');
  assert.equal($('week-card').hidden, true);
  assert.equal($('recent-themes-wrap').hidden, true);
});

test('a failed home request hides the recommendation but not the modes', async () => {
  stubFetch(async () => { throw new Error('down'); });
  await home.loadHome();
  assert.equal($('today-card').hidden, true);
  assert.equal($('modes').hidden, false);
  assert.equal($('week-card').hidden, true);
  assert.equal($('library-progress').hidden, true);
});

test('the week card: seven days, streak, progress and bar', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const days = $('week-days').children;
  assert.equal(days.length, 7);
  assert.ok(days[0].classList.contains('practiced'));
  assert.ok(days[2].classList.contains('today'));
  assert.ok(days[3].classList.contains('future'));
  assert.equal($('week-streak').textContent, '연속 2일');
  assert.equal($('week-progress').textContent, '이번 주 3/5 세션');
  assert.equal($('week-bar').style.width, '60%');
});

test('reaching the goal says so, and a zero streak keeps its line in place, invisible', async () => {
  const p = PAYLOAD({ streak: 0 });
  p.week.sessions = 6;
  homeRoutes(p);
  await home.loadHome();
  assert.equal($('week-progress').textContent, '이번 주 6/5 세션 · 목표 달성!');
  assert.equal($('week-bar').style.width, '100%');
  assert.equal($('week-streak').hidden, false, 'a zero streak collapsed its row and moved the progress line');
  assert.ok($('week-streak').classList.contains('is-invisible'));
  assert.equal($('week-streak').getAttribute('aria-hidden'), 'true');
});

test('the goal changes at once, is saved, stops at the bounds, and rolls back on failure', async () => {
  const seen = homeRoutes(PAYLOAD());
  await home.loadHome();
  await home.changeGoal(+1);
  assert.equal($('goal-value').textContent, '6');
  assert.deepEqual(seen.goals, [6]);

  const p = PAYLOAD(); p.week.goal = 14;
  homeRoutes(p); await home.loadHome();
  assert.equal($('goal-plus').disabled, true);

  homeRoutes(PAYLOAD(), { goal: () => jsonResponse({ detail: 'x' }, { ok: false, status: 500 }) });
  await home.loadHome();
  await home.changeGoal(-1);
  assert.equal($('goal-value').textContent, '5');
  assert.match($('notice-text').textContent, /목표를 저장하지 못했어요/);
});

test('while the goal saves both buttons are off, and the new value is already on screen', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = homeRoutes(PAYLOAD(), { goal: async () => { await held; return jsonResponse({ goal: 4 }); } });
  await home.loadHome();
  const saving = home.changeGoal(-1);
  assert.equal($('goal-value').textContent, '4');
  assert.equal($('week-progress').textContent, '이번 주 3/4 세션');
  assert.equal($('goal-minus').disabled, true);
  assert.equal($('goal-plus').disabled, true);
  await home.changeGoal(-1);             // pressed again mid-save: ignored
  release();
  await saving;
  assert.deepEqual(seen.goals, [4]);
  assert.equal($('goal-minus').disabled, false);
  assert.equal($('goal-plus').disabled, false);
});

test('changeGoal restores focus to the pressed button once disabling it while saving dropped it', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(PAYLOAD(), { goal: async () => { await held; return jsonResponse({ goal: 4 }); } });
  await home.loadHome();
  $('goal-minus').focus();
  const saving = home.changeGoal(-1);
  assert.equal($('goal-minus').disabled, true, 'disabling it is what drops focus in a real browser');
  release();
  await saving;
  assert.equal(document.activeElement, $('goal-minus'));
});

test('changeGoal restores focus to the pressed button on a rollback too', async () => {
  homeRoutes(PAYLOAD(), { goal: () => jsonResponse({ detail: 'x' }, { ok: false, status: 500 }) });
  await home.loadHome();
  $('goal-plus').focus();
  await home.changeGoal(+1);
  assert.equal(document.activeElement, $('goal-plus'));
});

test('recent themes render up to four and library progress shows only while incomplete', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  assert.equal($('recent-themes').children.length, 1);
  const card = $('recent-themes').children[0];
  assert.deepEqual([card.dataset.theme, card.dataset.mode], ['cafe-restaurant', 'script']);
  assert.equal(text(card), '카페·음식점 주문스크립트');
  assert.equal($('library-progress').textContent, '새 대본 준비 중 · 312/600편');
  assert.equal($('library-progress').classList.contains('is-invisible'), false);
  homeRoutes(PAYLOAD({ library: null }));
  await home.loadHome();
  assert.equal($('library-progress').hidden, false, 'an unknown library keeps the line\'s place');
  assert.ok($('library-progress').classList.contains('is-invisible'));
  homeRoutes(PAYLOAD({ library: { scripts: 600, target: 600 } }));
  await home.loadHome();
  assert.equal($('library-progress').hidden, true);
});

test('a stale response for another language is not painted', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async (url) => {
    if (url.includes('language=en')) { await held; return jsonResponse(PAYLOAD()); }
    return jsonResponse(PAYLOAD({ recommend: [{ ...PAYLOAD().recommend[1] }] }));
  } });
  state.language = 'en';
  const first = home.loadHome();
  state.language = 'ja';
  await home.loadHome();
  release();
  await first;
  assert.match(text($('today-body')), /회의/);
  state.language = 'en';
});
