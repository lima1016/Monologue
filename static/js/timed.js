/* 1분 말하기: one question, sixty seconds of speaking, graded after, then once
   more to compare. The pick screen hands a created session here through
   openTimed({ sessionId, topic, meaning, starter }).

   One card (#timed-card). Its head -- the question, its meaning, a hint --
   stays put for the whole session; its body shows one stage slot at a time,
   every slot on the same floor (components.css), so a stage change is a short
   opacity fade in place rather than a card that jumps.

   The stages and what moves between them are nextStage's table below: a pure
   function, so the flow can be read (and tested) apart from the DOM.

   The microphone here is this module's own: one getUserMedia per round, one
   MediaRecorder for the whole minute, and one SpeechRecognition that only
   shows live words. audio.js's turn recognition and its handlers are never
   touched -- they belong to the conversation screen, and a minute of speech
   is not a turn.

   Every request's answer is checked against the token it went out with
   (session, attempt -- and the round rides along in its URL): leaving, or
   starting the next round, bumps the attempt, and a late answer for the old
   one draws nothing. */
import { $, postJSON, state, notify, setShown } from './api.js';
import { play, stopPlayback, speakInBrowser, BCP47 } from './audio.js';
import { annotate } from './reading.js';
import { renderReport } from './session.js';
import * as router from './router.js';
import { compareRounds, formatMetric, fixedCount } from './timedmath.js';

export const PREP_SECONDS = 10;
export const ROUND_SECONDS = 60;
const TICK_MS = 200;
// Enough for the last two lines at any card width; CSS shows only the bottom two.
const LIVE_TAIL = 240;

export const TEXT = {
  micBlocked: '마이크를 쓸 수 없어요 — 브라우저 설정에서 마이크를 허용해 주세요',
  emptyRecording: '녹음된 소리가 없어요 — 다시 해 주세요',
  grading: (i, n) => `교정하는 중이에요 · ${i}/${n}문장`,
  nothingHeard: '알아들은 문장이 없어요',
  good: '✓ 좋아요',
  fixedLabel: '고친 문장',
  gradeFailed: '교정하지 못했어요',
  retry: '다시 시도',
  nativeWait: '원어민 답을 만드는 중이에요',
  nativeFailed: '원어민 답을 만들지 못했어요',
  uploading: '받아쓰는 중이에요',
  transcribeFailed: '받아쓰기를 하지 못했어요',
};

/* ---------- the flow ---------- */

const TABLE = {
  prep: { START: 'rec', PREP_DONE: 'rec' },
  rec: { STOP: 'upload', TIME_UP: 'upload' },
  upload: { UPLOADED: 'grading', TRANSCRIBE_FAILED: 'retry-transcribe', EMPTY: 'empty' },
  'retry-transcribe': { RETRY: 'upload' },
  grading: { GRADED: 'result' },
  result: { AGAIN: 'prep' },
  empty: { BACK: 'prep' },
};

/* Where `event` takes `stage`. LEAVE goes to idle from anywhere; anything the
   table does not list leaves the stage as it is. */
export function nextStage(stage, event) {
  if (event === 'LEAVE') return 'idle';
  const row = TABLE[stage];
  return (row && row[event]) || stage;
}

/* The clock the countdowns read. An object so a test can stand a fake one in
   (an imported binding cannot be reassigned). */
export const clock = {
  now: () => Date.now(),
  every: (fn, ms) => setInterval(fn, ms),
  cancel: (id) => clearInterval(id),
};

/* ---------- state ---------- */

let ctx = null;          // { sessionId, topic, meaning, starter } | null
let stage = 'idle';
let attempt = 0;         // bumped by open, AGAIN, LEAVE: only the latest round draws
let round = null;        // the server's number for this round, once it has one
let seconds = 0;         // this round's length, as uploaded
let blob = null;         // this round's recording (a re-upload, ▶ 내 녹음)
let blobUrl = null;
let mineClip = null;
let sentences = [];      // this round's lines: [{ text, row, verdict, data }]
let native = null;       // { native, audio_key } once it came
let first = null;        // the first finished round's counts, to compare against
let finished = 0;        // rounds that reached the result on this screen
let ending = false;

