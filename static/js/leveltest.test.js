/* 레벨 테스트's screen (#leveltest): the intro, twelve sentences heard once
 * and said back (auto-recorded, uploaded behind the next one), two answers
 * with a prep count and a 45-second clock, finishing (every upload in, then
 * /finish) and the hand-off to the result.
 *
 * Driven over dom-shim.js with a stubbed fetch and a fake clock
 * (leveltest.clock). dom-shim installs no recording or speech APIs; this file
 * installs its own -- a recorder, getUserMedia, an Audio whose events a test
 * fires, a speechSynthesis that records what it was asked to say -- before
 * leveltest.js (and audio.js under it) is evaluated, hence the dynamic
 * imports below.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

/* ---------- fakes ---------- */

let recorderMode = 'ok';   // 'ok' | 'throw-start' | 'no-data'
const recorders = [];
class FakeRecorder {
  constructor(stream) {
    this.stream = stream; this.state = 'inactive'; this.listeners = {}; this.calls = [];
    recorders.push(this);
  }
  start() {
    if (recorderMode === 'throw-start') throw new Error('NotSupportedError');
    this.state = 'recording'; this.calls.push('start');
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  stop() {
    this.calls.push('stop');
    this.state = 'inactive';
    if (recorderMode !== 'no-data' && this.ondataavailable) this.ondataavailable({ data: 'chunk' });
    for (const fn of this.listeners.stop || []) fn();
  }
}
globalThis.MediaRecorder = FakeRecorder;

let micMode = 'ok';        // 'ok' | 'denied'
const streams = [];
function fakeStream() {
  const tracks = [{ stopped: false, readyState: 'live', stop() { this.stopped = true; } }];
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

let clipFails = 0;          // the next N clips reject play()
const clips = [];
globalThis.Audio = class Audio {
  constructor(src) { this.src = src; this.paused = false; this.listeners = {}; clips.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  play() {
    if (clipFails > 0) { clipFails -= 1; return Promise.reject(new Error('NotAllowedError')); }
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  fire(type) { for (const fn of this.listeners[type] || []) fn(); }
};

// Whatever the browser's voice is asked to say. An empty utterance ends at once.
const spoken = [];
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
};
window.speechSynthesis = {
  speak(u) { spoken.push(u.text); for (const fn of u.listeners.end || []) fn(); },
  cancel() {},
};
globalThis.speechSynthesis = window.speechSynthesis;

stubFetch(async (url) => {
  if (url.startsWith('/api/health')) return jsonResponse({ ollama: true, voicevox: true });
  if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
  return jsonResponse({});
});
const lt = await import('./leveltest.js');
await import('./main.js');
const homeClick = $('btn-leveltest-home').listeners.click[0];
const mypageClick = $('btn-mypage').listeners.click[0];
const startClick = $('lt-start').listeners.click[0];
await new Promise((resolve) => setTimeout(resolve, 20));

/* ---------- a clock that moves when told ---------- */

let now = 0;
const tickers = new Map();
let nextId = 1;
Object.assign(lt.clock, {
  now: () => now,
  every: (fn) => { const id = nextId++; tickers.set(id, fn); return id; },
  cancel: (id) => { tickers.delete(id); },
});
function advance(ms) {
  now += ms;
  for (const fn of [...tickers.values()]) fn();
}

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/* ---------- the server ---------- */

const SENTENCES = Array.from({ length: 12 }, (_, i) => `Secret sentence number ${i}.`);
const CREATED = {
  test_id: 7,
  items: SENTENCES.map((_, i) => ({ i, audio_key: `k${i}` })),
  questions: [
    { q: 0, text: 'Tell me about your weekends.', meaning: '주말 이야기를 해 주세요.' },
    { q: 1, text: 'What would you change about your city?', meaning: '도시에서 무엇을 바꾸고 싶어요?' },
  ],
};
const RESULT = { test_id: 7, cefr: 'B1', step: '상위' };

/* The test's routes. Each option replaces one route's answer; every request
 * is kept, in order. */
function routes({ create, item, answer, finish } = {}) {
  const seen = { calls: [], items: [], answers: [], finishes: 0 };
  stubFetch(async (url, options = {}) => {
    seen.calls.push(url);
    if (url === '/api/level-test') {
      seen.created = JSON.parse(options.body);
      return create ? create() : jsonResponse(CREATED);
    }
    let m = url.match(/^\/api\/level-test\/7\/items\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      seen.items.push({ n, body: options.body });
      return item ? item(n, seen.items.filter((x) => x.n === n).length) : jsonResponse({ i: n, done: true });
    }
    m = url.match(/^\/api\/level-test\/7\/answers\/(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      seen.answers.push({ n, body: options.body });
      return answer ? answer(n) : jsonResponse({ q: n, done: true });
    }
    if (url === '/api/level-test/7/finish') {
      seen.finishes += 1;
      return finish ? finish(seen.finishes) : jsonResponse(RESULT);
    }
    return jsonResponse({});
  });
  return seen;
}

const fail503 = () => jsonResponse({ detail: '받아쓰기를 하지 못했어요' }, { ok: false, status: 503 });

let rendered = [];
async function open(opts = {}) {
  resetDom();
  router.register('leveltest', 'leveltest');
  router.register('home', 'home');
  router.register('mypage', 'mypage');
  state.language = opts.language || 'en';
  micMode = opts.mic || 'ok';
  const seen = routes(opts);
  lt.openLevelTest();
  return seen;
}

async function start(opts = {}) {
  const seen = await open(opts);
  lt.startTest();
  await flush();
  return seen;
}

const lastClip = () => clips[clips.length - 1];
const lastRecorder = () => recorders[recorders.length - 1];
const lastStream = () => streams[streams.length - 1];
const st = () => lt.levelTestState();

/* The current sentence's clip plays for `ms` and ends. */
async function hear(ms = 2000) {
  advance(ms);
  lastClip().fire('ended');
  await flush();
}
/* Heard, then said back for `ms` and 다 말했어요. */
async function sayItem(ms = 1500) {
  await hear();
  advance(ms);
  lt.stopNow();
  await flush();
}
/* Prep runs out, then `ms` of speaking and 다 말했어요. */
async function answerFor(ms = 10000) {
  advance(5000);
  advance(ms);
  lt.stopNow();
  await flush();
}

const shown = () => ['lt-intro', 'lt-item', 'lt-answer', 'lt-trouble', 'lt-finish', 'lt-result']
  .filter((id) => !$(id).hidden);
const visible = (id) => !$(id).classList.contains('is-invisible');

beforeEach(() => {
  now = 0;
  recorderMode = 'ok';
  clipFails = 0;
  spoken.length = 0;
  rendered = [];
  lt.view.renderLevelResult = (r) => rendered.push(r);
});
afterEach(() => {
  lt.leaveLevelTest();
  globalThis.MediaRecorder = FakeRecorder;
});

/* ---------- the steps ---------- */

test('nextStep: intro, twelve sentences, two answers, finishing, result; LEAVE from anywhere', () => {
  let s = lt.nextStep({ step: 'idle' }, 'OPEN');
  assert.deepEqual(s, { step: 'intro' });
  s = lt.nextStep(s, 'START');
  assert.deepEqual(s, { step: 'item', i: 0 });
  for (let i = 1; i < 12; i += 1) {
    s = lt.nextStep(s, 'NEXT');
    assert.deepEqual(s, { step: 'item', i });
  }
  s = lt.nextStep(s, 'NEXT');
  assert.deepEqual(s, { step: 'answer', q: 0 });
  s = lt.nextStep(s, 'NEXT');
  assert.deepEqual(s, { step: 'answer', q: 1 });
  s = lt.nextStep(s, 'NEXT');
  assert.deepEqual(s, { step: 'finishing' });
  s = lt.nextStep(s, 'DONE');
  assert.deepEqual(s, { step: 'result' });
  for (const from of [{ step: 'intro' }, { step: 'item', i: 4 }, { step: 'answer', q: 1 },
    { step: 'finishing' }, { step: 'result' }]) {
    assert.deepEqual(lt.nextStep(from, 'LEAVE'), { step: 'idle' });
  }
});

test('nextStep: an event a step does not take leaves it where it is', () => {
  const cases = [
    [{ step: 'idle' }, 'START'], [{ step: 'intro' }, 'NEXT'], [{ step: 'item', i: 3 }, 'DONE'],
    [{ step: 'answer', q: 0 }, 'START'], [{ step: 'finishing' }, 'NEXT'], [{ step: 'result' }, 'NEXT'],
  ];
  for (const [from, event] of cases) assert.deepEqual(lt.nextStep(from, event), from, `${from.step} ${event}`);
});

test('the window to say a sentence back in: twice its length plus three, at least six, ten when unknown', () => {
  assert.equal(lt.itemWindow(1), 6);
  assert.equal(lt.itemWindow(2), 7);
  assert.equal(lt.itemWindow(4.4), 12);
  assert.equal(lt.itemWindow(4.2), 11);
  assert.equal(lt.itemWindow(null), 10);
  assert.equal(lt.itemWindow(0), 10);
  assert.equal(lt.itemWindow(NaN), 10);
});

/* ---------- intro ---------- */

test('the intro says how long and what to expect, with 시작 ready', async () => {
  await open();
  assert.equal(router.current(), 'leveltest');
  assert.deepEqual(shown(), ['lt-intro']);
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
    /약 7분 · 조용한 곳에서 · 문장은 한 번만 들려요/);
  assert.equal($('lt-start').disabled, false);
  assert.equal(visible('lt-intro-status'), false);
  assert.equal(st().step, 'intro');
});

test('no way to record in this browser: the intro says so and 시작 is off', async () => {
  delete globalThis.MediaRecorder;
  await open();
  assert.equal($('lt-start').disabled, true);
  assert.equal($('lt-intro-status').textContent, lt.TEXT.micBlocked);
  assert.equal(visible('lt-intro-status'), true);
});

test('a refused microphone: said on the intro, 시작 stays off, and no test is made', async () => {
  const seen = await start({ mic: 'denied' });
  assert.equal(st().step, 'intro');
  assert.equal($('lt-intro-status').textContent, lt.TEXT.micBlocked);
  assert.equal($('lt-start').disabled, true);
  assert.equal(seen.calls.includes('/api/level-test'), false);
});

test('while the server makes the voices, the intro says so in its reserved line', async () => {
  const gate = deferred();
  const seen = await open({ create: () => gate.promise });
  startClick();
  await flush();
  assert.equal($('lt-intro-status').textContent, '문장 음성을 준비하는 중이에요');
  assert.equal(visible('lt-intro-status'), true);
  assert.equal($('lt-start').disabled, true);
  assert.equal(st().step, 'intro');
  gate.resolve(jsonResponse(CREATED));
  await flush();
  assert.deepEqual(seen.created, { language: 'en' });
  assert.equal(st().step, 'item');
});

test('voices unavailable (503): the server\'s words, the mic let go, and 시작 again works', async () => {
  let n = 0;
  const seen = await start({
    create: () => {
      n += 1;
      return n === 1
        ? jsonResponse({ detail: '지금은 문장 음성을 준비할 수 없어요' }, { ok: false, status: 503 })
        : jsonResponse(CREATED);
    },
  });
  assert.equal(st().step, 'intro');
  assert.equal($('lt-intro-status').textContent, '지금은 문장 음성을 준비할 수 없어요');
  assert.equal($('lt-start').disabled, false);
  assert.ok(lastStream().tracks[0].stopped);
  lt.startTest();
  await flush();
  assert.equal(st().step, 'item');
  assert.equal(seen.calls.filter((u) => u === '/api/level-test').length, 2);
});

/* ---------- 따라 말하기 ---------- */

test('a sentence is heard, never shown: its clip plays with no text and no button while it does', async () => {
  await start();
  assert.deepEqual(shown(), ['lt-item']);
  assert.equal($('lt-item-count').textContent, '따라 말하기 1/12');
  assert.equal(lastClip().src, '/api/audio/k0.wav');
  assert.equal($('lt-item-status').textContent, lt.TEXT.listen);
  assert.equal(visible('lt-item-stop'), false);
  assert.equal(visible('lt-relisten'), false);
  assert.equal(visible('lt-item-rec'), false);
  assert.equal(recorders.filter((r) => r.state === 'recording').length, 0);
  const everything = JSON.stringify([...['lt-item-count', 'lt-item-status', 'lt-trouble-text']
    .map((id) => $(id).textContent)]);
  assert.doesNotMatch(everything, /Secret sentence/);
});

test('when the clip ends, recording starts by itself, with the red dot, a full bar and 다 말했어요', async () => {
  await start();
  await hear(2000);
  assert.equal(st().phase, 'rec');
  assert.deepEqual(lastRecorder().calls, ['start']);
  assert.equal($('lt-item-status').textContent, lt.TEXT.say);
  assert.equal(visible('lt-item-rec'), true);
  assert.equal(visible('lt-item-stop'), true);
  assert.equal($('lt-item-bar').style.width, '100%');
  // A 2 s clip gives 7 s: half of it gone leaves the bar half full.
  advance(3500);
  assert.equal($('lt-item-bar').style.width, '50%');
});

test('the window runs out on its own: 2 s heard -> 7 s to say it, then it stops and moves on', async () => {
  const seen = await start();
  await hear(2000);
  advance(6999);
  await flush();
  assert.equal(st().phase, 'rec');
  assert.equal(st().i, 0);
  advance(1);
  await flush();
  assert.deepEqual(lastRecorder().calls.slice(0, 2), ['start', 'stop']);
  assert.equal(st().i, 1);
  assert.deepEqual(seen.items.map((x) => x.n), [0]);
});

test('다 말했어요 moves to the next sentence at once; its upload does not hold it up', async () => {
  const gate = deferred();
  const seen = await start({ item: () => gate.promise });
  await sayItem();
  assert.equal(st().step, 'item');
  assert.equal(st().i, 1);
  assert.equal($('lt-item-count').textContent, '따라 말하기 2/12');
  assert.equal(lastClip().src, '/api/audio/k1.wav');
  assert.equal(seen.items.length, 1);
  assert.equal(seen.items[0].n, 0);
  assert.ok(seen.items[0].body.get('file') instanceof Blob);
  assert.equal(st().inflight, 1);
  gate.resolve(jsonResponse({ i: 0, done: true }));
  await flush();
  assert.equal(st().inflight, 0);
});

test('an upload that fails is retried once by itself', async () => {
  const seen = await start({ item: (n, k) => (k === 1 ? fail503() : jsonResponse({ i: n, done: true })) });
  await sayItem();
  assert.deepEqual(seen.items.map((x) => x.n), [0, 0]);
  // The same recording again (FormData hands back a fresh File each read).
  assert.equal(seen.items[1].body.get('file').size, seen.items[0].body.get('file').size);
  assert.equal(seen.items[1].body.get('file').name, 'item-0.webm');
  assert.equal(st().pending, 0);
});

test('an upload that fails twice waits in pending, and the test goes on', async () => {
  const seen = await start({ item: () => fail503() });
  await sayItem();
  assert.equal(seen.items.length, 2);
  assert.equal(st().pending, 1);
  assert.equal(st().i, 1);
});

test('a clip that will not play offers 다시 듣기 once -- never the text, never a recording yet', async () => {
  clipFails = 1;
  await start();
  assert.equal(st().phase, 'failed');
  assert.equal($('lt-item-status').textContent, lt.TEXT.playFailed);
  assert.equal(visible('lt-relisten'), true);
  assert.equal(visible('lt-item-stop'), false);
  assert.equal(recorders.filter((r) => r.state === 'recording').length, 0);
  assert.ok(spoken.every((t) => !t), `nothing said aloud from text: ${JSON.stringify(spoken)}`);
  lt.relisten();
  await flush();
  assert.equal(clips.filter((c) => c.src === '/api/audio/k0.wav').length >= 2, true);
  assert.equal(visible('lt-relisten'), false);
  await hear(2000);
  assert.equal(st().phase, 'rec');
});

test('a clip failing twice: recorded anyway, for the ten-second window', async () => {
  clipFails = 2;
  await start();
  lt.relisten();
  await flush();
  assert.equal(st().phase, 'rec');
  assert.equal(visible('lt-relisten'), false);
  advance(9999);
  assert.equal(st().phase, 'rec');
  advance(1);
  await flush();
  assert.equal(st().i, 1);
  assert.ok(spoken.every((t) => !t));
});

test('an empty recording is not uploaded: say so, and 다시 하기 opens the mic again and redoes the sentence', async () => {
  const seen = await start();
  recorderMode = 'no-data';
  await sayItem();
  assert.equal(seen.items.length, 0);
  assert.deepEqual(shown(), ['lt-trouble']);
  assert.equal($('lt-trouble-text').textContent, '녹음된 소리가 없어요 — 다시 해 주세요');
  recorderMode = 'ok';
  const streamsBefore = streams.length;
  const oldStream = lastStream();
  lt.redo();
  await flush();
  assert.ok(oldStream.tracks[0].stopped);
  assert.equal(streams.length, streamsBefore + 1);
  assert.deepEqual(shown(), ['lt-item']);
  assert.equal(st().i, 0);
  await sayItem();
  assert.deepEqual(seen.items.map((x) => x.n), [0]);
});

test('a recorder that cannot start: the mic note, no stuck clock', async () => {
  await start();
  recorderMode = 'throw-start';
  await hear();
  assert.deepEqual(shown(), ['lt-trouble']);
  assert.equal($('lt-trouble-text').textContent, lt.TEXT.micBlocked);
  assert.equal(st().phase, 'trouble');
});

/* ---------- 답하기, finishing ---------- */

async function throughItems() {
  for (let i = 0; i < 12; i += 1) await sayItem();
}

test('after twelve sentences, two answers: question and meaning, a 5 s prep count, then a 45 s clock', async () => {
  const seen = await start();
  await throughItems();
  assert.deepEqual(seen.items.map((x) => x.n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(st().step, 'answer');
  assert.deepEqual(shown(), ['lt-answer']);
  assert.equal($('lt-answer-count').textContent, '답하기 1/2');
  assert.equal($('lt-question').textContent, 'Tell me about your weekends.');
  assert.equal($('lt-question-meaning').textContent, '주말 이야기를 해 주세요.');
  assert.equal($('lt-answer-clock').textContent, '5');
  assert.equal(visible('lt-answer-stop'), false);
  const before = recorders.length;
  advance(1000);
  assert.equal($('lt-answer-clock').textContent, '4');
  advance(4000);
  assert.equal(recorders.length, before + 1);
  assert.equal(st().phase, 'rec');
  assert.equal($('lt-answer-clock').textContent, '0:45');
  assert.equal(visible('lt-answer-dot'), true);
  assert.equal(visible('lt-answer-stop'), true);
  advance(1000);
  assert.equal($('lt-answer-clock').textContent, '0:44');
  advance(9000);
  lt.stopNow();
  await flush();
  assert.equal(seen.answers.length, 1);
  assert.equal(seen.answers[0].n, 0);
  assert.equal(seen.answers[0].body.get('seconds'), '10');
  assert.equal(st().q, 1);
  assert.equal($('lt-question').textContent, 'What would you change about your city?');
});

test('an answer left running stops at 45 s and sends 45', async () => {
  const seen = await start();
  await throughItems();
  advance(5000);
  advance(45000);
  await flush();
  assert.equal(seen.answers[0].body.get('seconds'), '45');
  assert.equal(st().q, 1);
});

test('finishing waits for every upload still going, then /finish, then the result', async () => {
  const gate = deferred();
  const seen = await start({ item: (n) => (n === 11 ? gate.promise : jsonResponse({ i: n, done: true })) });
  await throughItems();
  await answerFor();
  await answerFor();
  assert.equal(st().step, 'finishing');
  assert.deepEqual(shown(), ['lt-finish']);
  assert.equal($('lt-finish-text').textContent, '받아쓰는 중이에요');
  assert.equal(seen.finishes, 0);
  // Recording is over: the microphone is let go here, not at the result.
  assert.ok(lastStream().tracks[0].stopped);
  gate.resolve(jsonResponse({ i: 11, done: true }));
  await flush();
  assert.equal(seen.finishes, 1);
  assert.equal(st().step, 'result');
  assert.deepEqual(shown(), ['lt-result']);
  assert.deepEqual(rendered, [RESULT]);
});

test('/finish is slow: 결과를 계산하는 중이에요 while it works', async () => {
  const gate = deferred();
  await start({ finish: () => gate.promise });
  await throughItems();
  await answerFor();
  await answerFor();
  assert.equal($('lt-finish-text').textContent, '결과를 계산하는 중이에요');
  assert.equal(visible('lt-finish-dots'), true);
  assert.equal(visible('lt-finish-retry'), false);
  gate.resolve(jsonResponse(RESULT));
  await flush();
  assert.deepEqual(rendered, [RESULT]);
});

test('pending uploads are sent again before /finish', async () => {
  let broken = true;
  const seen = await start({
    item: (n) => (n === 3 && broken ? fail503() : jsonResponse({ i: n, done: true })),
  });
  for (let i = 0; i < 4; i += 1) await sayItem();
  assert.equal(st().pending, 1);
  broken = false;
  for (let i = 4; i < 12; i += 1) await sayItem();
  await answerFor();
  await answerFor();
  const threes = seen.items.filter((x) => x.n === 3);
  assert.equal(threes.length, 3);
  assert.ok(seen.calls.lastIndexOf('/api/level-test/7/items/3') < seen.calls.indexOf('/api/level-test/7/finish'));
  assert.equal(st().step, 'result');
});

test('a pending upload failing again: 받아쓰기를 하지 못했어요 and 다시 시도, which sends it and finishes', async () => {
  let broken = true;
  const seen = await start({
    item: (n) => (n === 0 && broken ? fail503() : jsonResponse({ i: n, done: true })),
  });
  await throughItems();
  await answerFor();
  await answerFor();
  assert.equal(st().step, 'finishing');
  assert.equal($('lt-finish-text').textContent, '받아쓰기를 하지 못했어요');
  assert.equal(visible('lt-finish-retry'), true);
  assert.equal(visible('lt-finish-dots'), false);
  assert.equal(seen.finishes, 0);
  broken = false;
  lt.retryFinish();
  await flush();
  assert.equal(seen.finishes, 1);
  assert.equal(st().step, 'result');
  assert.deepEqual(rendered, [RESULT]);
});

test('/finish failing: its message and 다시 시도', async () => {
  const seen = await start({
    finish: (k) => (k === 1
      ? jsonResponse({ detail: '아직 따라 말하기가 끝나지 않았어요' }, { ok: false, status: 400 })
      : jsonResponse(RESULT)),
  });
  await throughItems();
  await answerFor();
  await answerFor();
  assert.equal($('lt-finish-text').textContent, '아직 따라 말하기가 끝나지 않았어요');
  assert.equal(visible('lt-finish-retry'), true);
  lt.retryFinish();
  await flush();
  assert.equal(seen.finishes, 2);
  assert.deepEqual(rendered, [RESULT]);
});

/* ---------- leaving ---------- */

test('leaving mid-recording: nothing uploaded, recorder stopped, mic released, clocks gone', async () => {
  const seen = await start();
  await hear();
  const r = lastRecorder();
  homeClick();
  await flush();
  assert.equal(router.current(), 'home');
  assert.equal(st().step, 'idle');
  assert.deepEqual(r.calls, ['start', 'stop']);
  assert.ok(lastStream().tracks[0].stopped);
  assert.equal(tickers.size, 0);
  assert.equal(seen.items.length, 0);
});

test('leaving while a clip plays stops it, and its late end starts nothing', async () => {
  await start();
  const clip = lastClip();
  mypageClick();
  await flush();
  assert.equal(clip.paused, true);
  clip.fire('ended');
  await flush();
  assert.equal(recorders.filter((r) => r.state === 'recording').length, 0);
  assert.equal(st().step, 'idle');
});

test('late answers after leaving draw nothing: an upload, /finish, and the test creation', async () => {
  // An upload in flight.
  const gate = deferred();
  await start({ item: () => gate.promise, finish: () => gate.promise });
  await sayItem();
  lt.leaveLevelTest();
  gate.resolve(fail503());
  await flush();
  assert.equal(st().pending, 0);
  assert.equal(st().step, 'idle');

  // The test being created.
  const made = deferred();
  const seen = await open({ create: () => made.promise });
  lt.startTest();
  await flush();
  lt.leaveLevelTest();
  made.resolve(jsonResponse(CREATED));
  await flush();
  assert.equal(st().step, 'idle');
  assert.equal(st().testId, null);
  assert.ok(lastStream().tracks[0].stopped);
  assert.equal(seen.items.length, 0);
});

test('leaving during finishing: /finish answering late draws no result', async () => {
  const gate = deferred();
  await start({ finish: () => gate.promise });
  await throughItems();
  await answerFor();
  await answerFor();
  lt.leaveLevelTest();
  gate.resolve(jsonResponse(RESULT));
  await flush();
  assert.deepEqual(rendered, []);
  assert.equal(st().step, 'idle');
});

test('opening again after leaving starts over at the intro, with a new test', async () => {
  const seen = await start();
  await sayItem();
  lt.leaveLevelTest();
  lt.openLevelTest();
  assert.equal(st().step, 'intro');
  assert.deepEqual(shown(), ['lt-intro']);
  lt.startTest();
  await flush();
  assert.equal(st().i, 0);
  assert.equal(seen.calls.filter((u) => u === '/api/level-test').length, 2);
});

/* ---------- the card ---------- */

test('every slot is an .lt-slot in one card, and only a slot coming in gets the fade class', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['lt-intro', 'lt-item', 'lt-answer', 'lt-trouble', 'lt-finish', 'lt-result']) {
    assert.match(html, new RegExp(`id="${id}" class="lt-slot[ "]`), id);
  }
  await start();
  assert.ok($('lt-item').classList.contains('lt-enter'));
  $('lt-item').classList.remove('lt-enter');
  await sayItem();
  // One sentence to the next is the same slot: no blink.
  assert.equal($('lt-item').classList.contains('lt-enter'), false);
});

/* ---------- CSS ---------- */

// Line endings normalised: a Windows checkout with core.autocrlf turns the
// file CRLF, and the block searches below look for '\n}'.
const css = readFileSync(new URL('../css/components.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function ruleBody(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf('}', start));
}

test('every slot stands on the same floor, and nothing on the card moves by transform', () => {
  assert.match(ruleBody('.lt-slot'), /min-height: \d/);
  for (const sel of ['.lt-card', '.lt-slot', '.lt-slot.lt-enter', '.lt-rec', '.lt-bar-fill', '.lt-actions', '.lt-result']) {
    assert.doesNotMatch(ruleBody(sel), /transform/, sel);
  }
  const block = css.slice(css.indexOf('/* --- 레벨 테스트'), css.indexOf('@media (prefers-reduced-motion', css.indexOf('/* --- 레벨 테스트')));
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /transform/);
  // Both buttons of a sentence share one cell.
  assert.match(ruleBody('.lt-actions > *'), /grid-area: 1 \/ 1/);
});

test('the slot fade is opacity only, and reduced motion switches it and the dot off', () => {
  const start = css.indexOf('@keyframes lt-fade');
  assert.ok(start >= 0);
  const frames = css.slice(start, css.indexOf('}\n}', start));
  assert.match(frames, /opacity/);
  assert.doesNotMatch(frames, /transform/);
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]).join('\n');
  assert.match(reduced, /\.lt-slot\.lt-enter[^{]*\{[^}]*animation: none/);
  assert.match(reduced, /\.lt-dot[^{]*\{[^}]*animation: none/);
});
