/* 레벨 테스트: twelve sentences heard once and said straight back, then two
   questions answered for up to 45 seconds each. The server makes the test
   (and its twelve voices), takes each recording as it comes, and scores the
   lot at /finish.

   One card (#lt-card) with one slot showing at a time, every slot on the same
   floor (components.css): a step change is a short opacity fade in place, and
   the card never changes size.

   The steps are nextStep's table: pure, so the order can be read and tested
   apart from the DOM. Inside a step there are phases (a sentence playing, then
   recording) that only this module's DOM code knows about.

   The sentence is never shown. It is played once from the server's clip with
   no text to fall back to. Only a clip that audio.js reports as played to its
   end ('ended') counts as heard; an error, the browser-voice fallback, a stop
   from elsewhere, or no word at all within LISTEN_WATCHDOG_MS is a clip that
   did not play. That offers 다시 듣기 once, and after that the learner records
   anyway rather than ever reading it. A sentence with no clip at all goes
   straight to recording.

   Uploads go in the background: stopping a recording moves to the next step
   at once, and its upload runs beside it (one automatic retry). One that still
   fails waits in `pending` and is sent again before /finish.

   Every answer is checked against a token: (testId, attempt) for anything
   that belongs to the test -- uploads, /finish -- and a step counter for
   anything that belongs to one step (a clip ending, a clock tick). Leaving
   bumps both, so nothing late draws on a screen that has moved on. */
import { $, postJSON, state, setShown } from './api.js';
import { play, stopPlayback } from './audio.js';
import * as router from './router.js';
import { micAvailable, openMic, startRecording, stopRecording, closeMic } from './recorder.js';

export const ITEM_COUNT = 12;
export const QUESTION_COUNT = 2;
export const PREP_SECONDS = 5;
export const ANSWER_SECONDS = 45;
// The window for a sentence whose length is unknown (its clip never played).
export const UNKNOWN_WINDOW = 10;
// A backstop behind audio.js's reason: an 'ended' sooner than this is not a
// sentence that was really heard.
const MIN_CLIP_MS = 300;
// No word from the clip at all in this long (no ended, no error): it is taken
// as not played, rather than leaving the card on 잘 들어 보세요 for ever. The
// longest sentence runs well under half of it.
export const LISTEN_WATCHDOG_MS = 15000;
// The one automatic re-upload waits this long first: a 503 is usually Whisper
// still loading, and asking again at once only meets it loading.
export const RETRY_DELAY_MS = 1500;
const TICK_MS = 200;

export const TEXT = {
  intro: '약 7분 · 조용한 곳에서 · 문장은 한 번만 들려요',
  preparing: '문장 음성을 준비하는 중이에요',
  startFailed: '테스트를 시작하지 못했어요 — 다시 시도해 주세요',
  micBlocked: '마이크를 쓸 수 없어요 — 브라우저 설정에서 마이크를 허용해 주세요',
  itemCount: (i) => `따라 말하기 ${i + 1}/${ITEM_COUNT}`,
  answerCount: (q) => `답하기 ${q + 1}/${QUESTION_COUNT}`,
  listen: '잘 들어 보세요',
  say: '바로 따라 말해 보세요',
  playFailed: '문장을 재생하지 못했어요',
  prep: '생각해 보세요. 0이 되면 녹음이 시작돼요',
  answering: '말하는 중이에요',
  emptyRecording: '녹음된 소리가 없어요 — 다시 해 주세요',
  uploading: '받아쓰는 중이에요',
  computing: '결과를 계산하는 중이에요',
  transcribeFailed: '받아쓰기를 하지 못했어요',
  finishFailed: '결과를 계산하지 못했어요',
};

/* ---------- the steps ---------- */

/* Where `event` takes `s` ({ step, i?, q? }). LEAVE goes to idle from
   anywhere; anything else the table does not know leaves `s` as it is. */
