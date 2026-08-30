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
import { startSession } from './session.js';

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