/* The microphone for this round: { state: 'pending' | 'ready' | 'blocked',
   stream, recorder, chunks, recognition, finalText, wantStart, stopped }. */
let mic = null;
let ticker = null;
let startedAt = 0;

export function timedState() {
  return { stage, round, attempt, sessionId: ctx && ctx.sessionId, first, finished };
}

const token = () => ({ sessionId: ctx && ctx.sessionId, attempt });
const live = (tok) => Boolean(ctx) && tok.sessionId === ctx.sessionId && tok.attempt === attempt;

/* ---------- the card ---------- */

const SLOT = {
  prep: 'timed-prep', rec: 'timed-rec', upload: 'timed-upload',
  'retry-transcribe': 'timed-retry', empty: 'timed-empty',
  grading: 'timed-review', result: 'timed-review',
};

function setStage(next) {
  stage = next;
  const shown = SLOT[next];
  if (!shown) return;
  for (const id of new Set(Object.values(SLOT))) {
    const el = $(id);
    const on = id === shown;
    // Only a slot that is actually coming in fades: grading -> result is the
    // same slot filling in, and must not blink.
    if (on && el.hidden) {
      el.classList.remove('timed-enter');
      el.classList.add('timed-enter');
    }
    el.hidden = !on;
  }
}

function go(event) {
  const next = nextStage(stage, event);
  if (next !== stage) setStage(next);
}

function clearTicker() {
  if (ticker !== null) clock.cancel(ticker);
  ticker = null;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/* ---------- open / prep ---------- */

export function openTimed({ sessionId, topic, meaning = '', starter = '' }) {
  leaveTimed();
  ctx = { sessionId, topic, meaning, starter };
  first = null;
  finished = 0;
  $('timed-topic').textContent = topic || '';
  $('timed-meaning').textContent = meaning || '';
  setShown($('timed-meaning'), Boolean(meaning));
  $('timed-starter').textContent = starter ? `힌트: ${starter}` : '';
  setShown($('timed-starter'), Boolean(starter));
  router.show('timed');
  enterPrep();
}

/* Ten seconds with the question on screen, then the minute starts by itself. */
function enterPrep() {
  attempt += 1;
  stopPlayback();
  resetRound();
  setStage('prep');
  const tok = token();
  $('timed-prep-count').textContent = String(PREP_SECONDS);
  $('timed-start').disabled = false;
  setShown($('timed-mic-note'), false);
  openMic(tok);
  if (stage !== 'prep' || !mic || mic.state === 'blocked') return;
  startedAt = clock.now();
  ticker = clock.every(() => {
    if (!live(tok) || stage !== 'prep') return;
    const left = Math.max(0, Math.ceil((PREP_SECONDS * 1000 - (clock.now() - startedAt)) / 1000));
    $('timed-prep-count').textContent = String(left);
    if (left === 0) {
      clearTicker();
      startNow('PREP_DONE');
    }
  }, TICK_MS);
}

function micSupported() {
  return typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices)
    && typeof navigator.mediaDevices.getUserMedia === 'function';
}

function blockMic(m) {
  m.state = 'blocked';
  clearTicker();
  $('timed-mic-note').textContent = TEXT.micBlocked;
  setShown($('timed-mic-note'), true);
  $('timed-start').disabled = true;
}

/* Asked for during prep, so a first-time permission prompt comes up while the
   learner is thinking, and the minute starts the moment it should. */
async function openMic(tok) {
  const m = { state: 'pending', stream: null, recorder: null, chunks: [], recognition: null,
              finalText: '', wantStart: null, stopped: false };
  mic = m;
  if (!micSupported()) { blockMic(m); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    if (live(tok) && mic === m) blockMic(m);
    return;
  }
  if (!live(tok) || mic !== m) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  m.stream = stream;
  m.state = 'ready';
  if (m.wantStart) begin(m.wantStart);
}

/* 바로 시작, or the countdown reaching 0. A mic still being granted starts the
   minute as soon as it is; a refused one never does. */
export function startNow(event = 'START') {
  if (stage !== 'prep' || !mic || mic.state === 'blocked') return;
  if (mic.state === 'pending') { mic.wantStart = event; return; }
  begin(event);
}

