/* 읽기 보조의 렌더러. 가장 중요한 테스트는 마지막 것이다 -- 요청이 실패해도
   줄이 평문으로 남아야 한다. 학습자가 읽어야 할 줄이 비는 것은 보조가 없는
   것보다 나쁘다. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';
import { renderTokens, getPrefs, setPrefs } from './reading.js';

const ALL = { furigana: true, romaji: true };

/* `prefs` is a module global, and every `await import('./reading.js')` below
   (no query string) resolves to the exact same cached instance as this
   file's static import above -- there is only ever one `reading.js` in this
   process. That is fine as long as nothing sets it, but Task 7 wires the
   settings checkboxes to `setPrefs`, and the moment a test calls it the
   value leaks into whatever test runs next in this same file (node's test
   runner runs a file's top-level tests in source order, not in parallel
   isolated processes). Reset explicitly before each test rather than via a
   fresh-URL re-import: a fresh import would hand back a *second* module
   instance whose `prefs` a `setPrefs` call here would never touch, while the
   tests above keep reading the first, statically-imported instance -- silently
   asserting against the wrong object. An explicit reset stays correct as
   long as it lists every key `prefs` has; that's the accepted cost. */
beforeEach(() => {
  setPrefs({ furigana: true, romaji: true });
});

test('a kanji token gets ruby over the kanji only', () => {
  const tokens = [{
    surface: '食べる', reading: 'たべる', romaji: 'taberu',
    parts: [{ text: '食', ruby: 'た' }, { text: 'べる', ruby: null }],
  }];
  const html = renderTokens(tokens, ALL);
  assert.match(html, /<ruby>食<rt>た<\/rt><\/ruby>/);
  assert.match(html, /べる/);
  assert.doesNotMatch(html, /<rt>たべる<\/rt>/);
});

test('a token with no ruby renders as plain text', () => {
  const tokens = [{
    surface: 'よやく', reading: 'よやく', romaji: 'yoyaku',
    parts: [{ text: 'よやく', ruby: null }],
  }];
  assert.doesNotMatch(renderTokens(tokens, ALL), /<ruby>/);
});

test('furigana off keeps the text and drops the ruby', () => {
  const tokens = [{
    surface: '食べる', reading: 'たべる', romaji: 'taberu',
    parts: [{ text: '食', ruby: 'た' }, { text: 'べる', ruby: null }],
  }];
  const html = renderTokens(tokens, { furigana: false, romaji: true });
  assert.doesNotMatch(html, /<ruby>/);
  assert.match(html, /食べる/);
});

test('romaji off drops the romaji line but keeps the japanese', () => {
  const tokens = [{
    surface: '寿司', reading: 'すし', romaji: 'sushi',
    parts: [{ text: '寿司', ruby: 'すし' }],
  }];
  const html = renderTokens(tokens, { furigana: true, romaji: false });
  assert.doesNotMatch(html, /sushi/);
  assert.match(html, /寿司/);
});

test('annotate upgrades every element in one request', async () => {
  resetDom();
  const { annotate } = await import('./reading.js');
  const requests = [];
  stubFetch(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ readings: [
      [{ surface: '寿司', reading: 'すし', romaji: 'sushi',
         parts: [{ text: '寿司', ruby: 'すし' }] }],
      [{ surface: '茶', reading: 'ちゃ', romaji: 'cha',
         parts: [{ text: '茶', ruby: 'ちゃ' }] }],
    ] });
  });

  const a = document.createElement('li');
  const b = document.createElement('li');
  await annotate([{ el: a, text: '寿司' }, { el: b, text: '茶' }]);

  assert.equal(requests.length, 1, '화면 단위로 한 번만 요청해야 한다');
  assert.deepEqual(requests[0].body.texts, ['寿司', '茶']);
  assert.match(a.innerHTML, /<rt>すし<\/rt>/);
  assert.match(b.innerHTML, /<rt>ちゃ<\/rt>/);
});

