/* The home screen's start path, driven over dom-shim.js with a stubbed fetch.
 *
 * These two are the automated proof of the whole-branch review's Critical:
 * /scenarios/generate is a multi-second local-model call, and the language
 * segment and the mode cards stay live throughout it. If startFromHome
 * re-reads `state` after that await, a switch landing mid-generation posts the
 * *new* language (or mode) together with the *old* one's scenario id, and the
 * session is stamped one way and bound the other -- permanently, with nothing
 * on screen to say so. Both tests must fail if that capture is reverted.
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
   preceding failure left startFromHome's promise pending with `busy === true`,
   so that test's own startFromHome() returned at the guard and asserted
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

/* Answers every request the wish path makes, and hands back a handle on the
   one that matters: `release` resolves the pending /scenarios/generate call,
   and `sessionBody` is whatever POST /sessions was finally sent. */
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
  $('wish').value = '병원 접수';                 // nothing in the catalogue matches
  const { seen, release } = stubStartPath();

  const started = home.startFromHome();
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

  const started = home.startFromHome();
  await new Promise((r) => setTimeout(r, 0));
  state.mode = 'lesson';                        // lesson would null the scenario_id out
  release();
  await started;

  assert.equal(seen.sessionBody.mode, 'free',
    'POST /sessions carried the mode the scenario was generated under');
  assert.equal(seen.sessionBody.scenario_id, 'user-en-free-1');
  assert.equal(seen.sessionBody.topic, null);
});

/* Fills resumeTarget the only way anything can: through loadHome. */
async function armResumeCard() {
  stubFetch(async (url) => {
    if (url.startsWith('/api/sessions/resumable')) {
      return jsonResponse({ session: { id: 42, mode: 'free', title: '병원 접수',
                                       goal: '접수한다', turns: 4 } });
    }
    if (url.startsWith('/api/stats/home')) {
      return jsonResponse({ streak: 1, week_turns: 4, fixed_total: 0, top_tag: null });
    }
    return jsonResponse({});
  });
  await home.loadHome();
}

test('이어서 하기 during a generation wait does not hijack the session being started', async () => {
  state.language = 'en';
  state.mode = 'free';
  state.sessionId = null;
  await armResumeCard();

  $('wish').value = '병원 접수';
  const { seen, release } = stubStartPath();
  const started = home.startFromHome();
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
  state.mode = 'free';
  state.sessionId = null;
  await armResumeCard();

  let releaseMessages;
  const messages = new Promise((r) => { releaseMessages = r; });
  let sessionPosts = 0;
  stubFetch(async (url) => {
    if (url === '/api/sessions/42') { await messages; return jsonResponse({ messages: [] }); }
    if (url.startsWith('/api/scenarios?')) return jsonResponse({ scenarios: [{ id: 'x', title: 't' }] });
    if (url === '/api/sessions') { sessionPosts += 1; return jsonResponse({ session_id: 9, mode: 'free' }); }
    return jsonResponse({});
  });

  const resuming = home.resumeSession();
  await new Promise((r) => setTimeout(r, 0));

  $('wish').value = '';
  await home.startFromHome();          // the learner presses 시작 while the resume is in flight
  assert.equal(sessionPosts, 0, 'a new session was created on top of an in-flight resume');

  releaseMessages();
  await resuming;
  assert.equal(state.sessionId, 42);
});

/* A resume that fails must not leave the home screen permanently unable to
   start anything -- the failure mode a guard flag without a `finally` has. */
test('a failed resume releases the guard', async () => {
  state.sessionId = null;
  await armResumeCard();
  stubFetch(async (url) => {
    if (url === '/api/sessions/42') return jsonResponse({ detail: 'gone' }, { ok: false, status: 500 });
    return jsonResponse({});
  });
  await home.resumeSession();
  assert.equal(state.sessionId, null);

  $('wish').value = '병원 접수';
  const { seen, release } = stubStartPath();
  const started = home.startFromHome();
  release();
  await started;
  assert.ok(seen.sessionBody, 'the home screen was still locked after a failed resume');
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

/* The third door: nothing typed, so the catalogue picks for the learner. Same
   capture rule as the two tests at the top of this file, through a shorter
   window -- a local GET rather than the multi-second generate call -- and the
   branch that had no test of its own.

   Where the window actually is, on this path: not on the catalogue request.
   With an empty wish nothing is awaited between capturing `language` and
   building that URL, so it is already in flight as `en` before any switch can
   land -- the first assertion below pins exactly that. The window opens once
   the GET resolves, and closes at POST /sessions: a scenario drawn from the
   captured language must be posted under it, not under whatever the language
   segment says by the time the POST is built. */
test('an empty wish posts a scenario from the language it was captured under', async () => {
  state.language = 'en';
  state.mode = 'free';
  state.sessionId = null;
  $('wish').value = '';                          // nothing typed: pick one for me

  let releaseCatalogue;
  const held = new Promise((r) => { releaseCatalogue = r; });
  const seen = { sessionBody: null, catalogue: [] };
  stubFetch(async (url, options) => {
    if (url.startsWith('/api/scenarios?')) {
      seen.catalogue.push(url);
      await held;                                // the catalogue GET, held open
      // Each language's catalogue is disjoint, so the posted id says which one
      // the scenario was drawn from -- and every scenario in a list is the
      // same answer, so the random pick cannot make this flaky.
      return jsonResponse({ scenarios: url.includes('language=ja')
        ? [{ id: 'ja-1', title: '受付' }, { id: 'ja-2', title: '道案内' }]
        : [{ id: 'en-1', title: 'reception' }, { id: 'en-2', title: 'directions' }] });
    }
    if (url === '/api/sessions') {
      seen.sessionBody = JSON.parse(options.body);
      return jsonResponse({ session_id: 7, mode: 'free', opening: 'Hi.',
                            opening_audio: null, goal: 'g' });
    }
    return jsonResponse({});
  });

  const started = home.startFromHome();
  await new Promise((r) => setTimeout(r, 0));    // let it reach the catalogue await
  state.language = 'ja';                         // 日本語 pressed while it waits
  releaseCatalogue();
  await started;

  assert.deepEqual(seen.catalogue, ['/api/scenarios?language=en&mode=free'],
    'the catalogue was fetched for a language other than the captured one');
  assert.equal(seen.sessionBody.language, 'en');
  assert.match(seen.sessionBody.scenario_id, /^en-/,
    'POST /sessions bound an en session to a scenario from the switched-to language');
});
