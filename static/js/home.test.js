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

/* A resume does not go through startSession, which is what otherwise puts a
   shadowing session's card and its hidden dock controls away. */
test('resumeSession after a shadowing session puts the line card away and gives the dock back', async () => {
  router.register('session', 'session');
  state.language = 'ja';
  state.sessionId = null;
  await armResumeCard();
  state.shadowing = true;
  $('shadow-card').hidden = false;
  for (const id of ['text-input', 'btn-send']) $(id).hidden = true;

  stubFetch(async (url) => {
    if (url === '/api/sessions/42') {
      return jsonResponse({ session: { id: 42, language: 'ja' }, messages: [] });
    }
    return jsonResponse({});
  });

  await home.resumeSession();
  assert.equal(state.shadowing, false);
  assert.equal($('shadow-card').hidden, true);
  assert.equal($('text-input').hidden, false);
  assert.equal($('btn-send').hidden, false);
  assert.equal($('btn-next').hidden, true);
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

/* A resumed conversation is painted all at once; every bubble easing in
   together reads as the screen flashing. The replayed bubbles are marked so
   CSS skips their enter animation -- on the bubbles themselves, not a class on
   #conversation that is taken off afterwards: removing it would set their
   animation back from none and start every one of them at that moment. */
test('replayed bubbles skip the enter animation; a live one after them does not', async () => {
  router.register('session', 'session');
  state.language = 'en';
  state.sessionId = null;
  await armResumeCard();
  stubFetch(async () => jsonResponse({
    session: { id: 42, language: 'ko' },
    messages: [{ speaker: 'bot', text: 'Hi.' }, { speaker: 'user', text: 'Hello.' }],
  }));
  await home.resumeSession();
  const replayed = $('conversation').children;
  assert.equal(replayed.length, 2);
  assert.ok(replayed.every((b) => b.classList.contains('replayed')), 'a replayed bubble will animate');
  const { addMessage } = await import('./session.js');
  const live = addMessage('bot', 'Next?');
  assert.equal(live.classList.contains('replayed'), false);
  state.language = 'en';
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

  // The loading line takes the subtitle's place (both sit stacked in one
  // line, see index.html), so the card never grows a line: exactly one of
  // the two is visible at a time, and neither leaves the layout.
  const status = $('resume-status');
  const sub = $('resume-sub');
  const shown = (el) => !el.hidden && !el.classList.contains('is-invisible');
  const kept = (el) => !el.hidden && el.classList.contains('is-invisible');
  const resuming = home.resumeSession();
  assert.ok(shown(status), 'nothing said the resume was loading');
  assert.ok(kept(sub), 'the subtitle stayed visible under the loading line');
  release();
  await resuming;
  assert.ok(kept(status), 'the loading line collapsed its row or stayed up');
  assert.ok(shown(sub), 'the subtitle did not come back');

  failNext = true;
  const failing = home.resumeSession();
  assert.ok(shown(status) && kept(sub));
  await failing;
  assert.ok(kept(status) && shown(sub), 'a failed resume left the loading line up');
});

/* 이어서 하기 exists for one language and not the other, so a language switch
   used to pop it in and out and jump the week card 105px. It slides instead:
   a class (grid rows 1fr -> 0fr in CSS), never `hidden`. */
test('the resume card collapses by class when there is no session, and expands when there is', async () => {
  const card = $('resume-card');
  await armResumeCard();
  assert.equal(card.hidden, false);
  assert.equal(card.classList.contains('is-collapsed'), false);
  assert.notEqual(card.getAttribute('aria-hidden'), 'true');
  assert.equal(card.inert, false);

  homeRoutes(PAYLOAD());                  // no session under this language
  await home.loadHome();
  assert.equal(card.hidden, false, 'the card popped out with hidden instead of sliding');
  assert.ok(card.classList.contains('is-collapsed'));
  assert.equal(card.getAttribute('aria-hidden'), 'true');
  assert.equal(card.inert, true, 'a collapsed card must not take focus or clicks');

  await armResumeCard();
  assert.equal(card.classList.contains('is-collapsed'), false);
  assert.equal(card.inert, false);
});

/* A fresh page load that finds a session must not slide the card open -- it
   would be new motion on first paint. The first reveal goes through
   .no-motion with a style flush while that class is on; later reloads (a
   language switch) slide as before. The flush is spied through offsetHeight,
   which is what makes the browser apply the class before it comes off. */
test('the resume card appears without motion on first load and slides only on later reloads', async () => {
  const card = $('resume-card');
  const flushes = [];
  Object.defineProperty(card, 'offsetHeight', { get() {
    flushes.push({ noMotion: card.classList.contains('no-motion'), open: !card.classList.contains('is-collapsed') });
    return 0;
  } });
  await armResumeCard();
  assert.deepEqual(flushes, [{ noMotion: true, open: true }],
    'the first reveal was not flushed with .no-motion on, after opening');
  assert.equal(card.classList.contains('no-motion'), false, '.no-motion stayed on, so switches would not slide');

  flushes.length = 0;
  homeRoutes(PAYLOAD());                  // a reload: the card shuts
  await home.loadHome();
  await armResumeCard();                  // and opens again
  assert.deepEqual(flushes, [], 'a later reload skipped the slide');
  assert.equal(card.classList.contains('no-motion'), false);
});

test('a failed reload for another language shuts the resume card and puts it to sleep', async () => {
  state.language = 'en';
  await armResumeCard();
  stubFetch(async () => { throw new Error('down'); });
  state.language = 'ja';
  await home.loadHome();
  assert.ok($('resume-card').classList.contains('is-collapsed'));
  assert.equal($('resume-card').inert, true, 'the shut card still takes focus and clicks');
  state.language = 'en';
});

test('the aside still folds when the week card is hidden and the resume card collapsed', async () => {
  homeRoutes(PAYLOAD({ has_history: false }));
  await home.loadHome();
  assert.ok($('resume-card').classList.contains('is-collapsed'));
  assert.equal($('week-card').hidden, true);
  assert.ok($('home').classList.contains('no-aside'));
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
  // The real shape /stats/home sends (app/api.py's _recent_themes): mode is
  // the server's session mode ("script" even for shadowing), and shadowing
  // is its own field.
  recent_themes: [{ theme_id: 'cafe-restaurant', title: '카페·음식점 주문', mode: 'script', shadowing: false }],
  library: { scripts: 312, target: 600 },
  ...over,
});

function homeRoutes(payload, extra = {}) {
  const seen = { goals: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
    if (url.startsWith('/api/stats/home')) return extra.stats ? extra.stats(url) : jsonResponse(payload);
    if (url.startsWith('/api/level-test/latest')) return extra.latest ? extra.latest(url) : jsonResponse({});
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
  assert.equal($('resume-card').classList.contains('is-collapsed'), false);

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
  for (const id of ['today-card', 'week-card', 'recent-themes-wrap']) {
    assert.equal($(id).inert, false, `#${id} stayed inert after the reload finished`);
  }
  // No session under ja: the resume card is shut now, and stays asleep for that reason.
  assert.ok($('resume-card').classList.contains('is-collapsed'));
  assert.equal($('resume-card').inert, true, 'a collapsed resume card woke up with the others');
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
  // The numbers' and the level's rows are held too, so their values arriving
  // do not grow the card. (Desktop layout: 내 상태 replaced the streak line and
  // progress bar with these cells and the ring.)
  for (const id of ['week-streak', 'home-accuracy', 'home-level', 'home-level-scale']) {
    assert.equal($(id).hidden, false, `#${id}'s row is not held on the first load`);
    assert.ok($(id).classList.contains('skeleton'), `#${id} has no placeholder`);
    assert.equal($(id).textContent, String.fromCharCode(0xa0));
  }
  // The target panel holds its half of the hero while it may be coming.
  assert.equal($('home-target').hidden, false);
  assert.ok($('home-hero').classList.contains('has-target'));
  assert.ok($('home-target-fixed').classList.contains('skeleton'));
  assert.ok($('home-target-play').classList.contains('is-invisible'), 'the play row is not held while it loads');
  assert.equal($('home-target-play').hidden, false);
  release();
  await loading;
  assert.equal($('week-streak').classList.contains('skeleton'), false);
  assert.equal($('week-streak').classList.contains('is-invisible'), false);
  assert.equal($('week-streak').textContent, '2일');
  assert.equal(hasClass($('today-body'), 'skeleton'), false);
  assert.equal($('week-card').classList.contains('is-skeleton'), false);
  assert.equal(hasClass($('week-days'), 'skeleton'), false);
  for (const id of ['home-accuracy', 'home-level', 'home-level-scale', 'home-target-fixed']) {
    assert.equal($(id).classList.contains('skeleton'), false, `#${id} kept its placeholder`);
  }
  // PAYLOAD has no target: the hero goes back to one column.
  assert.equal($('home-target').hidden, true);
  assert.equal($('home-hero').classList.contains('has-target'), false);
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
  // The first three situations, one chip each (the desktop hero shows them as
  // chips rather than one ' · '-joined line).
  const chips = $('today-body').children.find((c) => c.classList.contains('today-situations'));
  assert.deepEqual(chips.children.map(text), ['체크인', '방 문제 알리기', '짐 맡기기']);
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

/* The ring's arc as a fraction of the circle, read off its dash pattern. */
const ringRatio = () => {
  const [on, whole] = $('week-ring-fill').getAttribute('stroke-dasharray').split(' ').map(Number);
  return on / whole;
};

test('the week card: seven days, streak, and the goal ring', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const days = $('week-days').children;
  assert.equal(days.length, 7);
  assert.ok(days[0].classList.contains('practiced'));
  assert.ok(days[2].classList.contains('today'));
  assert.ok(days[3].classList.contains('future'));
  assert.equal($('week-streak').textContent, '2일');
  assert.equal($('week-ring-num').textContent, '3/5');
  assert.equal($('week-ring-sub').textContent, '이번 주');
  assert.ok(Math.abs(ringRatio() - 0.6) < 0.001, `ring at ${ringRatio()}, not 3/5`);
  assert.equal($('week-ring').getAttribute('aria-label'), '이번 주 목표 5세션 중 3세션');
});

test('reaching the goal says so and fills the ring; a zero streak is 0일, not a hole', async () => {
  const p = PAYLOAD({ streak: 0 });
  p.week.sessions = 6;
  homeRoutes(p);
  await home.loadHome();
  assert.equal($('week-ring-num').textContent, '6/5');
  assert.equal($('week-ring-sub').textContent, '목표 달성!');
  assert.ok(Math.abs(ringRatio() - 1) < 0.001, 'past the goal the ring is full, never more');
  assert.equal($('week-streak').textContent, '0일');
  assert.equal($('week-streak').classList.contains('is-invisible'), false);
});

test('no session yet this week: the ring has no arc at all, not a round-capped dot', async () => {
  const p = PAYLOAD();
  p.week.sessions = 0;
  homeRoutes(p);
  await home.loadHome();
  assert.equal(ringRatio(), 0);
  assert.ok($('week-ring-fill').classList.contains('is-empty'));
  p.week.sessions = 1;
  homeRoutes(p);
  await home.loadHome();
  assert.equal($('week-ring-fill').classList.contains('is-empty'), false);
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
  assert.equal($('week-ring-num').textContent, '3/4');   // the ring redrawn at once
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

/* Task 4 fix round: a shadowing recent-theme card shows 쉐도잉, not the
 * underlying script mode name (same rule as mypage.js's history rows), and
 * carries data-mode="shadow" -- not the server's "script" -- since
 * startThemeButton (main.js) hands this straight to startTheme(mode, …),
 * which only recognises 'shadow' as its own mode (see pick.js's openPick). */
test('a shadowing recent theme reads 쉐도잉, not 스크립트, and starts as shadowing', async () => {
  homeRoutes(PAYLOAD({ recent_themes: [{ theme_id: 'cafe-restaurant', title: '카페·음식점 주문', mode: 'script', shadowing: true }] }));
  await home.loadHome();
  const card = $('recent-themes').children[0];
  assert.equal(text(card), '카페·음식점 주문쉐도잉');
  assert.equal(card.dataset.mode, 'shadow');
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

/* ---------- 오늘 복습 (home review card) ---------- */

/* #review-home exists only under a nonzero due count, and used to pop in and
   out like #resume-card once did. It slides instead, by class, never `hidden`
   -- see the UI-stability addendum for Task 4. */
test('the review card shows today\'s count and first sentence, and collapses at zero', async () => {
  homeRoutes(PAYLOAD({ review: { due: 3, first: { id: 11, fixed: 'I went there.' } } }));
  await home.loadHome();
  const card = $('review-home');
  assert.equal(card.hidden, false);
  assert.equal(card.classList.contains('is-collapsed'), false);
  assert.notEqual(card.getAttribute('aria-hidden'), 'true');
  assert.equal(card.inert, false);
  assert.equal($('review-home-count').textContent, '오늘 복습할 문장 3개');
  assert.equal($('review-home-first').textContent, 'I went there.');

  homeRoutes(PAYLOAD({ review: { due: 0, first: null } }));
  await home.loadHome();
  assert.equal(card.hidden, false, 'the card popped out with hidden instead of sliding');
  assert.ok(card.classList.contains('is-collapsed'));
  assert.equal(card.getAttribute('aria-hidden'), 'true');
  assert.equal(card.inert, true, 'a collapsed card must not take focus or clicks');
});

/* due and first disagreeing should never happen from the real payload, but
   the guard checks both -- not just `first` -- so a stale/malformed due of 0
   never shows a card with nothing actually due. */
test('a nonzero first with a zero due count still collapses the card', async () => {
  homeRoutes(PAYLOAD({ review: { due: 0, first: { id: 11, fixed: 'I went there.' } } }));
  await home.loadHome();
  assert.ok($('review-home').classList.contains('is-collapsed'));
});

test('a payload with no review field at all leaves the card collapsed', async () => {
  homeRoutes(PAYLOAD());   // the existing PAYLOAD helper carries no `review` key
  await home.loadHome();
  assert.ok($('review-home').classList.contains('is-collapsed'));
});

/* Same first-reveal rule as #resume-card: a fresh page load that already has
   a due count must not slide the card open -- that would be new motion on
   first paint. Later reloads (a language switch) slide as before. */
test('the review card appears without motion on first load and slides on a later reload', async () => {
  const card = $('review-home');
  const flushes = [];
  Object.defineProperty(card, 'offsetHeight', { get() {
    flushes.push({ noMotion: card.classList.contains('no-motion'), open: !card.classList.contains('is-collapsed') });
    return 0;
  } });
  homeRoutes(PAYLOAD({ review: { due: 2, first: { id: 5, fixed: 'Hi.' } } }));
  await home.loadHome();
  assert.deepEqual(flushes, [{ noMotion: true, open: true }],
    'the first reveal was not flushed with .no-motion on, after opening');
  assert.equal(card.classList.contains('no-motion'), false, '.no-motion stayed on, so switches would not slide');

  flushes.length = 0;
  homeRoutes(PAYLOAD());                   // a reload: the count drops to zero, the card shuts
  await home.loadHome();
  homeRoutes(PAYLOAD({ review: { due: 1, first: { id: 5, fixed: 'Hi.' } } }));
  await home.loadHome();                   // and opens again
  assert.deepEqual(flushes, [], 'a later reload skipped the slide');
});

/* Reloading must dim #review-home in place with the other cards (spec R2),
   not hide it, and take it out of clicks while the answer is in flight. */
test('the review card dims with the other cards while home reloads, and wakes when it lands', async () => {
  let release;
  homeRoutes(PAYLOAD({ review: { due: 2, first: { id: 5, fixed: 'Hi.' } } }));
  await home.loadHome();
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => {
    await held;
    return jsonResponse(PAYLOAD({ review: { due: 2, first: { id: 5, fixed: 'Hi.' } } }));
  } });
  const reloading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('review-home').hidden, false, 'the review card must not collapse during a reload');
  assert.ok($('review-home').classList.contains('is-refreshing'));
  assert.equal($('review-home').inert, true, 'a dimmed card must not take clicks');
  release();
  await reloading;
  assert.equal($('review-home').classList.contains('is-refreshing'), false);
  assert.equal($('review-home').inert, false);
});

test('listening on the home review card shows the preparing copy', async () => {
  const played = [];
  homeRoutes(PAYLOAD({ review: { due: 1, first: { id: 11, fixed: 'I went there.' } } }), {});
  stubFetch(async (url) => {
    if (url === '/api/review/11/audio') { played.push(url); return jsonResponse({ audio_key: 'k' }); }
    if (url.startsWith('/api/stats/home')) return jsonResponse(PAYLOAD({ review: { due: 1, first: { id: 11, fixed: 'I went there.' } } }));
    return jsonResponse({ session: null });
  });
  await home.loadHome();
  const p = home.playReviewHome();
  assert.equal($('review-home-play').textContent, '음성 준비 중...');
  await p;
  assert.equal($('review-home-play').textContent, '▶ 듣기');
  assert.deepEqual(played, ['/api/review/11/audio']);
});

/* 1분 말하기 (Task 5): the fifth mode card on home, and its name wherever a
 * past session is listed. The shim has no markup (only ids), so the card is
 * read out of index.html itself; main.js hands its data-mode straight to
 * openPick, whose label for it pick.test.js checks. */
test('home carries a fifth mode card, 1분 말하기, that opens the pick screen as timed', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const modes = html.split('id="modes"')[1].split('</div>')[0];
  const cardModes = [...modes.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cardModes, ['free', 'script', 'shadow', 'lesson', 'timed']);
  const timed = modes.split('data-mode="timed"')[1].split('</button>')[0];
  assert.match(timed, /<span class="n">1분 말하기<\/span>/);
  assert.match(timed, /<span class="d">질문 하나에 1분 동안 말하고 다시 말해 비교<\/span>/);
  const pick = await import('./pick.js');
  stubFetch(async () => jsonResponse({ themes: [], scenarios: [] }));
  router.register('pick', 'pick');
  await pick.openPick('timed');
  assert.equal($('pick-mode').textContent, '1분 말하기');
});

test('a 1분 말하기 recent theme reads 1분 말하기', async () => {
  homeRoutes(PAYLOAD({ recent_themes: [{ theme_id: 'cafe-restaurant', title: '카페·음식점 주문', mode: 'timed', shadowing: false }] }));
  await home.loadHome();
  const card = $('recent-themes').children[0];
  assert.equal(text(card), '카페·음식점 주문1분 말하기');
  assert.equal(card.dataset.mode, 'timed');
});

/* ---------- 레벨 테스트 card ---------- */

const LATEST = (byLanguage) => (url) => {
  const lang = new URL(url, 'http://x').searchParams.get('language');
  const v = byLanguage[lang];
  return v instanceof Error ? jsonResponse({ detail: 'x' }, { ok: false, status: 500 }) : jsonResponse({ result: v });
};
const deepText = (n) => (n.textContent || '') + (n.childNodes || []).map(deepText).join('');
const cardOpen = () => !$('leveltest-home').classList.contains('is-collapsed');

test('no level test yet in this language: the card offers one, with IELTS and TOEFL for English', async () => {
  state.language = 'en';
  const asked = [];
  homeRoutes(PAYLOAD(), { latest: (url) => { asked.push(url); return LATEST({ en: null })(url); } });
  await home.loadHome();
  assert.deepEqual(asked, ['/api/level-test/latest?language=en']);
  const card = $('leveltest-home');
  assert.equal(card.hidden, false);
  assert.ok(cardOpen());
  assert.equal(card.getAttribute('aria-hidden'), 'false');
  assert.equal(card.inert, false);
  assert.equal(deepText($('leveltest-home-text')), '레벨 테스트 · 7분이면 내 수준과 IELTS·TOEFL 예상 점수를 알 수 있어요');
});

/* Desktop layout: the card no longer shuts once there is a result -- it says
   when the last test was and what it gave, with 결과 보기 and 다시 테스트. */
test('a finished level test in this language: the card says when and what, with 결과 보기 and 다시 테스트', async () => {
  state.language = 'en';
  homeRoutes(PAYLOAD(), { latest: LATEST({ en: { cefr: 'B1', step: '상위', finished_at: '2026-09-19T12:00:00+00:00' } }) });
  await home.loadHome();
  assert.ok(cardOpen());
  assert.equal($('leveltest-home').inert, false);
  assert.equal(deepText($('leveltest-home-text')), '지난 테스트 9월 19일 · B1 상위');
  assert.equal($('leveltest-home-show').hidden, false);
  assert.equal($('leveltest-home-start').textContent, '다시 테스트');
});

test('no test yet: 결과 보기 is not offered and the button says 시작', async () => {
  state.language = 'en';
  homeRoutes(PAYLOAD(), { latest: LATEST({ en: { cefr: 'B1', step: '상위' } }) });
  await home.loadHome();
  homeRoutes(PAYLOAD(), { latest: LATEST({ en: null }) });
  await home.loadHome();
  assert.equal($('leveltest-home-show').hidden, true);
  assert.equal($('leveltest-home-start').textContent, '시작');
});

test('the card is decided again on a language switch, and Japanese names JF Standard', async () => {
  const latest = LATEST({ en: null, ja: { cefr: 'A2', step: '하위' } });
  state.language = 'en';
  homeRoutes(PAYLOAD(), { latest });
  await home.loadHome();
  assert.ok(cardOpen());
  state.language = 'ja';
  await home.loadHome();
  assert.ok(cardOpen(), 'Japanese has a test: the card shows it');
  assert.equal(deepText($('leveltest-home-text')), '지난 테스트 · A2 하위', 'no finished_at: no date, no stray space');
  homeRoutes(PAYLOAD(), { latest: LATEST({ en: null, ja: null }) });
  await home.loadHome();
  assert.ok(cardOpen());
  assert.equal(deepText($('leveltest-home-text')), '레벨 테스트 · 7분이면 내 수준과 JF 스탠다드 레벨을 알 수 있어요');
  state.language = 'en';
});

test('the latest-result request failing keeps the card shut and the rest of home loads', async () => {
  state.language = 'en';
  homeRoutes(PAYLOAD({ review: { due: 2, first: { id: 5, fixed: 'Hi.' } } }), { latest: LATEST({ en: new Error() }) });
  await home.loadHome();
  assert.equal(cardOpen(), false);
  assert.equal($('review-home').classList.contains('is-collapsed'), false);
  assert.equal($('week-card').hidden, false);
});

/* ---------- desktop home: target panel, level line, tiles ---------- */

const TARGET = { id: 77, tag: '시제', text: 'I buy it', fixed: 'I bought it.' };

test('a target splits the hero: its tag and fixed sentence in the panel, and the 약점 line stays shut', async () => {
  homeRoutes(PAYLOAD({ target: TARGET, top_tags: [{ tag: '시제', n: 4 }] }));
  await home.loadHome();
  assert.equal($('home-target').hidden, false);
  assert.ok($('home-hero').classList.contains('has-target'));
  assert.equal($('home-target-tag').textContent, '초점: 시제');
  assert.equal($('home-target-fixed').textContent, 'I bought it.');
  assert.equal($('home-target-play').hidden, false);
  assert.equal($('home-target-play').classList.contains('is-invisible'), false);
  assert.equal($('recommend').hidden, true, 'the panel says what 요즘 X에서 자주 걸립니다 said');
});

test('no target: no panel, the recommendation has the whole hero, and the 약점 line stays shut too', async () => {
  homeRoutes(PAYLOAD({ target: TARGET }));
  await home.loadHome();
  homeRoutes(PAYLOAD({ target: null, top_tags: [{ tag: '시제', n: 4 }] }));
  await home.loadHome();
  assert.equal($('home-target').hidden, true);
  assert.equal($('home-hero').classList.contains('has-target'), false);
  assert.equal($('recommend').hidden, true);
});

test('the target panel dims with the other cards while home reloads', async () => {
  homeRoutes(PAYLOAD({ target: TARGET }));
  await home.loadHome();
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD({ target: TARGET })); } });
  const reloading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('home-target').hidden, false, 'the panel must not vanish during a reload');
  assert.ok($('home-target').classList.contains('is-refreshing'));
  assert.equal($('home-target').inert, true);
  release();
  await reloading;
  assert.equal($('home-target').inert, false);
});

