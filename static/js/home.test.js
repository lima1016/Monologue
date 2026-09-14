/* The home screen's resume path and history panels, driven over dom-shim.js
 * with a stubbed fetch. The start path (and the tests proving start and resume
 * exclude each other) moved to pick.test.js with startFromPick.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

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

/* Task 6: the right-hand column (이어하기/통계/최근 기록) collapses when there is
   nothing in it to show, and comes back the moment there is. */
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
    '이어하기·통계·최근 기록이 모두 없으면 오른쪽 330px 트랙이 빈 채로 남는다');
});

test('볼 것이 하나라도 생기면 두 칸으로 되돌린다', async () => {
  $('home').classList.add('no-aside');   // 앞선 첫 실행 상태
  stubFetch(async (url) => {
    if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
    if (url.startsWith('/api/stats/home')) {
      return jsonResponse({ streak: 3, week_turns: 12, fixed_total: 4, top_tags: [], recent: [] });
    }
    return jsonResponse({});
  });

  await home.loadHome();

  assert.ok(!$('home').classList.contains('no-aside'));
});

test('요청이 실패해도 한 칸으로 접는다', async () => {
  stubFetch(async () => { throw new Error('down'); });

  await home.loadHome();

  assert.ok($('home').classList.contains('no-aside'),
    'catch 경로도 오른쪽 칸을 다 숨긴다 -- 숨긴 채로 트랙만 남기면 안 된다');
});

/* R16: ended_at is db._now()'s format -- an ISO string with a UTC offset
   (`+00:00`), never a trailing `Z`. Built here in exactly that shape rather
   than with a literal, so the test still passes at any time of day. */
test('relativeDay reads 오늘/어제 from a +00:00-offset ISO string', () => {
  const { relativeDay } = home;
  const fmt = (d) => d.toISOString().slice(0, 19) + '+00:00';
  assert.equal(relativeDay(fmt(new Date())), '오늘');
  assert.equal(relativeDay(fmt(new Date(Date.now() - 24 * 60 * 60 * 1000))), '어제');
});
