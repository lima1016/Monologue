/* 1분 말하기's screen (#timed): ten seconds of prep, one continuous minute of
 * recording, the upload and its retry, sentence-by-sentence grading, the
 * native answer, the result and a second round compared with the first.
 *
 * Driven over dom-shim.js with a stubbed fetch and a fake clock (timed.clock),
 * so a minute passes in one call. dom-shim installs no speech or recording
 * APIs on purpose; this file installs its own fakes -- a recogniser, a
 * recorder and getUserMedia -- before timed.js (and audio.js under it) is
 * evaluated, which is why the app modules are imported dynamically below.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

/* ---------- fakes ---------- */

const recognitions = [];
class FakeRecognition {
  constructor() { this.calls = []; recognitions.push(this); }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
}
window.webkitSpeechRecognition = FakeRecognition;

const recorders = [];
class FakeRecorder {
  constructor(stream) {
    this.stream = stream; this.state = 'inactive'; this.listeners = {}; this.calls = [];
    recorders.push(this);
  }
  start() { this.state = 'recording'; this.calls.push('start'); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  // Like the real one: a last dataavailable, then the stop event.
  stop() {
    this.calls.push('stop');
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: 'chunk' });
    for (const fn of this.listeners.stop || []) fn();
  }
}
const RealRecorder = FakeRecorder;
globalThis.MediaRecorder = FakeRecorder;

let micMode = 'ok';           // 'ok' | 'denied'
const streams = [];
function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const s = { tracks, getTracks: () => tracks };
  streams.push(s);
  return s;
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => (micMode === 'denied'
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve(fakeStream())),
    },
  },
});

const clips = [];
globalThis.Audio = class Audio {
  constructor(src) { this.src = src; this.paused = false; clips.push(this); }
  addEventListener() {}
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
};

const spoken = [];
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } addEventListener() {} };
window.speechSynthesis = { speak(u) { spoken.push(u.text); }, cancel() {} };
globalThis.speechSynthesis = window.speechSynthesis;

/* main.js, for the ways off the screen. Its startup reads a few routes. The
 * handlers are taken now: resetDom() hands every test fresh elements with no
 * listeners, and the handlers look their elements up afresh on each call. */
stubFetch(async (url) => {
  if (url.startsWith('/api/health')) return jsonResponse({ ollama: true, voicevox: true });
  if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
  return jsonResponse({});
});
const timed = await import('./timed.js');
await import('./main.js');
const timedHomeClick = $('btn-timed-home').listeners.click[0];
const mypageClick = $('btn-mypage').listeners.click[0];
await new Promise((resolve) => setTimeout(resolve, 20));

/* ---------- a clock that moves when told ---------- */

