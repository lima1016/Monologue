/* 기록 지우기 through main.js's own wiring: a practice screen stays put when
 * the *other* language is cleared, and goes home when its own is. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch, jsonResponse } from './dom-shim.js';

const COUNTS = { sessions: 3, reports: 1, reviews: 0, timed_rounds: 0, level_tests: 1,
                 coach_notes: 0, recordings: 0 };

stubFetch(async (url) => {
  if (url.startsWith('/api/history/summary')) return jsonResponse({ counts: COUNTS });
  if (url === '/api/history/reset') return jsonResponse({ deleted: COUNTS });
  if (url.startsWith('/api/health')) return jsonResponse({ ollama: true, voicevox: true });
  return jsonResponse({});
});

const { $, state } = await import('./api.js');
const router = await import('./router.js');
await import('./main.js');

async function press(id) {
  for (const fn of $(id).listeners.click || []) await fn({ target: $(id) });
}

async function resetFrom(screen, language, scope) {
  router.show(screen);
  state.language = language;
  for (const s of ['en', 'ja', 'all']) $(`reset-scope-${s}`).checked = s === scope;
  $('settings').showModal();
  await press('btn-reset-open');
  assert.equal($('btn-reset-confirm').disabled, false);
  await press('btn-reset-confirm');
  assert.equal($('reset-confirm').open, false);
}

for (const screen of ['session', 'timed', 'leveltest']) {
  test(`clearing 日本語 from an English ${screen} screen leaves it where it is`, async () => {
    await resetFrom(screen, 'en', 'ja');
    assert.equal(router.current(), screen);
    assert.equal($(screen).hidden, false);
  });

  test(`clearing English (or both) from an English ${screen} screen goes home`, async () => {
    for (const scope of ['en', 'all']) {
      await resetFrom(screen, 'en', scope);
      assert.equal(router.current(), 'home', scope);
    }
  });
}