/* ---------- the minute ---------- */

/* A track whose stream died under us (mic unplugged, device gone) reads
   'ended': starting a recorder on it would only throw, same as below, but
   catching it here means the stream is never even handed to MediaRecorder. */
function streamUsable(stream) {
  const tracks = typeof stream.getAudioTracks === 'function'
    ? stream.getAudioTracks() : stream.getTracks();
  return tracks.some((t) => t.readyState !== 'ended');
}

function begin(event) {
  if (stage !== 'prep') return;
  clearTicker();
  // The microphone hears the learner, not a clip still talking.
  stopPlayback();
  const m = mic;
  let recorder;
  try {
    if (!streamUsable(m.stream)) throw new Error('ended');
    recorder = new MediaRecorder(m.stream);
    m.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data) m.chunks.push(e.data); };
    // Chrome throws NotSupportedError from start() (not the constructor) when
    // the stream's track has already ended -- must be caught here too, before
    // the stage moves, or a 0-byte recording gets uploaded a minute later.
    recorder.start();
  } catch {
    // A recorder that cannot be made or started would leave a minute ticking
    // with nothing recorded. Release the mic, say so, and stay in prep
    // (nothing has moved the stage yet) with 바로 시작 off.
    stopTracks(m);
    blockMic(m);
    return;
  }
  go(event);
  const tok = token();
  m.recorder = recorder;
  startRecognition(m);
  $('timed-live').textContent = '';
  $('timed-clock').textContent = mmss(ROUND_SECONDS);
  startedAt = clock.now();
  ticker = clock.every(() => {
    if (!live(tok) || stage !== 'rec') return;
    const elapsed = clock.now() - startedAt;
    const left = Math.max(0, Math.ceil((ROUND_SECONDS * 1000 - elapsed) / 1000));
    $('timed-clock').textContent = mmss(left);
    if (elapsed >= ROUND_SECONDS * 1000) stopNow('TIME_UP');
  }, TICK_MS);
}

/* Live words only -- what is graded is Whisper's transcript of the recording.
   Chrome ends a continuous recognition after a stretch of silence, so while
   the minute runs, onend starts it again. */
function startRecognition(m) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  const r = new Recognition();
  r.continuous = true;
  r.interimResults = true;
  r.lang = BCP47[state.language] || BCP47.en;
  let dead = false;
  r.onresult = (e) => {
    if (m.recognition !== r) return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const res = e.results[i];
      if (res.isFinal) m.finalText = `${m.finalText} ${res[0].transcript}`.trim();
      else interim += res[0].transcript;
    }
    const text = `${m.finalText} ${interim}`.trim();
    $('timed-live').textContent = text.length > LIVE_TAIL ? `…${text.slice(-LIVE_TAIL)}` : text;
  };
  r.onerror = (e) => {
    // No permission, no device, no network (Chrome's recogniser is a web
    // service): starting again would only fail again, forever.
    if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(e && e.error)) dead = true;
  };
  r.onend = () => {
    if (m.recognition !== r || m.stopped || dead || stage !== 'rec') return;
    try { r.start(); } catch { /* already running */ }
  };
  m.recognition = r;
  try { r.start(); } catch { m.recognition = null; }
}

function stopRecognition(m, { abort = false } = {}) {
  const r = m.recognition;
  m.recognition = null;
  if (!r) return;
  try { if (abort) r.abort(); else r.stop(); } catch { /* not running */ }
}

function stopTracks(m) {
  if (m && m.stream) m.stream.getTracks().forEach((t) => t.stop());
}

/* 다 말했어요, or the minute running out. The length sent is the clock's, and
   the whole recording goes up as one file. */
