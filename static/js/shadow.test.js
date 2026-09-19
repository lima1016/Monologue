/* Shadowing's line card: a line is heard first, said, judged by the server,
 * and only then shown. Driven over dom-shim.js with a stubbed fetch, through
 * session.js's own heard path (handleHeard -> sendHeard), so the card is
 * tested behind the same door the mic uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

/* A fake SpeechRecognition, installed before session.js (and, transitively,
 * audio.js) is ever evaluated -- the same fake and the same reason as
 * session.test.js: without one, `recognition` comes back null, the mic counts
 * as unsupported, and a test could not tell "the save gave the mic back" from
 * "the mic never existed".
 *
 * `session.js` and `shadow.js` are therefore imported dynamically, after this
 * is installed on `window` -- a plain top-level `import` is hoisted and would
 * evaluate audio.js (and cache its `recognition` as null) before this file's
 * own code had a chance to run. */
class FakeRecognition {
  start() {}
  stop() {}
  abort() {}
}
window.webkitSpeechRecognition = FakeRecognition;

/* dom-shim's Audio records nothing; this one keeps every clip made, so a test
 * can see which line was played and at what speed. */
const clips = [];
globalThis.Audio = class Audio {
  constructor(src) { this.src = src; this.paused = false; clips.push(this); }
  addEventListener() {}
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
};
const lastClip = () => clips[clips.length - 1];

const session = await import('./session.js');
const shadow = await import('./shadow.js');

/* main.js, for the mic button's own click handler. Its startup reads a few
 * routes; answered here so nothing rejects. The handler is taken now: every
 * test's resetDom() hands out fresh elements with no listeners on them, and
 * the handler itself looks its elements up afresh on each call. */
stubFetch(async (url) => {
  if (url.startsWith('/api/health')) return jsonResponse({ ollama: true, voicevox: true });
  if (url.startsWith('/api/scenarios')) return jsonResponse({ scenarios: [] });
  if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
  if (url.startsWith('/api/stats/home')) {
    return jsonResponse({ streak: 0, week_turns: 0, fixed_total: 0, top_tags: [] });
  }
  return jsonResponse({});
});
await import('./main.js');
const micClick = $('btn-mic').listeners.click[0];
await new Promise((resolve) => setTimeout(resolve, 20));

const LINES = [
  { speaker: 'bot', text: 'Morning! Ready for standup?', audio_key: 'a0' },
  { speaker: 'user', text: 'Yes, I am ready.', audio_key: 'a1' },
];

/* One session's worth of routes. `line` answers /shadow-line (default: a
 * match, row 7), `audio` the recording upload, `reading` Japanese reading
 * aids, `lines` the script; every request body is kept for the test to read. */
function routes({ line, audio, reading, lines = LINES } = {}) {
  const seen = { lines: [], audio: [], ends: 0, reading: [] };
  stubFetch(async (url, options = {}) => {
    if (url === '/api/sessions') {
      const body = JSON.parse(options.body);
      return jsonResponse(body.shadowing
        ? { session_id: 1, mode: 'script', shadowing: true, lines }
        : { session_id: 2, mode: 'script', lines: LINES });
    }
    if (url === '/api/sessions/1/shadow-line') {
      seen.lines.push(JSON.parse(options.body));
      return line ? line() : jsonResponse({ message_id: 7, matched: true });
    }
    if (url === '/api/sessions/1/audio') {
      seen.audio.push(options.body.get('message_id'));
      return audio ? audio() : jsonResponse({});
    }
    if (url === '/api/reading') {
      seen.reading.push(JSON.parse(options.body).texts);
      return reading ? reading() : jsonResponse({ readings: [] });
    }
    if (url === '/api/sessions/1/end') {
      seen.ends += 1;
      return jsonResponse({ kind: 'shadow' });
    }
    return jsonResponse({});
  });
  return seen;
}

async function begin(opts = {}) {
  resetDom();
  router.register('session', 'session');
  router.register('report', 'report');
  const language = opts.language || 'en';
  state.language = language;
  state.chunks = [];
  const seen = routes(opts);
  await session.startSession({ language, mode: 'script', scenarioId: 'x', shadowing: true });
  return seen;
}

/* A response the test releases when it chooses. */
function later() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { respond: () => promise, release };
}

// The card's line text lives in a span of its own, fresh per line.
const cardText = () => $('shadow-text').children[0];

// Lets heard()'s save, and the upload after it, finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* The mic's own path: a listen ends and its transcript (null: nothing heard)
 * reaches session.js, which hands it to the card. */