let now = 0;
const tickers = new Map();
let nextId = 1;
Object.assign(timed.clock, {
  now: () => now,
  every: (fn) => { const id = nextId++; tickers.set(id, fn); return id; },
  cancel: (id) => { tickers.delete(id); },
});
function advance(ms) {
  now += ms;
  for (const fn of [...tickers.values()]) fn();
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/* ---------- the server ---------- */

const ROUND1 = {
  round: 1, seconds: 60, words: 87, wpm: 87, long_pauses: 5,
  sentences: [{ text: 'I like cats.' }, { text: 'They is cute.' }, { text: 'Um.' }],
};
const GRADES = [
  { i: 0, text: 'I like cats.', ok: true, fixed: null, correction: null, suggestion: null, tag: null },
  { i: 1, text: 'They is cute.', ok: false, fixed: 'They are cute.', correction: '복수 주어에는 are를 써요', suggestion: null, tag: 'agreement' },
  { i: 2, text: 'Um.', ok: null, fixed: null, correction: null, suggestion: null, tag: null, filler: true },
];

/* One session's routes. Each option replaces one route's answer; every
 * request is kept, in order, for the test to read. */
function routes({ upload, transcribe, grade, native, end } = {}) {
  const seen = { calls: [], uploads: [] };
  stubFetch(async (url, options = {}) => {
    seen.calls.push(url);
    if (url === '/api/sessions/5/timed/rounds') {
      seen.uploads.push(options.body);
      return upload ? upload(seen.uploads.length) : jsonResponse(ROUND1);
    }
    let m = url.match(/^\/api\/sessions\/5\/timed\/rounds\/(\d+)\/grade\/(\d+)$/);
    if (m) {
      const i = Number(m[2]);
      return grade ? grade(i, Number(m[1])) : jsonResponse(GRADES[i]);
    }
    m = url.match(/^\/api\/sessions\/5\/timed\/rounds\/(\d+)\/transcribe$/);
    if (m) return transcribe ? transcribe(Number(m[1])) : jsonResponse(ROUND1);
    m = url.match(/^\/api\/sessions\/5\/timed\/rounds\/(\d+)\/native$/);
    if (m) {
      return native ? native(Number(m[1]))
        : jsonResponse({ native: 'On weekends I usually relax.', level: 'intermediate', audio_key: 'k1' });
    }
    if (url === '/api/sessions/5/end') {
      return end ? end() : jsonResponse({ kind: 'timed', topic: 'x', rounds: [], stats: { turns: 3 } });
    }
    if (url === '/api/reading') return jsonResponse({ readings: [] });
    return jsonResponse({});
  });
  return seen;
}

async function open(opts = {}) {
  resetDom();
  router.register('timed', 'timed');
  router.register('report', 'report');
  state.language = opts.language || 'en';
  micMode = opts.mic || 'ok';
  const seen = routes(opts);
  timed.openTimed({ sessionId: 5, topic: 'What do you do on weekends?',
                    meaning: '주말에 뭐 해요?', starter: 'On weekends, I...' });
  await flush();
  return seen;
}

/* The minute, from prep through the upload, pressed 다 말했어요 at `ms`. */
async function speak(ms = 60000) {
  timed.startNow();
  if (ms >= 60000) advance(60000);
  else { advance(ms); timed.stopNow(); }
  await flush();
}

/* The text an element shows: the shim does not compute textContent from
   children, so this walks them. */
function text(node) {
  if (!node) return '';
  if (node.childNodes && node.childNodes.length) return node.childNodes.map(text).join('');
  return node.textContent || '';
}
const lastRecognition = () => recognitions[recognitions.length - 1];
const lastRecorder = () => recorders[recorders.length - 1];
const lastStream = () => streams[streams.length - 1];
const rows = () => Array.from($('timed-lines').children);
const verdict = (i) => rows()[i].children[1];
const stage = () => timed.timedState().stage;

beforeEach(() => { now = 0; });
afterEach(() => {
  timed.leaveTimed();
  globalThis.MediaRecorder = RealRecorder;
});

/* ---------- nextStage ---------- */

test('nextStage follows the table, LEAVE goes idle from anywhere, and nothing else moves', () => {
  const allowed = {
    prep: { START: 'rec', PREP_DONE: 'rec' },
    rec: { STOP: 'upload', TIME_UP: 'upload' },
    upload: { UPLOADED: 'grading', TRANSCRIBE_FAILED: 'retry-transcribe' },
    'retry-transcribe': { RETRY: 'upload' },
    grading: { GRADED: 'result' },
    result: { AGAIN: 'prep' },
  };
  const stages = ['idle', ...Object.keys(allowed)];
  const events = ['START', 'PREP_DONE', 'STOP', 'TIME_UP', 'UPLOADED', 'TRANSCRIBE_FAILED',
                  'RETRY', 'GRADED', 'AGAIN'];
  for (const s of stages) {
    assert.equal(timed.nextStage(s, 'LEAVE'), 'idle', `${s} + LEAVE`);
    for (const e of events) {
      const want = (allowed[s] && allowed[s][e]) || s;
      assert.equal(timed.nextStage(s, e), want, `${s} + ${e}`);
    }
  }
});

/* ---------- prep ---------- */

test('prep shows the question and counts 10 down to 0, then starts recording by itself', async () => {
  await open();
  assert.equal($('timed-topic').textContent, 'What do you do on weekends?');
  assert.equal($('timed-meaning').textContent, '주말에 뭐 해요?');
  assert.match($('timed-starter').textContent, /On weekends, I\.\.\./);
  assert.equal(stage(), 'prep');
  assert.equal($('timed-prep').hidden, false);
  assert.equal($('timed-rec').hidden, true);
  assert.equal($('timed-prep-count').textContent, '10');
  const before = recorders.length;
  advance(9000);
  assert.equal($('timed-prep-count').textContent, '1');
  assert.equal(stage(), 'prep');
  assert.equal(recorders.length, before, 'nothing records before 0');
  advance(1000);
  assert.equal(stage(), 'rec');
  assert.equal($('timed-rec').hidden, false);
  assert.equal($('timed-prep').hidden, true);
  assert.deepEqual(lastRecorder().calls, ['start']);
  assert.equal(lastRecognition().continuous, true);
  assert.equal(lastRecognition().interimResults, true);
  assert.deepEqual(lastRecognition().calls, ['start']);
});

test('바로 시작 starts the minute at once, and the clock counts down from 1:00', async () => {
  await open();
  timed.startNow();
  assert.equal(stage(), 'rec');
  assert.equal($('timed-clock').textContent, '1:00');
  advance(18000);
  assert.equal($('timed-clock').textContent, '0:42');
});

/* ---------- the minute ---------- */

test('at 60 seconds the recording stops by itself and uploads the file with seconds 60', async () => {
  const seen = await open();
  timed.startNow();
  const rec = lastRecorder();
  const recog = lastRecognition();
  advance(59000);
  assert.equal(stage(), 'rec');
  assert.equal(seen.uploads.length, 0);
  advance(1000);
  await flush();
  assert.equal(seen.uploads.length, 1);
  const form = seen.uploads[0];
  assert.equal(form.get('seconds'), '60');
  assert.ok(form.get('file'), 'the recording is in the form');
  assert.ok(form.get('file').size > 0);
  assert.ok(rec.calls.includes('stop'));
  assert.ok(recog.calls.includes('stop'));
  assert.ok(lastStream().tracks.every((t) => t.stopped), 'the microphone is released');
});

test('다 말했어요 stops at once and sends the time actually spoken', async () => {
  const seen = await open();
  timed.startNow();
  advance(20000);
  await timed.stopNow();
  await flush();
  assert.equal(seen.uploads.length, 1);
  assert.equal(seen.uploads[0].get('seconds'), '20');
});

test('live words show while recording, and recognition restarts when Chrome ends it', async () => {
  await open();
  timed.startNow();
  const r = lastRecognition();
  r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'I like' }], { isFinal: true })] });
  r.onresult({ resultIndex: 1, results: [
    Object.assign([{ transcript: 'I like' }], { isFinal: true }),
    Object.assign([{ transcript: 'cats' }], { isFinal: false }),
  ] });
  assert.equal($('timed-live').textContent, 'I like cats');
  r.onend();
  assert.deepEqual(r.calls, ['start', 'start'], 'a silence-ended recognition starts again');
  await timed.stopNow();
  r.onend();
  assert.equal(r.calls.filter((c) => c === 'start').length, 2, 'not after the minute ended');
});