export async function stopNow(event = 'STOP') {
  if (stage !== 'rec') return;
  clearTicker();
  const elapsed = Math.min(ROUND_SECONDS * 1000, Math.max(0, clock.now() - startedAt));
  seconds = event === 'TIME_UP' ? ROUND_SECONDS : Math.max(0.1, Math.round(elapsed / 100) / 10);
  const m = mic;
  m.stopped = true;
  stopRecognition(m);
  $('timed-upload-text').textContent = TEXT.uploading;
  go(event);
  const tok = token();
  await new Promise((resolve) => {
    const r = m.recorder;
    if (!r || r.state === 'inactive') { resolve(); return; }
    r.addEventListener('stop', () => resolve(), { once: true });
    r.stop();
  });
  stopTracks(m);
  if (!live(tok)) return;
  const rec = new Blob(m.chunks, { type: (m.recorder && m.recorder.mimeType) || 'audio/webm' });
  // A dead mic (or one that never actually started) leaves nothing to send:
  // uploading it would only fail transcription server-side. Ask again instead,
  // without ever creating a round.
  if (!m.chunks.length || rec.size === 0) {
    $('timed-empty-text').textContent = TEXT.emptyRecording;
    go('EMPTY');
    return;
  }
  blob = rec;
  await upload(tok);
}

/* The empty-recording card's 다시 하기: no round was ever created, so this is
   just prep again for the same question -- the same path result's 같은
   주제로 다시 1분 (again()) takes. */
export function backToPrep() {
  if (stage !== 'empty') return;
  enterPrep();
}

async function upload(tok) {
  const form = new FormData();
  form.append('file', blob, 'round.webm');
  form.append('seconds', String(seconds));
  let res = null;
  try {
    res = await fetch(`/api/sessions/${tok.sessionId}/timed/rounds`, { method: 'POST', body: form });
  } catch {
    res = null;
  }
  if (!live(tok)) return;
  if (res && res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!live(tok)) return;
    // An OK whose body will not parse: the card must not sit on
    // 받아쓰는 중이에요 forever.
    if (!data) { transcribeFailed(); return; }
    transcribed(tok, data);
    return;
  }
  // A 503 means the server kept the recording and reserved the round: the
  // retry asks it to transcribe that round again. Anything else (the request
  // never arrived) left no round, and the retry sends the recording again.
  if (res) {
    const body = await res.json().catch(() => ({}));
    const detail = body && body.detail;
    if (detail && typeof detail === 'object' && detail.round) round = detail.round;
  }
  if (!live(tok)) return;
  transcribeFailed();
}

function transcribeFailed() {
  $('timed-retry-text').textContent = TEXT.transcribeFailed;
  $('timed-retry-btn').disabled = false;
  go('TRANSCRIBE_FAILED');
}

/* 받아쓰기 다시 시도. */
export async function retryTranscribe() {
  if (stage !== 'retry-transcribe') return;
  const tok = token();
  $('timed-retry-btn').disabled = true;
  go('RETRY');
  if (round === null) { await upload(tok); return; }
  let data = null;
  try {
    data = await postJSON(`/sessions/${tok.sessionId}/timed/rounds/${round}/transcribe`);
  } catch {
    data = null;
  }
  if (!live(tok)) return;
  if (!data) { transcribeFailed(); return; }
  transcribed(tok, data);
}

/* ---------- grading ---------- */

function transcribed(tok, data) {
  round = data.round;
  seconds = data.seconds ?? seconds;
  const stats = { words: data.words, wpm: data.wpm, long_pauses: data.long_pauses };
  go('UPLOADED');
  drawLines((data.sentences || []).map((s) => s.text));
  gradeFrom(0, tok, stats);
}

function drawLines(texts) {
  sentences = texts.map((text) => {
    const row = document.createElement('li');
    row.className = 'timed-line';
    // The learner's own words, as said: no strike-through, no .said.
    const said = document.createElement('p');
    said.className = 'timed-mine';
    said.textContent = text;
    const verdict = document.createElement('div');
    verdict.className = 'timed-verdict';
    row.append(said, verdict);
    return { text, row, verdict, data: null };
  });
  $('timed-lines').replaceChildren(...sentences.map((s) => s.row));
  $('timed-progress').hidden = false;
  $('timed-numbers').hidden = true;
  $('timed-progress').textContent = sentences.length
    ? TEXT.grading(1, sentences.length)
    : TEXT.nothingHeard;
  setShown($('timed-actions'), false);
  setShown($('timed-end-status'), false);
  $('timed-native').hidden = false;
  clearNative();
}