async function say(text) {
  session.setTurnState('MIC');
  await session.handleHeard(text, null);
  await settle();
}

const panelItems = () => $('panel-body').children[0].children;
const panelText = (i) => panelItems()[i].children[1].textContent;

test('a shadowing session opens the line card, hides every line, and plays the first', async () => {
  clips.length = 0;
  await begin();
  assert.equal($('shadow-card').hidden, false);
  assert.equal($('conversation').children.length, 0, 'no bubbles: the card is the conversation');
  for (const id of ['btn-next', 'btn-send', 'text-input', 'btn-suggest']) {
    assert.equal($(id).hidden, true, `#${id} should be hidden`);
  }
  assert.equal($('shadow-count').textContent, '1 / 2');
  assert.equal(panelItems().length, 2);
  assert.equal(panelText(0), '●●●●●');
  assert.equal(panelText(1), '●●●●●');
  assert.equal(shadow.shadowState().stage, 'listen');
  assert.match(lastClip().src, /a0/);
});

test('천천히 듣기 plays the same clip at 0.75; 다시 듣기 at normal speed', async () => {
  await begin();
  shadow.replaySlow();
  assert.equal(lastClip().playbackRate, 0.75);
  assert.match(lastClip().src, /a0/);
  shadow.replay();
  assert.equal(lastClip().playbackRate, 1);
});

test('글자 보기 shows the line and the attempt is sent as peeked', async () => {
  const seen = await begin();
  shadow.peek();
  assert.equal($('shadow-text').classList.contains('is-invisible'), false);
  assert.equal(cardText().textContent, 'Morning! Ready for standup?');
  assert.equal(shadow.shadowState().peeked, true);
  await say('morning ready for standup');
  assert.deepEqual(seen.lines, [{ index: 0, text: 'morning ready for standup', peeked: true }]);
});

test('a said line is saved, judged by the server, and then revealed', async () => {
  const seen = await begin();
  await say('morning ready for standup');
  assert.deepEqual(seen.lines, [{ index: 0, text: 'morning ready for standup', peeked: false }]);
  assert.equal(shadow.shadowState().stage, 'reveal');
  assert.equal($('shadow-mine').textContent, '내 말: "morning ready for standup"');
  assert.equal($('shadow-verdict').textContent, '✓ 대본과 같아요');
  assert.equal($('shadow-verdict').classList.contains('good'), true);
  assert.equal($('shadow-reveal-actions').hidden, false);
  assert.equal($('shadow-listen-actions').hidden, true);
  assert.equal($('shadow-text').classList.contains('is-invisible'), false);
  assert.equal($('shadow-said').classList.contains('is-invisible'), false);
  assert.match(panelText(0), /^Morning! Ready for standup\?/);
  assert.equal(panelText(1), '●●●●●', 'a line not reached yet stays hidden');
  assert.equal($('btn-mic').disabled, false, 'the save gives the mic back');
  assert.equal($('shadow-play-mine').disabled, true, 'no recording: nothing for ▶ 내 발음 to play');
});

test('a line the server says differs reads 조금 달라요', async () => {
  await begin({ line: () => jsonResponse({ message_id: 7, matched: false }) });
  await say('morning');
  assert.equal($('shadow-verdict').textContent, '✗ 조금 달라요');
  assert.equal($('shadow-verdict').classList.contains('bad'), true);
});

test('nothing heard saves nothing and asks again', async () => {
  const seen = await begin();
  await say(null);
  assert.equal(seen.lines.length, 0);
  assert.equal($('shadow-status').textContent, '못 알아들었어요. 다시 해보세요');
  assert.equal(shadow.shadowState().stage, 'listen');
  assert.equal($('btn-mic').disabled, false);
});

test('다시 하기 says the same line again', async () => {
  const seen = await begin();
  await say('morning');
  shadow.retry();
  assert.equal(shadow.shadowState().stage, 'listen');
  assert.equal($('shadow-text').classList.contains('is-invisible'), false, 'the line stays shown');
  assert.equal($('shadow-said').classList.contains('is-invisible'), true);
  assert.equal($('shadow-listen-actions').hidden, false);
  assert.equal($('shadow-reveal-actions').hidden, true);
  await say('x');
  assert.deepEqual(seen.lines.map((b) => b.index), [0, 0]);
});

