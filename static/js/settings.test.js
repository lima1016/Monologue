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
  assert.equal($('lang-section-ja').classList.contains('is-inactive'), true);
  assert.equal($('lang-section-ja').inert, true);
  assert.equal($('lang-section-ja').getAttribute('aria-hidden'), 'true');
  assert.equal($('lang-section-en').classList.contains('is-inactive'), false);
  assert.equal($('lang-section-en').inert, false);
  assert.equal($('lang-section-en').getAttribute('aria-hidden'), 'false');
  // Not removed, not display:none/[hidden] -- still in the tree, holding its
  // height in the shared grid cell (components.css: .lang-sections).
  assert.equal($('reading-prefs').hidden, false);
});

test('switching the dialog to Japanese shows them again, and the English section is left in place, only inert', () => {
  $('settings-language').value = 'en';
  syncLanguageSections();
  $('settings-language').value = 'ja';
  syncLanguageSections();
  assert.equal($('lang-section-ja').classList.contains('is-inactive'), false);
  assert.equal($('lang-section-ja').inert, false);
  assert.equal($('lang-section-ja').getAttribute('aria-hidden'), 'false');
  assert.equal($('lang-section-en').classList.contains('is-inactive'), true);
  assert.equal($('lang-section-en').inert, true);
  assert.equal($('lang-section-en').getAttribute('aria-hidden'), 'true');
});

test('both languages\' voice lists are rendered at once, into their own containers', async () => {
  const { renderVoiceLists } = await import('./settings.js');
  const { stubFetch, jsonResponse } = await import('./dom-shim.js');
  stubFetch(async (url) => {
    const language = new URL(url, 'http://x').searchParams.get('language');
    const voices = language === 'en'
      ? [{ id: 'a', label: 'A', gender: 'female' }]
      : [{ id: 'b', label: 'B', gender: 'male' }, { id: 'c', label: 'C', gender: 'female' }];
    return jsonResponse({ voices, selected: voices[0].id });
  });
  await renderVoiceLists();
  assert.match($('voice-list-en').innerHTML, /id="v-a"/);
  assert.doesNotMatch($('voice-list-en').innerHTML, /id="v-b"/);
  assert.match($('voice-list-ja').innerHTML, /id="v-b"/);
  assert.match($('voice-list-ja').innerHTML, /id="v-c"/);
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

/* ---------- 화면: theme and brightness ---------- */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { THEMES, MODES, applyTheme, initScreenPrefs, readScreenPrefs, watchSystemScheme } from './settings.js';

const html = () => document.documentElement;

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}
const throwingStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};

function withStorage(storage, fn) {
  globalThis.localStorage = storage;
  try { return fn(); } finally { delete globalThis.localStorage; }
}

test('choosing a theme sets data-theme on <html> and saves it', () => {
  const s = memoryStorage();
  withStorage(s, () => applyTheme('forest', 'auto'));
  assert.equal(html().getAttribute('data-theme'), 'forest');
  assert.equal(s.data['screen-theme'], 'forest');
});

test('choosing a brightness sets data-mode and saves it', () => {
  const s = memoryStorage();
  withStorage(s, () => applyTheme('default', 'dark'));
  assert.equal(html().getAttribute('data-mode'), 'dark');
  assert.equal(s.data['screen-mode'], 'dark');
});

test('aria-pressed marks the chosen swatch and brightness, and only those', () => {
  withStorage(memoryStorage(), () => applyTheme('sea', 'light'));
  for (const t of THEMES) {
    assert.equal($(`theme-${t}`).getAttribute('aria-pressed'), String(t === 'sea'), t);
  }
  for (const m of MODES) {
    assert.equal($(`mode-${m}`).getAttribute('aria-pressed'), String(m === 'light'), m);
    assert.equal($(`mode-${m}`).classList.contains('on'), m === 'light', m);
  }
});

test('unknown values fall back to 기본 / 자동', () => {
  const applied = withStorage(memoryStorage(), () => applyTheme('neon', 'dim'));
  assert.deepEqual(applied, { theme: 'default', mode: 'auto' });
  assert.equal(html().getAttribute('data-theme'), 'default');
});

test('storage that throws: the choice still applies, nothing crashes', () => {
  withStorage(throwingStorage, () => {
    assert.doesNotThrow(() => applyTheme('ink', 'dark'));
    assert.deepEqual(readScreenPrefs(), { theme: 'default', mode: 'auto' });
  });
  assert.equal(html().getAttribute('data-theme'), 'ink');
  assert.equal(html().getAttribute('data-mode'), 'dark');
});

test('no storage at all reads as the defaults', () => {
  assert.deepEqual(readScreenPrefs(), { theme: 'default', mode: 'auto' });
});

