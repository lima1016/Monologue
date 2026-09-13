/* The settings dialog shows only the chosen language's settings.
 *
 * The voice list already followed the language select; the Japanese reading
 * aids did not, so an English dialog carried a furigana/romaji block that had
 * nothing to do with it.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $ } from './api.js';
import { resetDom } from './dom-shim.js';
import { syncLanguageSections } from './settings.js';

beforeEach(() => resetDom());

test('an English dialog hides the Japanese reading aids', () => {
  $('settings-language').value = 'en';
  syncLanguageSections();
  assert.equal($('reading-prefs').hidden, true);
});

test('switching the dialog to Japanese shows them again', () => {
  $('settings-language').value = 'en';
  syncLanguageSections();
  $('settings-language').value = 'ja';
  syncLanguageSections();
  assert.equal($('reading-prefs').hidden, false);
});

test('the pronunciation script choice is saved with the other reading prefs', async () => {
  const { saveReadingPrefs, loadReadingPrefs } = await import('./settings.js');
  const { stubFetch, jsonResponse } = await import('./dom-shim.js');
  const posted = [];
  stubFetch(async (url, options) => {
    if (options.method === 'POST') { posted.push(JSON.parse(options.body)); return jsonResponse({}); }
    return jsonResponse({ furigana: true, romaji: true, pron_script: 'romaji' });
  });

  await loadReadingPrefs();
  assert.equal($('pref-pron-romaji').checked, true);
  assert.equal($('pref-pron-hangul').checked, false);

  $('pref-pron-hangul').checked = true;
  $('pref-pron-romaji').checked = false;
  await saveReadingPrefs();
  assert.deepEqual(posted, [{ furigana: true, romaji: true, pron_script: 'hangul' }]);
});