test('▶ 들어 보기 asks for the target message\'s clip and says 음성 준비 중... meanwhile', async () => {
  const asked = [];
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(PAYLOAD({ target: TARGET }));
  await home.loadHome();
  stubFetch(async (url) => {
    asked.push(url);
    await held;
    return jsonResponse({ audio_key: 'k1' });
  });
  const playing = home.playTargetHome();
  assert.equal($('home-target-play').textContent, '음성 준비 중...');
  // The shim does not parse markup classes, so the button's own tag is read:
  // .btn-stable holds its width while the label changes.
  const html = (await import('node:fs')).readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="home-target-play" class="[^"]*\bbtn-stable\b/);
  release();
  await playing;
  assert.equal($('home-target-play').textContent, '▶ 들어 보기');
  assert.deepEqual(asked, ['/api/messages/77/fixed-audio']);
});

test('the level beside the ring: the test\'s level and scale, 레벨 테스트 전, or a dash when unknown', async () => {
  state.language = 'en';
  homeRoutes(PAYLOAD(), { latest: LATEST({ en: { cefr: 'B1', step: '상위', ielts: '5.0' } }) });
  await home.loadHome();
  assert.equal($('home-level').textContent, 'B1 상위');
  assert.equal($('home-level-scale').textContent, 'IELTS 말하기 5.0 예상');

  homeRoutes(PAYLOAD(), { latest: LATEST({ en: null }) });
  await home.loadHome();
  assert.equal($('home-level').textContent, '레벨 테스트 전');
  assert.equal($('home-level-scale').textContent, String.fromCharCode(0xa0), 'the scale row keeps its height');

  homeRoutes(PAYLOAD(), { latest: LATEST({ en: new Error() }) });
  await home.loadHome();
  assert.equal($('home-level').textContent, '—', 'a failed request is not "not tested"');

  state.language = 'ja';
  homeRoutes(PAYLOAD(), { latest: LATEST({ ja: { cefr: 'A2', step: '하위', jf: 'JF A2 하위' } }) });
  await home.loadHome();
  assert.equal($('home-level-scale').textContent, 'JF A2 하위');
  state.language = 'en';
});

