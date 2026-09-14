/* 💡 뭐라고 하지? -- 카드는 물어본 봇 말풍선에 붙고, 누르면 듣기만 한다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';
import * as suggest from './suggest.js';

function bubble(who, text) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  $('conversation').appendChild(div);
  return div;
}

const REPLIES = [
  { text: 'Window, please.', meaning: '창가로 주세요.', audio_key: 'k1' },
  { text: 'Aisle is fine.', meaning: null, audio_key: null },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// By class, not className: a card on its way out also carries fade/is-invisible.
const cardsOnScreen = () => $('conversation').children.filter((n) => n.classList.contains('suggest-card'));

function setup() {
  resetDom();
  state.language = 'en';
  state.sessionId = 7;
}

test('the button shows in free and lesson mode only', () => {
  setup();
  suggest.setSuggestVisible('free');
  assert.equal($('btn-suggest').hidden, false);
  suggest.setSuggestVisible('lesson');
  assert.equal($('btn-suggest').hidden, false);
  suggest.setSuggestVisible('script');
  assert.equal($('btn-suggest').hidden, true);
});

test('the card lands after the bot line that was asked about, even if another arrives first', async () => {
  setup();
  const asked = bubble('bot', 'Window or aisle?');
  let release;
  const requests = [];
  stubFetch((url, options) => {
    requests.push({ url, options });
    return new Promise((r) => { release = () => r(jsonResponse({ replies: REPLIES })); });
  });
  const pending = suggest.suggestForLatest();
  assert.equal($('btn-suggest').disabled, true, '요청 중에는 연타할 수 없다');
  bubble('user', 'Window.');
  bubble('bot', 'Any bags?');
  release();
  await pending;

  const kids = $('conversation').children;
  const card = kids[kids.indexOf(asked) + 1];
  assert.equal(card.className, 'suggest-card');
  assert.equal(requests[0].url, '/api/sessions/7/suggest');
  assert.equal($('btn-suggest').disabled, false);
});

test('the card sits under the bot line even when my reply already follows it', async () => {
  setup();
  const asked = bubble('bot', 'Window or aisle?');
  const mine = bubble('user', 'Window.');
  stubFetch(async () => jsonResponse({ replies: REPLIES }));
  await suggest.suggestForLatest();

  const kids = $('conversation').children;
  assert.equal(kids[kids.indexOf(asked) + 1].className, 'suggest-card');
  assert.equal(kids.indexOf(mine), kids.indexOf(asked) + 2, '카드가 내 말풍선보다 앞에 온다');
});

test('a card shows each reply with its meaning and its audio, and nothing that sends', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  stubFetch(async () => jsonResponse({ replies: REPLIES }));
  await suggest.suggestForLatest();
  const card = $('conversation').children.find((n) => n.className === 'suggest-card');
  assert.equal(card.children[0].textContent, suggest.SUGGEST_TITLE);

  const rows = card.children.filter((n) => n.className === 'suggest-row');
  assert.equal(rows.length, 2);
  const [line1, meaning1] = rows[0].children;
  assert.equal(line1.className, 'suggest-line');
  assert.equal(line1.dataset.source, 'Window, please.');
  assert.equal(line1.dataset.audioKey, 'k1');
  assert.equal(meaning1.className, 'suggest-meaning');
  assert.equal(meaning1.textContent, '창가로 주세요.');

  const line2 = rows[1].children[0];
  assert.equal(line2.dataset.audioKey, undefined);
  assert.ok(line2.childNodes.some((n) => n.className === 'meaning'), '뜻이 없으면 ▸ 뜻 버튼');
  assert.equal($('text-input').value ?? '', '', '입력칸을 채우지 않는다');
});

test('asking again on the same bot line does not ask the server again', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  let calls = 0;
  stubFetch(async () => { calls += 1; return jsonResponse({ replies: REPLIES }); });
  await suggest.suggestForLatest();
  await suggest.suggestForLatest();
  assert.equal(calls, 1);
  assert.equal($('conversation').children.filter((n) => n.className === 'suggest-card').length, 1);
});

test('a failure takes the card down, says so, and can be asked again', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  stubFetch(async () => jsonResponse({ detail: '지금은 추천을 만들 수 없어요' }, { ok: false, status: 503 }));
  await suggest.suggestForLatest();
  await wait(160);                     // the card fades out before it goes
  assert.equal(cardsOnScreen().length, 0);
  assert.match($('notice-text').textContent, /지금은 추천을 만들 수 없어요/);

  stubFetch(async () => jsonResponse({ replies: REPLIES }));
  await suggest.suggestForLatest();
  assert.equal(cardsOnScreen().length, 1);
});

test('a failure that arrives after the learner moved to another session stays quiet', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  let release;
  stubFetch(() => new Promise((r) => {
    release = () => r(jsonResponse({ detail: '지금은 추천을 만들 수 없어요' }, { ok: false, status: 503 }));
  }));
  const pending = suggest.suggestForLatest();
  state.sessionId = 999; // the learner started a new session before the response came back
  release();
  await pending;
  await wait(160);

  assert.equal(cardsOnScreen().length, 0,
    '카드는 여전히 치운다');
  assert.equal($('notice-text').textContent, '', '다른 세션으로 넘어간 뒤에는 실패를 알리지 않는다');

  // The WeakMap entry for the original bubble was cleared too -- asking again
  // (conceptually, back on the original session) would hit the server again
  // rather than silently doing nothing.
  let calls = 0;
  stubFetch(async () => { calls += 1; return jsonResponse({ replies: REPLIES }); });
  state.sessionId = 7;
  await suggest.suggestForLatest();
  assert.equal(calls, 1);
});

/* A failed card fades (.fade + .is-invisible) before it is removed, rather
   than the loading card vanishing in one frame. */