export function nextStep(s, event) {
  if (event === 'LEAVE') return { step: 'idle' };
  switch (s.step) {
    case 'idle':
      return event === 'OPEN' ? { step: 'intro' } : s;
    case 'intro':
      return event === 'START' ? { step: 'item', i: 0 } : s;
    case 'item':
      if (event !== 'NEXT') return s;
      return s.i + 1 < ITEM_COUNT ? { step: 'item', i: s.i + 1 } : { step: 'answer', q: 0 };
    case 'answer':
      if (event !== 'NEXT') return s;
      return s.q + 1 < QUESTION_COUNT ? { step: 'answer', q: s.q + 1 } : { step: 'finishing' };
    case 'finishing':
      return event === 'DONE' ? { step: 'result' } : s;
    default:
      return s;
  }
}

/* The seconds a sentence gets to be said back in: twice its length and three
   more, never under six. */
export function itemWindow(clipSeconds) {
  if (!Number.isFinite(clipSeconds) || clipSeconds <= 0) return UNKNOWN_WINDOW;
  return Math.max(6, Math.round(clipSeconds * 2 + 3));
}

/* The clock every countdown reads -- an object so a test can stand a fake one
   in (an imported binding cannot be reassigned). */
export const clock = {
  now: () => Date.now(),
  every: (fn, ms) => setInterval(fn, ms),
  cancel: (id) => clearInterval(id),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/* The result screen. Drawn by Task 4; here it is only called. */
export function renderLevelResult(result) { // eslint-disable-line no-unused-vars
}

/* What finishing calls -- an object, like clock, so a test can see the call. */
export const view = { renderLevelResult: (result) => renderLevelResult(result) };

/* ---------- state ---------- */

let s = { step: 'idle' };
let attempt = 0;        // the test: bumped by open and leave
let seq = 0;            // the step's phase: bumped by every phase change and by leave
let test = null;        // { id, items, questions } once the server made one
let mic = null;         // recorder.js's { stream }
let rec = null;         // the recording running now: { handle, startedAt, limit, kind }
let ticker = null;
let phase = 'idle';     // inside a step: 'wait' | 'listen' | 'failed' | 'prep' | 'rec' | 'saving' | 'trouble'
let listens = 0;        // plays of the current sentence
let heardLimit = null;  // the current sentence's window, once it has been heard
let starting = false;
let finishing = false;
let pending = [];       // uploads that failed twice: [{ kind, n, blob, seconds }]
const inflight = new Set();

export function levelTestState() {
  return { ...s, phase, attempt, testId: test && test.id, pending: pending.length,
           inflight: inflight.size };
}

const token = () => ({ testId: test ? test.id : null, attempt });
const live = (tok) => tok.attempt === attempt && tok.testId === (test ? test.id : null);

/* ---------- the card ---------- */

const SLOTS = ['lt-intro', 'lt-item', 'lt-answer', 'lt-trouble', 'lt-finish', 'lt-result'];

function showSlot(shown) {
  for (const id of SLOTS) {
    const el = $(id);
    const on = id === shown;
    // Only a slot actually coming in fades: one sentence to the next is the
    // same slot, and must not blink.
    if (on && el.hidden) {
      el.classList.remove('lt-enter');
      el.classList.add('lt-enter');
    }
    el.hidden = !on;
  }
}

function go(event) {
  s = nextStep(s, event);
}

function clearTicker() {
  if (ticker !== null) clock.cancel(ticker);
  ticker = null;
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/* ---------- open / intro ---------- */

export function openLevelTest() {
  leaveLevelTest();
  attempt += 1;
  go('OPEN');
  phase = 'wait';
  router.show('leveltest');
  showSlot('lt-intro');
  setShown($('lt-intro-status'), false);
  if (!micAvailable()) {
    $('lt-intro-status').textContent = TEXT.micBlocked;
    setShown($('lt-intro-status'), true);
    $('lt-start').disabled = true;
    return;
  }
  $('lt-start').disabled = false;
}

function introNote(text) {
  $('lt-intro-status').textContent = text;
  setShown($('lt-intro-status'), true);
}

/* 시작: the microphone first (so a permission prompt comes before the wait),
   then the test -- whose voices take the server a few seconds. */
export async function startTest() {
  if (s.step !== 'intro' || starting) return;
  starting = true;
  const tok = token();
  $('lt-start').disabled = true;
  introNote(TEXT.preparing);
  const m = await openMic();
  // Left meanwhile: leaving already cleared `starting`, and a new open may
  // have set it again -- a stale start must not touch it.
  if (!live(tok) || s.step !== 'intro') { closeMic(m); return; }
  if (!m) {
    starting = false;
    // A refused microphone stays refused until the learner changes it in the
    // browser: 시작 stays off.
    introNote(TEXT.micBlocked);
    return;
  }
  let data = null;
  let error = null;
  try {
    data = await postJSON('/level-test', { language: state.language });
  } catch (err) {
    error = err;
  }
  if (!live(tok) || s.step !== 'intro') { closeMic(m); return; }
  starting = false;
  if (!data || !data.test_id || !Array.isArray(data.items)) {
    closeMic(m);
    // The server's own words when it gave some (TTS down); otherwise ours.
    introNote(error && error.status === 503 ? error.message : TEXT.startFailed);
    $('lt-start').disabled = false;
    return;
  }
  mic = m;
  test = { id: data.test_id, items: data.items, questions: data.questions || [] };
  pending = [];
  go('START');
  enterItem();
}

/* ---------- 따라 말하기 ---------- */

function enterItem() {
  seq += 1;
  listens = 0;
  heardLimit = null;
  showSlot('lt-item');
  $('lt-item-count').textContent = TEXT.itemCount(s.i);
  playItem();
}

function itemStatus(text) {
  $('lt-item-status').textContent = text;
}

function playItem() {
  seq += 1;
  const mySeq = seq;
  phase = 'listen';
  listens += 1;
  itemStatus(TEXT.listen);
  setShown($('lt-item-rec'), false);
  setShown($('lt-item-stop'), false);
  setShown($('lt-relisten'), false);
  $('lt-item-bar').style.width = '100%';
  const item = test.items[s.i] || {};
  // No clip to play: 다시 듣기 could only fail the same way. Record at once.
  if (!item.audio_key) { toRecording(UNKNOWN_WINDOW); return; }
  const t0 = clock.now();
  ticker = clock.every(() => {
    if (mySeq !== seq || phase !== 'listen') return;
    if (clock.now() - t0 >= LISTEN_WATCHDOG_MS) {
      heard(mySeq, null, 'watchdog');
      // Whatever might still start playing must not talk into the recording.
      stopPlayback();
    }
  }, TICK_MS);
  // No fallback text: the sentence is never read out by the browser's voice
  // from its words, and never shown.
  play(item.audio_key, '', (reason) => heard(mySeq, clock.now() - t0, reason));
}

function heard(mySeq, ms, reason) {
  if (mySeq !== seq || s.step !== 'item' || phase !== 'listen') return;
  clearTicker();
  if (reason !== 'ended' || ms === null || ms < MIN_CLIP_MS) {
    if (listens < 2) {
      phase = 'failed';
      itemStatus(TEXT.playFailed);
      $('lt-relisten').disabled = false;
      setShown($('lt-relisten'), true);
      return;
    }
    // Twice without sound: record anyway -- the sentence is never shown.
    toRecording(UNKNOWN_WINDOW);
    return;
  }
  toRecording(itemWindow(ms / 1000));
}

/* The sentence has had its hearing: from here a redo (a mic fault) goes back
   to recording with this same window, never to a second hearing. */
function toRecording(limit) {
  heardLimit = limit;
  beginRecording('item', limit);
}

/* 다시 듣기, once, for a sentence whose clip did not play. */
export function relisten() {
  if (s.step !== 'item' || phase !== 'failed') return;
  playItem();
}

/* ---------- recording (both kinds) ---------- */

function beginRecording(kind, limit) {
  const handle = startRecording(mic);
  if (!handle) { trouble(TEXT.micBlocked); return; }
  seq += 1;
  const mySeq = seq;
  phase = 'rec';
  rec = { handle, startedAt: clock.now(), limit, kind };
  if (kind === 'item') {
    itemStatus(TEXT.say);
    setShown($('lt-relisten'), false);
    setShown($('lt-item-rec'), true);
    $('lt-item-bar').style.width = '100%';
    $('lt-item-stop').disabled = false;
    setShown($('lt-item-stop'), true);
  } else {
    $('lt-answer-status').textContent = TEXT.answering;
    $('lt-answer-clock').textContent = mmss(limit);
    setShown($('lt-answer-dot'), true);
    $('lt-answer-stop').disabled = false;
    setShown($('lt-answer-stop'), true);
  }
  ticker = clock.every(() => {
    if (mySeq !== seq || phase !== 'rec') return;
    const elapsed = clock.now() - rec.startedAt;
    const leftMs = Math.max(0, limit * 1000 - elapsed);
    if (kind === 'item') $('lt-item-bar').style.width = `${Math.round((leftMs / (limit * 1000)) * 1000) / 10}%`;
    else $('lt-answer-clock').textContent = mmss(Math.ceil(leftMs / 1000));
    if (elapsed >= limit * 1000) stopNow();
  }, TICK_MS);
}

/* 다 말했어요, or the window running out. The recording goes up behind the
   next step, which starts at once. */
export async function stopNow() {
  if (phase !== 'rec' || !rec) return;
  clearTicker();
  const { handle, startedAt, limit, kind } = rec;
  rec = null;
  seq += 1;
  const mySeq = seq;
  phase = 'saving';
  const elapsed = Math.min(limit * 1000, Math.max(0, clock.now() - startedAt));
  if (kind === 'item') {
    $('lt-item-stop').disabled = true;
    setShown($('lt-item-stop'), false);
  } else {
    $('lt-answer-stop').disabled = true;
    setShown($('lt-answer-stop'), false);
  }
  const blob = await stopRecording(handle);
  if (mySeq !== seq) return;
  if (!blob) { trouble(TEXT.emptyRecording); return; }
  const tok = token();
  if (kind === 'item') {
    upload(tok, { kind: 'item', n: s.i, blob });
  } else {
    // The server takes 0 < seconds <= 60.
    const seconds = Math.min(limit, Math.max(0.1, Math.round(elapsed / 100) / 10));
    upload(tok, { kind: 'answer', n: s.q, blob, seconds });
  }
  go('NEXT');
  if (s.step === 'item') enterItem();
  else if (s.step === 'answer') enterAnswer();
  else enterFinishing();
}

/* A recording that could not start, or came back empty: say so, and redo this
   step with the microphone opened afresh. */
function trouble(text) {
  clearTicker();
  seq += 1;
  phase = 'trouble';
  $('lt-trouble-text').textContent = text;
  $('lt-redo').disabled = false;
  showSlot('lt-trouble');
}

/* 다시 하기, from the trouble slot. */
export async function redo() {
  if (phase !== 'trouble') return;
  const tok = token();
  $('lt-redo').disabled = true;
  closeMic(mic);
  mic = null;
  const m = await openMic();
  if (!live(tok) || phase !== 'trouble') { closeMic(m); return; }
  if (!m) {
    $('lt-trouble-text').textContent = TEXT.micBlocked;
    $('lt-redo').disabled = false;
    return;
  }
  mic = m;
  if (s.step === 'answer') { enterAnswer(); return; }
  // The sentence was already heard (a trouble only ever follows the hearing):
  // back to saying it, same window, no second hearing.
  showSlot('lt-item');
  $('lt-item-count').textContent = TEXT.itemCount(s.i);
  if (heardLimit === null) { enterItem(); return; }
  beginRecording('item', heardLimit);
}

/* ---------- uploads ---------- */

async function send(tok, job) {
  const form = new FormData();
  form.append('file', job.blob, `${job.kind}-${job.n}.webm`);
  if (job.kind === 'answer') form.append('seconds', String(job.seconds));
  const path = job.kind === 'item' ? 'items' : 'answers';
  try {
    const res = await fetch(`/api/level-test/${tok.testId}/${path}/${job.n}`, { method: 'POST', body: form });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

/* One upload, in the background, retried once after RETRY_DELAY_MS; still
   failing, it waits in `pending` for finishing. */
function upload(tok, job) {
  const p = (async () => {
    if (await send(tok, job)) return;
    if (!live(tok)) return;
    await clock.wait(RETRY_DELAY_MS);
    if (!live(tok)) return;
    if (await send(tok, job)) return;
    if (live(tok)) pending.push(job);
  })();
  inflight.add(p);
  p.finally(() => inflight.delete(p));
}

/* ---------- 답하기 ---------- */

function enterAnswer() {
  seq += 1;
  const mySeq = seq;
  phase = 'prep';
  showSlot('lt-answer');
  const question = test.questions[s.q] || {};
  $('lt-answer-count').textContent = TEXT.answerCount(s.q);
  $('lt-question').textContent = question.text || '';
  $('lt-question-meaning').textContent = question.meaning || '';
  $('lt-answer-status').textContent = TEXT.prep;
  $('lt-answer-clock').textContent = String(PREP_SECONDS);
  setShown($('lt-answer-dot'), false);
  setShown($('lt-answer-stop'), false);
  const t0 = clock.now();
  ticker = clock.every(() => {
    if (mySeq !== seq || phase !== 'prep') return;
    const left = Math.max(0, Math.ceil((PREP_SECONDS * 1000 - (clock.now() - t0)) / 1000));
    $('lt-answer-clock').textContent = String(left);
    if (left === 0) {
      clearTicker();
      beginRecording('answer', ANSWER_SECONDS);
    }
  }, TICK_MS);
}

/* ---------- finishing ---------- */

function finishNote(text, { failed = false } = {}) {
  $('lt-finish-text').textContent = text;
  setShown($('lt-finish-dots'), !failed);
  $('lt-finish-retry').disabled = !failed;
  setShown($('lt-finish-retry'), failed);
}

function enterFinishing() {
  seq += 1;
  phase = 'finishing';
  closeMic(mic);
  mic = null;
  showSlot('lt-finish');
  runFinish();
}

/* Every upload still going is waited for; every one that failed is sent once
   more; then /finish. A failure on either leaves 다시 시도, which runs this
   again. */
async function runFinish() {
  if (s.step !== 'finishing' || finishing) return;
  finishing = true;
  const tok = token();
  try {
    finishNote(TEXT.uploading);
    while (inflight.size) {
      await Promise.all([...inflight]);
      if (!live(tok)) return;
    }
    const jobs = pending;
    pending = [];
    for (const job of jobs) {
      const ok = await send(tok, job);
      if (!live(tok)) return;
      if (!ok) pending.push(job);
    }
    if (pending.length) {
      finishNote(TEXT.transcribeFailed, { failed: true });
      return;
    }
    finishNote(TEXT.computing);
    let result = null;
    let error = null;
    try {
      result = await postJSON(`/level-test/${tok.testId}/finish`);
    } catch (err) {
      error = err;
    }
    if (!live(tok)) return;
    if (!result) {
      // 400 and 503 carry a sentence of the server's own; anything else ours.
      const own = error && (error.status === 400 || error.status === 503);
      finishNote(own ? error.message : TEXT.finishFailed, { failed: true });
      return;
    }
    go('DONE');
    phase = 'result';
    showSlot('lt-result');
    view.renderLevelResult(result);
  } finally {
    if (live(tok)) finishing = false;
  }
}

/* 다시 시도, from finishing. */
export function retryFinish() {
  if (s.step !== 'finishing' || finishing) return;
  runFinish();
}

/* ---------- leaving ---------- */

/* Home, my page, anything that takes the learner off this screen. The test is
   dropped: a recording running now is never uploaded, answers still coming
   draw nothing, and starting again makes a new test. Safe to call when the
   screen was never open. */
export function leaveLevelTest() {
  if (s.step === 'idle' && !mic && !rec) return;
  attempt += 1;
  seq += 1;
  clearTicker();
  stopPlayback();
  if (rec) {
    // Its last chunk has nowhere to go.
    rec.handle.recorder.ondataavailable = null;
    stopRecording(rec.handle);
  }
  rec = null;
  closeMic(mic);
  mic = null;
  test = null;
  pending = [];
  inflight.clear();
  phase = 'idle';
  starting = false;
  finishing = false;
  go('LEAVE');
}