test('accuracy is the 30-day percentage, and a dash when nothing was graded', async () => {
  homeRoutes(PAYLOAD({ accuracy: { correct: 7, graded: 9 } }));
  await home.loadHome();
  assert.equal($('home-accuracy').textContent, '78%');
  homeRoutes(PAYLOAD({ accuracy: { correct: 0, graded: 0 } }));
  await home.loadHome();
  assert.equal($('home-accuracy').textContent, '—');
});

test('결과 보기 opens the result this load found on the level test screen, with 홈으로', async () => {
  router.register('leveltest', 'leveltest');
  state.language = 'en';
  const result = { cefr: 'B1', step: '상위', ielts: '5.0', finished_at: '2026-09-19T12:00:00+00:00' };
  homeRoutes(PAYLOAD(), { latest: LATEST({ en: result }) });
  await home.loadHome();
  home.showLevelResultHome();
  assert.equal(router.current(), 'leveltest');
  assert.match(deepText($('lt-result-body')), /B1 상위/);
  const { levelResultFrom } = await import('./leveltest.js');
  assert.equal(levelResultFrom(), 'home');
});

test('a mode tile names its latest theme only when recent themes has one for that mode', async () => {
  homeRoutes(PAYLOAD({ recent_themes: [
    { theme_id: 'hotel', title: '호텔', mode: 'free', shadowing: false },
    { theme_id: 'cafe-restaurant', title: '카페·음식점 주문', mode: 'script', shadowing: true },
    { theme_id: 'meetings', title: '회의', mode: 'free', shadowing: false },
  ] }));
  await home.loadHome();
  assert.equal(text($('mode-recent-free')), '최근 호텔', 'the newest free theme, not the older one');
  assert.equal(text($('mode-recent-shadow')), '최근 카페·음식점 주문', 'a shadowing session is filed under 쉐도잉');
  for (const mode of ['script', 'lesson', 'timed']) {
    assert.equal(text($(`mode-recent-${mode}`)), '', `${mode} has no recent theme but got a line`);
  }
  homeRoutes(PAYLOAD({ has_history: false, recent_themes: [] }));
  await home.loadHome();
  assert.equal(text($('mode-recent-free')), '', 'another language\'s line stayed');
});

test('recent themes show up to six', async () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => ({ theme_id: t, title: t, mode: 'free', shadowing: false }));
  homeRoutes(PAYLOAD({ recent_themes: six }));
  await home.loadHome();
  assert.equal($('recent-themes').children.length, 6);
});

test('the aside stays when only the level test card is in it', async () => {
  homeRoutes(PAYLOAD({ has_history: false }), { latest: LATEST({ en: null }) });
  state.language = 'en';
  await home.loadHome();
  assert.equal($('week-card').hidden, true);
  assert.ok(cardOpen());
  assert.equal($('home').classList.contains('no-aside'), false,
    'the level test card sits in the aside; folding it would hide the card');
});

test('a lesson recent theme reads 수업, not its mode key', async () => {
  homeRoutes(PAYLOAD({ recent_themes: [{ theme_id: 'x', title: '현재완료', mode: 'lesson', shadowing: false }] }));
  await home.loadHome();
  assert.equal(text($('recent-themes').children[0]), '현재완료수업');
});