test('a failed reading request leaves the line readable', async () => {
  /* 이 테스트가 이 기능에서 가장 중요하다. 사전이 죽거나 요청이 실패했을 때
     학습자가 잃는 것은 보조여야지, 줄이어서는 안 된다. */
  resetDom();
  const { annotate } = await import('./reading.js');
  stubFetch(async () => jsonResponse({ detail: 'boom' }, { ok: false, status: 500 }));

  const el = document.createElement('li');
  el.textContent = 'いらっしゃいませ';
  await annotate([{ el, text: 'いらっしゃいませ' }]);

  assert.equal(el.textContent, 'いらっしゃいませ');
  assert.equal(el.innerHTML, '', '덧입히기가 실패하면 아무것도 덮어쓰지 않는다');
});

test('annotate asks for nothing when there is nothing to annotate', async () => {
  resetDom();
  const { annotate } = await import('./reading.js');
  let called = false;
  stubFetch(async () => { called = true; return jsonResponse({ readings: [] }); });
  await annotate([]);
  assert.equal(called, false);
});

test('the meaning toggle fetches once and then just reopens', async () => {
  resetDom();
  const { annotate, toggleMeaning } = await import('./reading.js');
  let translateCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/translate')) {
      translateCalls += 1;
      return jsonResponse({ meaning: '어서 오세요' });
    }
    return jsonResponse({ readings: [[{
      surface: 'いらっしゃいませ', reading: 'いらっしゃいませ', romaji: 'irasshaimase',
      parts: [{ text: 'いらっしゃいませ', ruby: null }],
    }]] });
  });

  const el = document.createElement('li');
  await annotate([{ el, text: 'いらっしゃいませ' }]);

  const body = document.createElement('span');
  await toggleMeaning(el, body);
  assert.equal(body.textContent, '어서 오세요');
  assert.equal(body.hidden, false);

  await toggleMeaning(el, body);          // 접는다
  assert.equal(body.hidden, true);
  await toggleMeaning(el, body);          // 다시 편다
  assert.equal(translateCalls, 1, '두 번째 펼침은 요청 없이 열려야 한다');
});

test('a failed translation says so instead of blanking the line', async () => {
  resetDom();
  const { toggleMeaning } = await import('./reading.js');
  stubFetch(async () => jsonResponse({ detail: 'down' }, { ok: false, status: 503 }));

  const el = document.createElement('li');
  el.dataset.ja = 'こんにちは';
  const body = document.createElement('span');
  await toggleMeaning(el, body);

  assert.match(body.textContent, /뜻을 가져오지 못했습니다/);
  assert.equal(el.dataset.ja, 'こんにちは', '원문은 그대로 남는다');
});

test('getPrefs returns the defaults, and a copy rather than a live reference', () => {
  const prefs = getPrefs();
  assert.deepEqual(prefs, { furigana: true, romaji: true });

  prefs.furigana = false; // mutating the returned object must not reach the module
  assert.deepEqual(getPrefs(), { furigana: true, romaji: true });
});

test('setPrefs changes what renderTokens defaults to when no options are given', () => {
  const tokens = [{
    surface: '寿司', reading: 'すし', romaji: 'sushi',
    parts: [{ text: '寿司', ruby: 'すし' }],
  }];
  setPrefs({ romaji: false });
  const html = renderTokens(tokens); // no options -- must fall back to the module's own prefs
  assert.doesNotMatch(html, /sushi/);
});

test('the next test never sees a previous test\'s setPrefs call', () => {
  /* Proof, not hope: this only passes if beforeEach actually restored the
     defaults after the previous test set romaji:false. */
  const tokens = [{
    surface: '寿司', reading: 'すし', romaji: 'sushi',
    parts: [{ text: '寿司', ruby: 'すし' }],
  }];
  const html = renderTokens(tokens); // no options
  assert.match(html, /sushi/);
});