test('a recognition network error stops the restarts, like a refused one', async () => {
  await open();
  timed.startNow();
  const r = lastRecognition();
  r.onerror({ error: 'network' });
  r.onend();
  assert.deepEqual(r.calls, ['start'], 'a network failure would only fail again, forever');
  assert.equal(stage(), 'rec', 'the minute itself goes on -- it is being recorded');
});

test('a clip still playing is stopped before the minute starts, and recognition hears the session language', async () => {
  await open();
  const audio = await import('./audio.js');
  audio.play('clip', 'hello');
  const clip = clips[clips.length - 1];
  assert.equal(clip.paused, false);
  timed.startNow();
  assert.equal(clip.paused, true, 'the microphone must not record a clip');
  assert.equal(lastRecognition().lang, 'en-US');
});

/* ---------- upload ---------- */

test('a 503 upload goes to 받아쓰기 다시 시도, which asks /transcribe for that round', async () => {
  const seen = await open({
    upload: () => jsonResponse({ detail: { message: '받아쓰기를 할 수 없어요', round: 1 } },
      { ok: false, status: 503 }),
  });
  await speak();
  assert.equal(stage(), 'retry-transcribe');
  assert.equal($('timed-retry').hidden, false);
  assert.equal($('timed-retry-text').textContent, '받아쓰기를 하지 못했어요');
  await timed.retryTranscribe();
  await flush();
  assert.ok(seen.calls.includes('/api/sessions/5/timed/rounds/1/transcribe'));
  assert.equal(seen.uploads.length, 1, 'the recording is not sent twice');
  assert.notEqual(stage(), 'retry-transcribe');
  assert.ok(['grading', 'result'].includes(stage()));
});