/* One sentence at a time, in order: the server writes round 1's sentences as
   practice rows as they are graded, so their order there is the order said.
   A sentence that fails stops the walk until its own 다시 시도 succeeds. */
async function gradeFrom(i, tok, stats) {
  const n = sentences.length;
  for (let k = i; k < n; k += 1) {
    $('timed-progress').textContent = TEXT.grading(k + 1, n);
    let data = null;
    try {
      data = await postJSON(`/sessions/${tok.sessionId}/timed/rounds/${round}/grade/${k}`);
    } catch {
      data = null;
    }
    if (!live(tok)) return;
    if (!data || (data.ok == null && !data.filler)) {
      gradeFailed(k, tok, stats);
      return;
    }
    drawVerdict(k, data);
  }
  await loadNative(tok);
  if (!live(tok)) return;
  toResult(stats);
}

function drawVerdict(k, data) {
  const s = sentences[k];
  s.data = data;
  const box = s.verdict;
  box.replaceChildren();
  box.className = 'timed-verdict';
  // A filler line ("Um.") has nothing to judge: it stays as said.
  if (data.filler) return;
  if (data.ok) {
    const good = document.createElement('p');
    good.className = 'timed-good';
    good.textContent = TEXT.good;
    box.append(good);
    return;
  }
  if (data.fixed) {
    const fixed = document.createElement('p');
    fixed.className = 'timed-fixed';
    const label = document.createElement('span');
    label.className = 'timed-label';
    label.textContent = TEXT.fixedLabel;
    // A fresh span: annotate() writes whenever /reading answers, and must land
    // on this line's own text and nothing else.
    const text = document.createElement('span');
    text.className = 'timed-fixed-text';
    text.textContent = data.fixed;
    fixed.append(label, document.createTextNode(' '), text);
    box.append(fixed);
    if (state.language === 'ja') annotate([{ el: text, text: data.fixed }]);
  }
  if (data.correction) {
    const why = document.createElement('p');
    why.className = 'timed-why';
    why.textContent = data.correction;
    box.append(why);
  }
}

function gradeFailed(k, tok, stats) {
  const box = sentences[k].verdict;
  box.replaceChildren();
  box.className = 'timed-verdict timed-failed';
  const msg = document.createElement('span');
  msg.textContent = TEXT.gradeFailed;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost btn-stable';
  btn.textContent = TEXT.retry;
  btn.addEventListener('click', () => {
    if (!live(tok) || stage !== 'grading' || btn.disabled) return;
    btn.disabled = true;
    box.replaceChildren();
    box.className = 'timed-verdict';
    gradeFrom(k, tok, stats);
  });
  box.append(msg, document.createTextNode(' '), btn);
}

/* ---------- 원어민이라면 ---------- */

function clearNative() {
  native = null;
  $('timed-native-text').replaceChildren();
  // Hidden, not emptied: the line keeps its row (min-height in CSS), so the
  // card does not jump when a status comes and goes.
  setShown($('timed-native-status'), false);
  setShown($('timed-native-play'), false);
  setShown($('timed-native-retry'), false);
}

async function loadNative(tok) {
  // Nothing but fillers (or nothing at all): there is no answer to rewrite.
  if (!sentences.some((s) => s.data && !s.data.filler)) {
    $('timed-native').hidden = true;
    return;
  }
  $('timed-native-status').textContent = TEXT.nativeWait;
  setShown($('timed-native-status'), true);
  setShown($('timed-native-retry'), false);
  let data = null;
  try {
    data = await postJSON(`/sessions/${tok.sessionId}/timed/rounds/${round}/native`);
  } catch {
    data = null;
  }
  if (!live(tok)) return;
  if (!data || !data.native) {
    $('timed-native-status').textContent = TEXT.nativeFailed;
    setShown($('timed-native-status'), true);
    $('timed-native-retry').disabled = false;
    setShown($('timed-native-retry'), true);
    return;
  }
  native = { native: data.native, audio_key: data.audio_key || null };
  setShown($('timed-native-status'), false);
  // A fresh span, for the same reason as a fixed line's.
  const text = document.createElement('span');
  text.textContent = data.native;
  $('timed-native-text').replaceChildren(text);
  if (state.language === 'ja') annotate([{ el: text, text: data.native }]);
  setShown($('timed-native-play'), true);
}