test('the swatch and brightness buttons apply on click, keeping the other half', () => {
  const s = memoryStorage();
  withStorage(s, () => {
    html().setAttribute('data-theme', 'white');
    html().setAttribute('data-mode', 'dark');
    initScreenPrefs();
    assert.equal($('theme-white').getAttribute('aria-pressed'), 'true');
    $('theme-lavender').listeners.click.at(-1)();
    assert.equal(html().getAttribute('data-theme'), 'lavender');
    assert.equal(html().getAttribute('data-mode'), 'dark');
    $('mode-light').listeners.click.at(-1)();
    assert.equal(html().getAttribute('data-theme'), 'lavender');
    assert.equal(html().getAttribute('data-mode'), 'light');
  });
  assert.deepEqual(s.data, { 'screen-theme': 'lavender', 'screen-mode': 'light' });
});

/* The pre-paint script in index.html's <head>, run as the browser would: in
   its own context, with only document and localStorage. */
function headScript() {
  const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const head = src.slice(0, src.indexOf('</head>'));
  const m = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'no inline script in <head>');
  return m[1];
}
function runHeadScript(storage) {
  const attrs = {};
  const documentElement = { setAttribute: (k, v) => { attrs[k] = String(v); } };
  const ctx = { document: { documentElement } };
  if (storage) ctx.localStorage = storage;
  runInNewContext(headScript(), ctx);
  return attrs;
}

test('the head script applies the saved theme and brightness', () => {
  const attrs = runHeadScript(memoryStorage({ 'screen-theme': 'forest', 'screen-mode': 'dark' }));
  assert.deepEqual(attrs, { 'data-theme': 'forest', 'data-mode': 'dark' });
});

test('the head script accepts every theme and mode settings.js offers', () => {
  for (const t of THEMES) {
    for (const m of MODES) {
      const attrs = runHeadScript(memoryStorage({ 'screen-theme': t, 'screen-mode': m }));
      assert.deepEqual(attrs, { 'data-theme': t, 'data-mode': m });
    }
  }
});

test('the head script falls back to 기본/자동 on junk, empty or throwing storage', () => {
  const fallback = { 'data-theme': 'default', 'data-mode': 'auto' };
  assert.deepEqual(runHeadScript(memoryStorage({ 'screen-theme': 'neon', 'screen-mode': 'x' })), fallback);
  assert.deepEqual(runHeadScript(memoryStorage()), fallback);
  assert.deepEqual(runHeadScript(throwingStorage), fallback);
  // No localStorage global at all: the ReferenceError is caught too.
  assert.deepEqual(runHeadScript(null), fallback);
});

/* ---------- the tab icon follows 자동 across an OS scheme flip ----------
   The colour math itself (favicon.svg's shapes, the data: URL, the "leave
   it alone" cases) is favicon.test.js's job; this is only about *when*
   settings.js asks for a repaint. */

const realGetComputedStyle = globalThis.getComputedStyle;
const realMatchMedia = globalThis.matchMedia;
function stubAccent(color) {
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (prop) => (prop === '--accent' ? color : ''),
  });
}
function restoreGlobals() {
  if (realGetComputedStyle === undefined) delete globalThis.getComputedStyle;
  else globalThis.getComputedStyle = realGetComputedStyle;
  if (realMatchMedia === undefined) delete globalThis.matchMedia;
  else globalThis.matchMedia = realMatchMedia;
}

test('no matchMedia at all: watchSystemScheme does not throw', () => {
  delete globalThis.matchMedia;
  try {
    assert.doesNotThrow(() => watchSystemScheme());
  } finally {
    restoreGlobals();
  }
});

test('the OS scheme flipping while brightness is 자동 repaints the tab icon', () => {
  try {
    stubAccent('#a85a3c');
    withStorage(memoryStorage(), () => applyTheme('default', 'auto'));
    const before = $('favicon-link').getAttribute('href');

    let onChange;
    globalThis.matchMedia = () => ({ addEventListener: (type, fn) => { if (type === 'change') onChange = fn; } });
    watchSystemScheme();
    stubAccent('#d98b64');
    onChange();

    const after = $('favicon-link').getAttribute('href');
    assert.notEqual(after, before);
    assert.match(decodeURIComponent(after), /fill="#d98b64"/);
  } finally {
    restoreGlobals();
  }
});

test('the OS scheme flipping while brightness is fixed (밝게/어둡게) leaves the tab icon alone', () => {
  try {
    stubAccent('#a85a3c');
    withStorage(memoryStorage(), () => applyTheme('default', 'light'));
    const before = $('favicon-link').getAttribute('href');

    let onChange;
    globalThis.matchMedia = () => ({ addEventListener: (type, fn) => { if (type === 'change') onChange = fn; } });
    watchSystemScheme();
    stubAccent('#d98b64');
    onChange();

    assert.equal($('favicon-link').getAttribute('href'), before);
  } finally {
    restoreGlobals();
  }
});