test('an upload that answers OK with a body that is not JSON goes to 받아쓰기 다시 시도', async () => {
  await open({
    upload: () => ({ ok: true, status: 200, statusText: '200',
                     json: async () => { throw new SyntaxError('Unexpected token <'); } }),
  });
  timed.startNow();
  advance(5000);
  // Swallowed here so a throw cannot stand in for the assertion below.
  try { await timed.stopNow(); } catch { /* the bug under test */ }
  await flush();
  assert.equal(stage(), 'retry-transcribe', 'the card must not sit on 받아쓰는 중이에요 forever');
  assert.equal($('timed-retry-text').textContent, '받아쓰기를 하지 못했어요');
  assert.equal($('timed-retry-btn').disabled, false);
});

test('while uploading the card says 받아쓰는 중이에요', async () => {
  const d = deferred();
  await open({ upload: () => d.promise });
  timed.startNow();
  advance(60000);
  await flush();
  assert.equal(stage(), 'upload');
  assert.equal($('timed-upload').hidden, false);
  assert.equal($('timed-upload-text').textContent, '받아쓰는 중이에요');
  d.resolve(jsonResponse(ROUND1));
  await flush();
});

/* ---------- grading ---------- */

test('sentences are graded one at a time, in order, with the progress line counting up', async () => {
  const pending = [];
  const seen = await open({
    grade: (i) => { const d = deferred(); pending.push({ i, d }); return d.promise; },
  });
  await speak();
  assert.equal(stage(), 'grading');
  assert.deepEqual(rows().map((r) => r.children[0].textContent),
    ['I like cats.', 'They is cute.', 'Um.'], 'my words are drawn first');
  const grades = () => seen.calls.filter((u) => u.includes('/grade/'));
  assert.deepEqual(grades(), ['/api/sessions/5/timed/rounds/1/grade/0']);
  assert.equal($('timed-progress').textContent, '교정하는 중이에요 · 1/3문장');
  pending[0].d.resolve(jsonResponse(GRADES[0]));
  await flush();
  assert.deepEqual(grades().map((u) => u.slice(-1)), ['0', '1'], 'the next only after the last answered');
  assert.equal($('timed-progress').textContent, '교정하는 중이에요 · 2/3문장');
  assert.equal(text(verdict(0)), '✓ 좋아요');
  pending[1].d.resolve(jsonResponse(GRADES[1]));
  await flush();
  assert.equal($('timed-progress').textContent, '교정하는 중이에요 · 3/3문장');
  assert.match(text(verdict(1)), /고친 문장 They are cute\./);
  assert.match(text(verdict(1)), /복수 주어에는 are를 써요/);
  assert.ok(!seen.calls.some((u) => u.endsWith('/native')), 'native waits for the last sentence');
  pending[2].d.resolve(jsonResponse(GRADES[2]));
  await flush();
  assert.equal(text(verdict(2)), '', 'a filler line is done, with no verdict');
  assert.ok(seen.calls.includes('/api/sessions/5/timed/rounds/1/native'));
  assert.equal(stage(), 'result');
});