test('an attempt after the reveal counts as peeked: the text is on screen', async () => {
  const seen = await begin();
  await say('morning');
  assert.equal($('shadow-peeked').classList.contains('is-invisible'), true, 'the first attempt did not peek');
  shadow.retry();
  await say('morning ready for standup');
  assert.deepEqual(seen.lines.map((b) => b.peeked), [false, true]);
  assert.equal($('shadow-peeked').classList.contains('is-invisible'), false);
});

test('speaking again straight from the reveal, without 다시 하기, counts as peeked too', async () => {
  const seen = await begin();
  await say('morning');
  await say('morning ready for standup');
  assert.deepEqual(seen.lines.map((b) => [b.index, b.peeked]), [[0, false], [0, true]]);
});

test('a failed save keeps what was said, stays on the line, and gives the mic back', async () => {
  await begin({ line: () => jsonResponse({ detail: 'boom' }, { ok: false, status: 500 }) });
  state.chunks = ['x'];
  await say('morning ready');
  assert.equal($('notice-text').textContent, '저장하지 못했어요');
  assert.equal(shadow.shadowState().stage, 'listen');
  assert.equal(shadow.shadowState().saving, false);
  assert.equal($('shadow-mine').textContent, '내 말: "morning ready"');
  assert.equal($('shadow-said').classList.contains('is-invisible'), false);
  assert.equal($('shadow-verdict').textContent, '', 'no verdict for a line never judged');
  assert.deepEqual(state.chunks, [], 'the recording has no row to go to');
  assert.equal($('btn-mic').disabled, false);
});

test('the last line offers the report, and 다음 there ends the session', async () => {
  const seen = await begin();
  await say('morning');
  await shadow.nextLine();
  await say('yes i am ready');
  assert.equal($('shadow-next').textContent, '끝! 리포트 보기');
  await shadow.nextLine();
  assert.equal(seen.ends, 1);
});

test('다음 줄 moves on without moving the card: parts fade, they are not removed', async () => {
  await begin();
  await say('morning');
  assert.equal($('shadow-next').textContent, '다음 줄 →');
  await shadow.nextLine();
  assert.equal($('shadow-count').textContent, '2 / 2');
  assert.equal(shadow.shadowState().stage, 'listen');
  assert.equal(shadow.shadowState().peeked, false);
  for (const id of ['shadow-text', 'shadow-said']) {
    assert.equal($(id).classList.contains('is-invisible'), true, `#${id} fades out`);
    assert.equal($(id).hidden, false, `#${id} keeps its place`);
  }
  assert.match(lastClip().src, /a1/);
});

test('the status line says what the mic is doing', async () => {
  await begin();
  shadow.onTurn('listening');
  assert.equal($('shadow-status').textContent, '듣는 중...');
  shadow.onTurn('transcribing');
  assert.equal($('shadow-status').textContent, '받아쓰는 중...');
  shadow.onTurn('idle');
  assert.equal($('shadow-status').textContent, '');
});

test('a plain script session after shadowing puts the card away', async () => {
  await begin();
  await session.startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  assert.equal($('shadow-card').hidden, true);
  assert.equal(state.shadowing, false);
  assert.equal($('btn-next').hidden, false);
  assert.equal($('text-input').hidden, false);
});

test('the recording goes to the row the save returned', async () => {
  const seen = await begin();
  state.chunks = ['x'];
  await say('morning');
  assert.deepEqual(seen.audio, ['7']);
  assert.deepEqual(state.chunks, []);
  assert.equal($('shadow-play-mine').disabled, false);
  const before = clips.length;
  shadow.mine();
  assert.equal(clips.length, before + 1);
  assert.equal(lastClip().src, '/api/messages/7/audio');
});

/* ---------- the native clip is never left playing ---------- */

test('다시 듣기 twice plays one clip, not two on top of each other', async () => {
  await begin();
  shadow.replay();
  const first = lastClip();
  shadow.replaySlow();
  assert.equal(first.paused, true, 'the earlier clip is stopped');
  assert.equal(lastClip().paused, false);
});

test('다음 줄 stops the line still playing before the next one starts', async () => {
  await begin();
  await say('morning');
  shadow.replay();
  const playing = lastClip();
  await shadow.nextLine();
  assert.equal(playing.paused, true);
  assert.match(lastClip().src, /a1/);
});

test('ending the session stops the clip: it does not play on into the report', async () => {
  await begin();
  await say('morning');
  await shadow.nextLine();
  await say('yes i am ready');
  shadow.replay();
  const playing = lastClip();
  await shadow.nextLine();   // 끝! 리포트 보기
  assert.equal(playing.paused, true);
});

