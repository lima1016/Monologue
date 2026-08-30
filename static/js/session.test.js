/* startScript builds the script panel's HTML by interpolating each line's
 * text directly into innerHTML. Scenario text now comes from a local LLM
 * (POST /scenarios/generate), so a script line is no longer necessarily
 * something this codebase wrote -- it must be escaped the same way
 * renderTokens (reading.js) already escapes every token it draws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';
import { startSession, nextScriptLine } from './session.js';

test('a script line with HTML-like text is escaped, not injected, into the panel', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en'; // avoid the ja-only annotate() round trip; irrelevant to escaping
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [{ speaker: 'bot', text: '<img src=x onerror=alert(1)>' }],
      });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 's1' });

  const html = $('panel-body').innerHTML;
  assert.doesNotMatch(html, /<img/, 'raw HTML from a script line must not reach innerHTML unescaped');
  assert.match(html, /&lt;img/);
});

/* Fix 1: advanceScript plays a bot line's audio and draws its bubble at the
 * same moment. Before this fix the bubble was drawn a beat later, only when
 * the learner pressed next -- what they heard was never what the chat log
 * showed at the time they heard it. */
test('a bot script line gets its bubble the same moment its audio would play', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [
          { speaker: 'bot', text: 'Morning! Ready for standup?', audio_key: 'k0' },
          { speaker: 'user', text: "Yeah, give me a sec. Okay, I'm ready." },
        ],
      });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'standup-meeting-en' });

  const bubbles = $('conversation').children.filter((n) => n.className === 'msg bot');
  assert.equal(bubbles.length, 1, 'the opening bot line must already be drawn, not deferred to next');
  assert.equal(bubbles[0].textContent, 'Morning! Ready for standup?');
  assert.equal(bubbles[0].dataset.audioKey, 'k0');
});

test('advancing past a bot line does not draw a second bubble for it', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [
          { speaker: 'bot', text: 'Morning!', audio_key: 'k0' },
          { speaker: 'user', text: 'Hi.' },
        ],
      });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  await nextScriptLine(); // learner presses "next" past the bot's line

  const botBubbles = $('conversation').children.filter((n) => n.className === 'msg bot');
  assert.equal(botBubbles.length, 1, 'the bot line must be drawn exactly once, not twice');
});

test('drawing a bot script line stores it, keyed by its own index', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const stored = [];
  stubFetch(async (url, options) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 42,
        mode: 'script',
        lines: [{ speaker: 'bot', text: 'Morning!', audio_key: 'k0' }],
      });
    }
    if (url === '/api/sessions/42/script-line') {
      stored.push(JSON.parse(options.body));
      return jsonResponse({ stored: true });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });

  assert.deepEqual(stored, [{ index: 0 }]);
});

test('a failed script-line store does not interrupt the session', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [{ speaker: 'bot', text: 'Morning!', audio_key: 'k0' }],
      });
    }
    if (url === '/api/sessions/1/script-line') return jsonResponse({}, { ok: false, status: 500 });
    return jsonResponse({});
  });

  // Must not throw or reject -- the bubble is already drawn and that is the
  // contract, the same as reading.js's annotate().
  await assert.doesNotReject(
    startSession({ language: 'en', mode: 'script', scenarioId: 'x' }),
  );
  assert.equal($('conversation').children.filter((n) => n.className === 'msg bot').length, 1);
});

/* Fix 3: the learner's script turn posts to /script-turn, not /chat -- no LLM
 * reply to invent, no grammar feedback to render. */
test('a script turn is sent to /script-turn, not /chat', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const calls = [];
  stubFetch(async (url, options) => {
    calls.push(url);
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 7,
        mode: 'script',
        lines: [{ speaker: 'user', text: 'Hello.' }],
      });
    }
    if (url === '/api/script-turn') return jsonResponse({ turn: 1 });
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  $('text-input').value = 'Hello.';
  await nextScriptLine();

  assert.ok(calls.includes('/api/script-turn'), 'must post to /script-turn');
  assert.ok(!calls.includes('/api/chat'), 'must not post to /chat');
});

test('reading the script line correctly shows a good accuracy result', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 7,
        mode: 'script',
        lines: [{ speaker: 'user', text: 'Hello there.' }],
      });
    }
    return jsonResponse({ turn: 1 });
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  $('text-input').value = 'hello there'; // matches() ignores case/punctuation
  await nextScriptLine();

  const result = $('conversation').children.find((n) => n.className.includes('respeak-result'));
  assert.ok(result, 'an accuracy result must be rendered under the learner bubble');
  assert.ok(result.className.includes('good'));
});

test('reading the script line differently shows the script original, not a grammar chip', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 7,
        mode: 'script',
        lines: [{ speaker: 'user', text: 'Hello there.' }],
      });
    }
    return jsonResponse({ turn: 1 });
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  $('text-input').value = 'This is something completely different.';
  await nextScriptLine();

  const result = $('conversation').children.find((n) => n.className.includes('respeak-result'));
  assert.ok(result);
  assert.ok(result.className.includes('bad'));
  assert.match(result.textContent, /Hello there\./, 'must show the script line itself, not just "wrong"');
  // Not a grammar chip -- there is nothing to correct, the learner read the line.
  assert.equal($('conversation').children.some((n) => n.className.includes('chip')), false);
});