test('a sentence that fails stops the walk there, with its own 다시 시도, then carries on', async () => {
  let failOnce = true;
  const seen = await open({
    grade: (i) => {
      if (i === 1 && failOnce) {
        failOnce = false;
        return jsonResponse({ i: 1, text: 'They is cute.', ok: null, fixed: null,
                              correction: null, suggestion: null, tag: null });
      }
      return jsonResponse(GRADES[i]);
    },
  });
  await speak();
  assert.equal(stage(), 'grading');
  const box = verdict(1);
  assert.match(text(box), /교정하지 못했어요/);
  assert.equal(text(verdict(0)), '✓ 좋아요', 'the line before keeps its verdict');
  assert.ok(!seen.calls.some((u) => u.endsWith('/grade/2')), 'the next sentence waits');
  assert.ok(!seen.calls.some((u) => u.endsWith('/native')));
  const retry = Array.from(box.children).find((c) => c.tagName === 'BUTTON');
  assert.equal(retry.textContent, '다시 시도');
  retry.listeners.click[0]();
  await flush();
  const grades = seen.calls.filter((u) => u.includes('/grade/')).map((u) => u.slice(-1));
  assert.deepEqual(grades, ['0', '1', '1', '2']);
  assert.match(text(verdict(1)), /They are cute\./);
  assert.ok(seen.calls.includes('/api/sessions/5/timed/rounds/1/native'));
  assert.equal(stage(), 'result');
});

test('my words carry no .said class and no strike-through element', async () => {
  await open();
  await speak();
  const walk = (node, out = []) => {
    if (node && node.tagName) {
      out.push(node);
      for (const c of node.childNodes || []) walk(c, out);
    }
    return out;
  };
  const all = walk($('timed-lines'));
  assert.ok(all.length > 3);
  assert.ok(all.every((el) => !el.classList.contains('said') && !el.classList.contains('fix-row')));
  assert.ok(all.every((el) => el.tagName !== 'S' && el.tagName !== 'DEL'));
  assert.equal(rows()[1].children[0].className, 'timed-mine');
});

/* ---------- the native answer ---------- */

test('원어민이라면 plays the server clip, or the browser voice when there is none', async () => {
  await open({ native: () => jsonResponse({ native: 'I relax.', level: null, audio_key: null }) });
  await speak();
  assert.equal(text($('timed-native-text')), 'I relax.');
  assert.equal($('timed-native-play').classList.contains('is-invisible'), false);
  timed.playNative();
  assert.equal(spoken[spoken.length - 1], 'I relax.');

  await open();
  await speak();
  timed.playNative();
  assert.equal(clips[clips.length - 1].src, '/api/audio/k1.wav');
});

test('a native answer that fails still reaches the result, with its own 다시 시도', async () => {
  let fail = true;
  await open({
    native: () => (fail
      ? jsonResponse({ detail: '지금은 원어민 답을 만들 수 없어요' }, { ok: false, status: 503 })
      : jsonResponse({ native: 'Now it works.', level: null, audio_key: 'k2' })),
  });
  await speak();
  assert.equal(stage(), 'result');
  assert.equal($('timed-native-status').textContent, '원어민 답을 만들지 못했어요');
  assert.equal($('timed-native-retry').classList.contains('is-invisible'), false);
  fail = false;
  await timed.retryNative();
  assert.equal(text($('timed-native-text')), 'Now it works.');
  assert.equal($('timed-native-status').classList.contains('is-invisible'), true);
});

/* The status line keeps its row whether it says something or not (R5): it is
   hidden, never emptied to nothing, so the card does not jump. */
test('the native status line is shown while waiting and hidden -- not collapsed -- once the answer is in', async () => {
  const held = deferred();
  await open({ native: () => held.promise });
  await speak();
  const status = $('timed-native-status');
  assert.equal(status.textContent, '원어민 답을 만드는 중이에요');
  assert.equal(status.classList.contains('is-invisible'), false);
  held.resolve(jsonResponse({ native: 'I relax.', level: null, audio_key: 'k1' }));
  await flush();
  assert.equal(stage(), 'result');
  assert.equal(status.classList.contains('is-invisible'), true, 'hidden with setShown, holding its line');
  assert.match(ruleBody('.timed-native-status'), /min-height: 1\.55em/);
});

test('▶ 듣기 pauses ▶ 내 녹음 first, so the two never talk over each other', async () => {
  await open();
  await speak();
  timed.playMine();
  const mine = clips[clips.length - 1];
  assert.match(mine.src, /^blob:/);
  assert.equal(mine.paused, false);
  timed.playNative();
  assert.equal(mine.paused, true, 'my recording is paused before the native clip plays');
  assert.equal(clips[clips.length - 1].src, '/api/audio/k1.wav');
});