/* The native answer's 다시 시도, from the result. */
export async function retryNative() {
  if (stage !== 'result' || native) return;
  $('timed-native-retry').disabled = true;
  await loadNative(token());
}

/* ▶ 듣기: the server's clip, or the browser's voice when it made none. */
export function playNative() {
  if (!native) return;
  // ▶ 내 녹음 is this module's own Audio, which stopPlayback (inside play and
  // speakInBrowser) does not know about -- pause it so the two never overlap.
  if (mineClip) mineClip.pause();
  if (native.audio_key) play(native.audio_key, native.native);
  else speakInBrowser(native.native);
}

/* ---------- result ---------- */

function toResult(stats) {
  const current = { ...stats, fixed: fixedCount(sentences.map((s) => s.data)) };
  const compared = compareRounds(finished === 0 ? null : first, current);
  if (finished === 0) first = current;
  finished += 1;
  go('GRADED');
  const parts = [];
  compared.forEach((m, i) => {
    if (i) parts.push(document.createTextNode(' · '));
    const span = document.createElement('span');
    span.className = m.better ? 'timed-metric timed-better' : 'timed-metric';
    span.textContent = formatMetric(m, state.language);
    parts.push(span);
  });
  $('timed-numbers').replaceChildren(...parts);
  $('timed-progress').hidden = true;
  $('timed-numbers').hidden = false;
  $('timed-mine').disabled = !blob;
  $('timed-again').disabled = false;
  $('timed-end').disabled = false;
  setShown($('timed-actions'), true);
}

/* ▶ 내 녹음: the minute just recorded, from this page's own copy. */
export function playMine() {
  if (!blob) return;
  stopPlayback();
  if (mineClip) mineClip.pause();
  if (!blobUrl && typeof URL !== 'undefined' && URL.createObjectURL) blobUrl = URL.createObjectURL(blob);
  if (!blobUrl) return;
  mineClip = new Audio(blobUrl);
  mineClip.play().catch(() => notify('녹음을 재생할 수 없습니다.'));
}

/* 같은 주제로 다시 1분. */
export function again() {
  if (stage !== 'result' || ending) return;
  enterPrep();
}

/* 끝내기: the session's report, drawn by session.js's renderReport. */
export async function endTimed() {
  if (stage !== 'result' || ending || !ctx) return;
  ending = true;
  const tok = token();
  $('timed-again').disabled = true;
  $('timed-end').disabled = true;
  setShown($('timed-end-status'), true);
  stopPlayback();
  try {
    const data = await postJSON(`/sessions/${tok.sessionId}/end`);
    if (!live(tok)) return;
    leaveTimed();
    router.show('report');
    // Only a report opened from my page has a way back there.
    $('btn-report-back').hidden = true;
    renderReport(data);
    notify('');
  } catch (err) {
    if (!live(tok)) return;
    notify(`리포트 생성 실패: ${err.message}`);
    $('timed-again').disabled = false;
    $('timed-end').disabled = false;
  } finally {
    ending = false;
    setShown($('timed-end-status'), false);
  }
}

/* ---------- leaving ---------- */

function resetRound() {
  clearTicker();
  if (mic) {
    const m = mic;
    m.stopped = true;
    stopRecognition(m, { abort: true });
    if (m.recorder) {
      // Its last chunk has nowhere to go: this round is dropped, not uploaded.
      m.recorder.ondataavailable = null;
      if (m.recorder.state !== 'inactive') m.recorder.stop();
    }
    stopTracks(m);
  }
  mic = null;
  if (mineClip) mineClip.pause();
  mineClip = null;
  if (blobUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  blob = null;
  round = null;
  seconds = 0;
  sentences = [];
  native = null;
}

/* Home, my page, anything that takes the learner off this screen. A minute
   still recording is dropped (never uploaded); rounds already sent stay on the
   server. Safe to call when the screen was never open. */
export function leaveTimed() {
  if (stage === 'idle' && !mic) return;
  attempt += 1;
  stopPlayback();
  resetRound();
  stage = nextStage(stage, 'LEAVE');
}