test('a failed card fades out, then is removed', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  stubFetch(async () => jsonResponse({ detail: 'x' }, { ok: false, status: 503 }));
  await suggest.suggestForLatest();
  const [card] = cardsOnScreen();
  assert.ok(card, 'the card vanished in one frame instead of fading');
  assert.ok(card.classList.contains('fade') && card.classList.contains('is-invisible'));
  await wait(160);
  assert.equal(cardsOnScreen().length, 0);
});

test('under reduced motion a failed card goes at once', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  const saved = window.matchMedia;
  window.matchMedia = () => ({ matches: true });
  try {
    stubFetch(async () => jsonResponse({ detail: 'x' }, { ok: false, status: 503 }));
    await suggest.suggestForLatest();
    assert.equal(cardsOnScreen().length, 0);
  } finally {
    window.matchMedia = saved;
  }
});

test('with no bot line there is nothing to ask', async () => {
  setup();
  let calls = 0;
  stubFetch(async () => { calls += 1; return jsonResponse({ replies: REPLIES }); });
  await suggest.suggestForLatest();
  assert.equal(calls, 0);
});

test('a Japanese reply with no meaning still gets a ▸ 뜻 button when /reading fails', async () => {
  setup();
  state.language = 'ja';
  stubFetch(async (url) => {
    if (url === '/api/reading') return jsonResponse({ detail: 'down' }, { ok: false, status: 503 });
    return jsonResponse({ replies: [{ text: '窓側で。', meaning: null, audio_key: null }] });
  });
  bubble('bot', '窓側と通路側、どちらがいいですか。');
  await suggest.suggestForLatest();
  await new Promise((r) => setTimeout(r, 0)); // let annotate's failed fetch settle

  const card = $('conversation').children.find((n) => n.className === 'suggest-card');
  const row = card.children.find((n) => n.className === 'suggest-row');
  const line = row.children[0];
  assert.ok(line.children.some((n) => n.className === 'meaning'),
    '읽기 보조가 실패해도 뜻 버튼은 있어야 한다');
});

test('Japanese reply lines get reading aids', async () => {
  setup();
  state.language = 'ja';
  const texts = [];
  stubFetch(async (url, options) => {
    if (url === '/api/reading') { texts.push(...JSON.parse(options.body).texts); return jsonResponse({ readings: [] }); }
    return jsonResponse({ replies: [{ text: 'はい、窓側で。', meaning: '네, 창가로요.', audio_key: 'k' }] });
  });
  bubble('bot', '窓側と通路側、どちらがいいですか。');
  await suggest.suggestForLatest();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(texts, ['はい、窓側で。']);
});
