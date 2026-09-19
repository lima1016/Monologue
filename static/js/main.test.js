/* The module graph itself, under test.
 *
 * The ledger recorded, as a finding, that the blank-page failure class was
 * something "no test suite caught it or can". That was wrong. Importing the
 * real main.js from disk over dom-shim.js catches a ReferenceError raised
 * while evaluating the graph, an unhandled rejection during startup, and an
 * id the JS looks up that index.html no longer declares -- all three of which
 * present in a browser as a screen that simply does not appear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { htmlIds, stubFetch, jsonResponse } from './dom-shim.js';

test('the whole module graph evaluates, and startup raises nothing', async () => {
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);

  stubFetch(async (url) => {
    if (url.startsWith('/api/health')) return jsonResponse({ ollama: true, voicevox: true });
    if (url.startsWith('/api/scenarios')) return jsonResponse({ scenarios: [] });
    if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
    if (url.startsWith('/api/stats/home')) {
      return jsonResponse({ streak: 0, week_turns: 0, fixed_total: 0, top_tags: [] });
    }
    return jsonResponse({});
  });

  // Dynamic, not a top-level import: a throw here must fail *this test* with
  // its own stack, rather than fail the file at load where it reads as the
  // harness being broken.
  await import('./main.js');

  // main.js fires refreshHealth/loadHome at load without awaiting
  // them. Give those promises room to settle before asking whether any of
  // them rejected with nobody listening.
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onRejection);

  assert.deepEqual(rejections.map((e) => e && e.message), [],
    'startup left an unhandled rejection');
});

test('every id the JS looks up is declared in index.html', () => {
  const ids = htmlIds();
  const dir = new URL('.', import.meta.url);
  const missing = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    if (file.endsWith('.test.js') || file === 'dom-shim.js') continue;
    const source = readFileSync(new URL(file, dir), 'utf8');
    const looked = [
      ...source.matchAll(/\$\('([^']+)'\)/g),
      ...source.matchAll(/getElementById\('([^']+)'\)/g),
      // Screen ids never appear as a literal at the lookup -- router.show
      // reads them back out of its map through a variable -- so the two
      // patterns above cannot see them. router.show now throws on a missing
      // screen, which is the real guard; this is the scan catching up, since
      // seeing ids is the one thing it is for.
      ...source.matchAll(/router\.register\('[^']+',\s*'([^']+)'\)/g),
    ].map((m) => m[1]);
    for (const id of new Set(looked)) {
      if (!ids.has(id)) missing.push(`${file}: #${id}`);
    }
  }
  assert.deepEqual(missing, [], 'JS looks up ids index.html does not declare');
});

/* No SpeechRecognition here (dom-shim installs none), so the mic's only answer
   is a notice. Shadowing hides the text input, so that notice must not send
   the learner to it. */
test('without speech recognition, the mic in shadowing does not point at the hidden input', async () => {
  const { $, state } = await import('./api.js');
  const click = $('btn-mic').listeners.click[0];
  state.shadowing = true;
  try {
    click();
    assert.doesNotMatch($('notice-text').textContent, /입력창/);
    assert.match($('notice-text').textContent, /쉐도잉/);
  } finally {
    state.shadowing = false;
  }
  click();
  assert.match($('notice-text').textContent, /입력창/, 'other modes still offer typing');
});

/* The wiring itself: home's two ways into my page each name their tab, over
   whatever tab was looked at last. */
test("home's 복습 card opens my page on 복습, and 기록 더 보기 on 기록", async () => {
  const { $ } = await import('./api.js');
  stubFetch(async () => jsonResponse({}));
  const data = { 'mypage-tab': 'weak' };
  globalThis.localStorage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
  try {
    $('review-home-go').listeners.click[0]();
    assert.equal($('tab-review').getAttribute('aria-selected'), 'true');
    data['mypage-tab'] = 'weak';
    $('week-more').listeners.click[0]();
    assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
    assert.equal($('history-section').hidden, false);
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    delete globalThis.localStorage;
  }
});

/* A Japanese IME confirms a conversion with Enter. That Enter arrives as a
   keydown with isComposing true, and must not start with half-typed text --
   in #pick-own (1분 말하기's own question) or #wish. */
test('Enter while an IME is composing starts nothing, in #pick-own or #wish', async () => {
  const { $, state } = await import('./api.js');
  const posts = [];
  stubFetch(async (url, options) => {
    if (options.method === 'POST') posts.push(url);
    return jsonResponse({ detail: 'no' }, { ok: false, status: 500 });
  });
  const before = { mode: state.mode, language: state.language };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    for (const [id, mode] of [['pick-own', 'timed'], ['wish', 'lesson']]) {
      state.mode = mode;
      $(id).value = 'かい';
      const keydown = $(id).listeners.keydown[0];
      keydown({ key: 'Enter', isComposing: true });
      await settle();
      assert.deepEqual(posts, [], `#${id}: an Enter that confirms a conversion started a session`);
      keydown({ key: 'Enter', isComposing: false });
      await settle();
      assert.equal(posts.length, 1, `#${id}: a plain Enter still starts`);
      posts.length = 0;
      $(id).value = '';
    }
  } finally {
    Object.assign(state, before);
    stubFetch(async () => jsonResponse({}));
  }
});