test('pressing the mic stops the native clip, so the mic hears only the learner', async () => {
  await begin();
  const playing = lastClip();
  assert.equal(playing.paused, false);
  micClick();
  assert.equal(playing.paused, true);
  assert.equal($('btn-mic').disabled, false, 'the mic is live: pressing again stops the listen');
});

test('다시 듣기 does nothing while the mic is open', async () => {
  await begin();
  micClick();
  const before = clips.length;
  shadow.replay();
  shadow.replaySlow();
  assert.equal(clips.length, before, 'no clip plays into the recording');
});

/* ---------- Japanese reading aids ---------- */

const JA = [
  { speaker: 'bot', text: 'おはよう', audio_key: 'j0' },
  { speaker: 'user', text: 'はい', audio_key: 'j1' },
];
const RUBY = [[{ surface: 'おはよう', romaji: 'ohayou', hangul: '오하요', parts: [{ text: 'おはよう' }] }]];

const beginJa = (opts) => begin({ language: 'ja', lines: JA, ...opts });

test('Japanese: reading aids are asked for at the line change, while the text is still hidden', async () => {
  const seen = await beginJa({ reading: () => jsonResponse({ readings: RUBY }) });
  await settle();
  assert.deepEqual(seen.reading, [['おはよう']]);
  assert.equal($('shadow-text').classList.contains('is-invisible'), true);
  assert.match(cardText().innerHTML, /class="ja"/, 'the aids are drawn before the reveal');
  assert.equal($('shadow-text').dataset.lang, 'ja');
});

test('Japanese: aids answering late for a line already left do not land on the next line', async () => {
  const slow = later();
  let calls = 0;
  await beginJa({
    reading: () => (calls++ === 0 ? slow.respond() : jsonResponse({ readings: [] })),
  });
  const lineOneSpan = cardText();
  await say('おはよう');
  await shadow.nextLine();
  slow.release(jsonResponse({ readings: RUBY }));
  await settle();
  assert.equal($('shadow-text').children.length, 1);
  assert.equal(cardText().textContent, 'はい');
  assert.equal(cardText().innerHTML, '', 'line 2 is not overwritten with line 1');
  assert.notEqual(cardText(), lineOneSpan);
});

/* ---------- saves that answer late ---------- */

test('a save failing after the session ended says nothing and gives the mic back', async () => {
  const slow = later();
  await begin({ line: slow.respond });
  await say('morning');
  assert.equal(shadow.shadowState().saving, true);
  await session.endSession();
  assert.equal(state.shadowing, false);
  slow.release(jsonResponse({ detail: 'gone' }, { ok: false, status: 404 }));
  await settle();
  assert.notEqual($('notice-text').textContent, '저장하지 못했어요');
  assert.equal(shadow.shadowState().saving, false);
  assert.equal($('btn-mic').disabled, false);
});

test('a save failing after another session began says nothing', async () => {
  const slow = later();
  await begin({ line: slow.respond });
  await say('morning');
  state.sessionId = 99;   // another session is the app's now
  slow.release(jsonResponse({ detail: 'gone' }, { ok: false, status: 404 }));
  await settle();
  assert.notEqual($('notice-text').textContent, '저장하지 못했어요');
});

test('an ended shadowing session leaves state.shadowing off', async () => {
  await begin();
  await say('morning');
  await shadow.nextLine();
  await say('yes');
  await shadow.nextLine();
  assert.equal(state.shadowing, false);
});

test('a second attempt made during the first one\'s upload keeps the card: only the latest attempt finishes it', async () => {
  const upload = later();
  let uploads = 0;
  const slowSave = later();
  let saves = 0;
  await begin({
    audio: () => (uploads++ === 0 ? upload.respond() : jsonResponse({})),
    line: () => (saves++ === 0
      ? jsonResponse({ message_id: 7, matched: false })
      : slowSave.respond()),
  });
  state.chunks = ['x'];
  await say('morning');                 // saved; its upload hangs
  assert.equal($('btn-mic').disabled, false, 'the mic is back during the upload');
  await say('morning ready for standup');   // the second attempt's save hangs
  upload.release(jsonResponse({}));     // the first attempt's upload finishes
  await settle();
  assert.equal(shadow.shadowState().saving, true, 'the second attempt is still saving');
  assert.equal(shadow.shadowState().stage, 'listen', 'the first attempt\'s verdict is not shown');
  slowSave.release(jsonResponse({ message_id: 8, matched: true }));
  await settle();
  assert.equal(shadow.shadowState().saving, false);
  assert.equal($('shadow-verdict').textContent, '✓ 대본과 같아요');
});