test('Japanese: a fixed line and the native answer are annotated on spans of their own', async () => {
  const readings = [];
  await open({ language: 'ja' });
  stubFetch(async (url, options = {}) => {
    if (url === '/api/reading') { readings.push(JSON.parse(options.body).texts); return jsonResponse({ readings: [] }); }
    if (url === '/api/sessions/5/timed/rounds') return jsonResponse(ROUND1);
    const m = url.match(/\/grade\/(\d+)$/);
    if (m) return jsonResponse({ ...GRADES[m[1]], fixed: GRADES[m[1]].fixed && '猫はかわいいです。' });
    if (url.endsWith('/native')) return jsonResponse({ native: '週末は休みます。', level: null, audio_key: null });
    return jsonResponse({});
  });
  await speak();
  assert.deepEqual(readings, [['猫はかわいいです。'], ['週末は休みます。']]);
  const fixedP = verdict(1).children[0];
  const span = fixedP.children[1];
  assert.equal(span.textContent, '猫はかわいいです。');
  assert.equal(fixedP.children[0].textContent, '고친 문장', 'the label is not the annotated span');
  assert.match(text($('timed-numbers')), /^글자 87/);
});

/* ---------- the result, and once more ---------- */

test('round 1 shows its counts; round 2 shows each against round 1, marked where it got better', async () => {
  const seen = await open({
    upload: (n) => jsonResponse(n === 1 ? ROUND1
      : { round: 2, seconds: 60, words: 112, wpm: 80, long_pauses: 3,
          sentences: [{ text: 'I like cats.' }, { text: 'They are cute.' }] }),
    grade: (i, n) => jsonResponse(n === 1 ? GRADES[i] : { ...GRADES[0], i }),
  });
  await speak();
  assert.equal(stage(), 'result');
  assert.equal(text($('timed-numbers')), '단어 87 · 분당 87 · 긴 멈춤 5 · 고친 곳 1');
  assert.equal($('timed-progress').hidden, true);
  assert.equal($('timed-actions').classList.contains('is-invisible'), false);
  assert.equal($('timed-mine').disabled, false);
  timed.playMine();
  assert.match(clips[clips.length - 1].src, /^blob:/);

  timed.again();
  assert.equal(stage(), 'prep');
  assert.equal($('timed-prep').hidden, false);
  assert.equal($('timed-prep-count').textContent, '10');
  await flush();
  await speak();
  assert.ok(seen.calls.includes('/api/sessions/5/timed/rounds/2/grade/1'));
  assert.equal(stage(), 'result');
  assert.equal(text($('timed-numbers')),
    '단어 87 → 112 · 분당 87 → 80 · 긴 멈춤 5 → 3 · 고친 곳 1 → 0');
  const metrics = Array.from($('timed-numbers').children);
  assert.deepEqual(metrics.map((m) => m.classList.contains('timed-better')),
    [true, false, true, true], 'more words, fewer pauses and fixes are better; fewer per minute is not');
});

test('끝내기 ends the session and shows the report', async () => {
  const seen = await open();
  await speak();
  await timed.endTimed();
  assert.ok(seen.calls.includes('/api/sessions/5/end'));
  assert.equal(router.current(), 'report');
  assert.equal($('report').hidden, false);
  assert.equal(stage(), 'idle');
});

/* ---------- leaving ---------- */

test('leaving mid-minute drops it: no upload, recognition and recorder stopped, mic released', async () => {
  const seen = await open();
  timed.startNow();
  advance(20000);
  const rec = lastRecorder();
  const recog = lastRecognition();
  timed.leaveTimed();
  assert.equal(stage(), 'idle');
  assert.ok(recog.calls.includes('abort'));
  assert.ok(rec.calls.includes('stop'));
  assert.ok(lastStream().tracks.every((t) => t.stopped));
  advance(60000);
  await flush();
  assert.equal(seen.uploads.length, 0, 'the dropped minute is never uploaded');
  assert.equal(tickers.size, 0, 'no clock left running');
});

