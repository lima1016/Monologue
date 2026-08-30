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
      return jsonResponse({ streak: 0, week_turns: 0, fixed_total: 0, top_tag: null });
    }
    return jsonResponse({});
  });

  // Dynamic, not a top-level import: a throw here must fail *this test* with
  // its own stack, rather than fail the file at load where it reads as the
  // harness being broken.
  await import('./main.js');

  // main.js fires loadChips/refreshHealth/loadHome at load without awaiting
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
