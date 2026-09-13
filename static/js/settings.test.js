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