test('a grade answering after the learner left draws nothing', async () => {
  const pending = [];
  const seen = await open({
    grade: (i) => { const d = deferred(); pending.push(d); return d.promise; },
  });
  await speak();
  const row = verdict(0);
  timed.leaveTimed();
  pending[0].resolve(jsonResponse(GRADES[0]));
  await flush();
  assert.equal(text(row), '');
  assert.equal(seen.calls.filter((u) => u.includes('/grade/')).length, 1, 'and asks for nothing more');
});

test('← 홈 and 마이페이지 both leave the screen, dropping a minute in progress', async () => {
  let seen = await open();
  timed.startNow();
  timedHomeClick();
  assert.equal(stage(), 'idle');
  assert.equal(router.current(), 'home');
  assert.ok(lastRecognition().calls.includes('abort'));
  await flush();
  assert.equal(seen.uploads.length, 0);

  seen = await open();
  timed.startNow();
  mypageClick();
  assert.equal(stage(), 'idle');
  assert.ok(lastRecognition().calls.includes('abort'));
  await flush();
  assert.equal(seen.uploads.length, 0);
});

/* ---------- no microphone ---------- */

test('a refused microphone says so in prep and turns 바로 시작 off; the countdown does not start it', async () => {
  const before = recorders.length;
  await open({ mic: 'denied' });
  assert.equal($('timed-mic-note').textContent,
    '마이크를 쓸 수 없어요 — 브라우저 설정에서 마이크를 허용해 주세요');
  assert.equal($('timed-mic-note').classList.contains('is-invisible'), false);
  assert.equal($('timed-start').disabled, true);
  timed.startNow();
  advance(10000);
  assert.equal(stage(), 'prep');
  assert.equal(recorders.length, before);
});

test('no MediaRecorder at all reads the same as a refused microphone', async () => {
  delete globalThis.MediaRecorder;
  await open();
  assert.equal($('timed-mic-note').textContent,
    '마이크를 쓸 수 없어요 — 브라우저 설정에서 마이크를 허용해 주세요');
  assert.equal($('timed-start').disabled, true);
});

test('a MediaRecorder that throws on construction releases the mic, says so, and stays in prep', async () => {
  globalThis.MediaRecorder = class { constructor() { throw new Error('NotSupportedError'); } };
  const seen = await open();
  timed.startNow();
  assert.equal(stage(), 'prep', 'no dead minute ticking with nothing recording');
  assert.equal($('timed-mic-note').textContent,
    '마이크를 쓸 수 없어요 — 브라우저 설정에서 마이크를 허용해 주세요');
  assert.equal($('timed-mic-note').classList.contains('is-invisible'), false);
  assert.equal($('timed-start').disabled, true);
  assert.ok(lastStream().tracks.every((t) => t.stopped), 'the microphone is released');
  assert.equal(tickers.size, 0, 'no clock left running');
  advance(60000);
  await flush();
  assert.equal(seen.uploads.length, 0);
});

/* ---------- CSS ---------- */

const css = readFileSync(new URL('../css/components.css', import.meta.url), 'utf8');
function ruleBody(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf('}', start));
}

test('every stage slot stands on the same floor, and the card never moves by transform', () => {
  assert.match(ruleBody('.timed-slot'), /min-height:/);
  assert.match(ruleBody('.timed-live'), /height: calc\(2 \* 1\.6em\)/);
  assert.match(ruleBody('.timed-live'), /overflow: hidden/);
  for (const sel of ['.timed-card', '.timed-slot', '.timed-slot.timed-enter', '.timed-review']) {
    assert.doesNotMatch(ruleBody(sel), /transform/, sel);
  }
});

test('the stage fade is opacity only, and reduced motion switches it off', () => {
  const start = css.indexOf('@keyframes timed-fade');
  const frames = css.slice(start, css.indexOf('}\n}', start));
  assert.match(frames, /opacity/);
  assert.doesNotMatch(frames, /transform/);
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]).join('\n');
  assert.match(reduced, /\.timed-slot\.timed-enter[^{]*\{[^}]*animation: none/);
  assert.match(reduced, /\.timed-dot[^{]*\{[^}]*animation: none/);
});
