import { state, notify } from './api.js';
import { createUtterance } from './utterance.js';

export const BCP47 = { en: 'en-US', ja: 'ja-JP' };

/* ---------- audio out ---------- */

/* Guards an onDone callback against firing twice -- a clip can raise both
   'ended' and 'error' in some browsers, and play()'s fallback path also
   re-wires the same callback onto browser TTS. */
function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

/* Whatever is playing right now -- a server clip or the browser's voice --
   as the function that silences it. One slot: the app only ever means one
   sound at a time, and a second play() used to start on top of the first
   (two presses of 다시 듣기, a clip still talking over the next line or into
   the report, or into the microphone). */
let stopCurrent = null;

/* Silences what is playing. A stopped sound counts as finished: its onDone
   fires (once) here, so a turn waiting on AUDIO_DONE for it never sits in
   `speaking` with nothing left to play. */
export function stopPlayback() {
  const stop = stopCurrent;
  stopCurrent = null;
  if (stop) stop();
}

/* `onDone` is optional and, when given, fires once playback actually finishes
   (or immediately if nothing could be played at all, or when stopPlayback()
   cuts it off) -- session.js uses it to fire the AUDIO_DONE event that returns
   the turn state machine to `idle`. It is called with why it ended:
     'ended'    -- the server clip played to its end;
     'error'    -- the clip raised an error;
     'fallback' -- the clip could not play (or there was none) and the browser's
                   voice was used instead; fires when that voice is done;
     'stopped'  -- stopPlayback() (or the next play()) cut the clip off.
   Callers that only need "it is over" ignore the argument; the level test,
   which must know whether a sentence was really heard, reads it.
   `rate` slows the same clip down (shadowing's 천천히 듣기) rather than asking
   the server for a second, slower synthesis.
   Every play() first stops the one before it. */
export function play(audioKey, fallbackText, onDone, { rate = 1 } = {}) {
  stopPlayback();
  const done = onDone ? once(onDone) : null;
  if (audioKey) {
    notify(''); // a real server clip means any earlier quality warning no longer applies
    const clip = new Audio(`/api/audio/${audioKey}.wav`);
    clip.playbackRate = rate;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clip.pause();
      if (done) done('stopped');
    };
    stopCurrent = stop;
    if (done) {
      clip.addEventListener('ended', () => done('ended'));
      clip.addEventListener('error', () => done('error'));
    }
    clip.play().catch(() => {
      // pause() before the clip got going rejects play() too -- that is the
      // stop working, not a clip that failed, and must not start the voice.
      if (stopped) return;
      if (stopCurrent === stop) stopCurrent = null;
      speakInBrowser(fallbackText, done && (() => done('fallback')), rate);
    });
    return;
  }
  notify('서버 음성 생성에 실패해 브라우저 음성으로 대체합니다. 품질이 떨어집니다.');
  speakInBrowser(fallbackText, done && (() => done('fallback')), rate);
}

export function speakInBrowser(text, onDone, rate = 1) {
  if (!('speechSynthesis' in window)) {
    if (onDone) onDone();
    return;
  }
  const done = onDone ? once(onDone) : null;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = BCP47[state.language];
  u.rate = rate;
  if (done) {
    u.addEventListener('end', done);
    u.addEventListener('error', done);
  }
  stopCurrent = () => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (done) done();
  };
  speechSynthesis.speak(u);
}

/* ---------- speech in ---------- */

/* session.js injects these. Importing it here would close a cycle.

   Two handlers, not one: a recognised sentence normally becomes a turn, but
   during re-speak it must be compared against the correction instead and never
   reach the bot. Whoever set `respeakHandler` last owns the next result, and
   it is cleared after one use so a stray later result cannot be misrouted.

   `respeakHandler` itself is only armed once a session actually begins: a
   caller stages its handler in `pendingRespeakHandler`, and `onstart` -- which
   fires only when `recognition.start()` did not throw -- promotes it into
   `respeakHandler`, overwriting whatever was there before (null, for an
   ordinary listen). This is what protects the *next* recognition, not this
   one: if a re-speak's `start()` throws, `onstart` never runs and
   `respeakHandler` is never touched, so nothing leaks from that attempt. But
   if a re-speak session starts fine and then never reaches a terminal event
   (the tab gets suspended mid-recognition), `respeakHandler` stays armed with
   no delivery ever coming -- until the *next* recognition.start() succeeds,
   at which point this promotion step overwrites it (with the new pending
   value, or null for a plain listen), so a later ordinary sentence can no
   longer be swallowed by that stale handler. */
let heardHandler = null;
let respeakHandler = null;
let pendingRespeakHandler = null;
// Fix 4: streams the live transcript (finalised fragments + whatever is
// currently interim) while `listening` so session.js can show it in
// #mic-hint. Same shape as setHeardHandler -- one setter, one slot -- to
// match this file's convention.
let interimHandler = null;
// Set by cancelListening() and consumed by the onend it causes. A cancelled
// listen must not deliver: onend normally hands whatever was heard to the
// turn, and the whole point of cancelling is that it goes nowhere.
let cancelHandler = null;
let cancelling = false;

export function setHeardHandler(fn) { heardHandler = fn; }
export function setCancelHandler(fn) { cancelHandler = fn; }
export function setRespeakHandler(fn) { pendingRespeakHandler = fn; }
export function setInterimHandler(fn) { interimHandler = fn; }

function deliver(transcript, audioPromise) {
  const handler = respeakHandler || heardHandler;
  respeakHandler = null;
  if (handler) handler(transcript, audioPromise);
}

// Nothing sends on its own any more (see utterance.js) -- the learner ends a
// turn by pressing the mic again, and that is the ONLY normal way a
// recognition session stops. This is purely a safety net for the mic being
// left open by mistake (a backgrounded tab, a learner who walks away): 90s
// is far longer than any real utterance runs, so it can never cut one off,
// but it stops the microphone from staying live forever if nothing else
// ever calls recognition.stop().
const SAFETY_LIMIT_MS = 90000;

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    notify('이 브라우저는 음성 인식을 지원하지 않습니다. 아래 입력창에 직접 입력하세요.');
    return null;
  }
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  const utt = createUtterance();
  let safetyTimer = null;

  recognition.onstart = () => {
    utt.begin();
    // A new session has genuinely begun: whatever was staged for it (or
    // nothing, for a plain listen) is now the truth, and anything left over
    // from an earlier attempt that never delivered is discarded here.
    respeakHandler = pendingRespeakHandler;
    pendingRespeakHandler = null;
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => recognition.stop(), SAFETY_LIMIT_MS);
  };
  // continuous = true means e.results is every result seen in this session
  // so far, not just this event's -- e.resultIndex is where the results new
  // to *this* firing start. Reading e.results[0] (the old, continuous=false
  // code) or re-walking the whole list from 0 would both re-process results
  // already handed to utt and duplicate text.
  recognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i];
      if (r.isFinal) utt.final(r[0].transcript);
      else utt.interim(r[0].transcript);
    }
    if (interimHandler) interimHandler(utt.text());
  };
  // For not-allowed/audio-capture/service-not-allowed/network, Chrome fires
  // error and end with no start at all -- onstart's promotion never runs, so
  // a staged re-speak handler would otherwise sit armed with nothing to ever
  // deliver to it. Promote it here too, so onend's deliver(null) below still
  // reaches it and it renders its own "못 알아들었습니다" instead of leaving
  // the chip on "듣는 중..." forever. Only when something is actually staged:
  // if onstart already ran for this session (the ordinary error-after-start
  // case), pendingRespeakHandler is already null and this must not overwrite
  // the respeakHandler onstart already armed.
  recognition.onerror = (e) => {
    // A cycle that errors heard nothing, and it may never have reached
    // onstart -- Chrome fires error+end with no start for not-allowed,
    // audio-capture, service-not-allowed and network. onstart and onerror are
    // therefore the two entry points that between them guarantee the
    // utterance reads as empty before any onend can run; clearing it here
    // too (not just in onstart) covers exactly the paths that need it most
    // (a re-speak that fails this way right after a turn where speech WAS
    // recognised would otherwise inherit that turn's fragments -- onstart
    // never ran to call utt.begin() for THIS attempt -- and onend below
    // would deliver stale text instead of null, stranding the machine in
    // `respeaking` with the chip showing an answer that was never spoken
    // into it).
    utt.begin();
    if (pendingRespeakHandler) {
      respeakHandler = pendingRespeakHandler;
      pendingRespeakHandler = null;
    }
    // abort() raises `aborted` on its way to onend -- that is the cancel
    // working, not a failure to tell the learner about.
    // Shadowing has no input to fall back on (it is hidden there).
    if (!cancelling) {
      notify(state.shadowing
        ? `음성 인식 실패(${e.error}). 다시 해보세요.`
        : `음성 인식 실패(${e.error}). 입력창에 직접 입력하세요.`);
    }
  };
  // onend fires whether or not anything was recognised, and it is the only
  // event that always arrives -- so it is the one place delivery can safely
  // happen. utt.text() empty means the browser heard nothing -- not that the
  // turn was silent: Whisper transcribes from the recording independently,
  // and may still recover a turn Chrome's live recognition missed. A learner
  // pressing the mic again to stop is what gets here in the normal case --
  // recognition.stop() lets Chrome flush any last final result first, so it
  // is already in utt by the time this runs.
  recognition.onend = () => {
    // A short utterance can end before getUserMedia resolves; the bump makes
    // that late recorder close instead of recording into the next turn.
    recordingGeneration += 1;
    clearTimeout(safetyTimer);
    if (cancelling) {
      stopRecording();
      cancelling = false;
      utt.begin();
      respeakHandler = null;
      pendingRespeakHandler = null;
      if (cancelHandler) cancelHandler();
      return;
    }
    // The recording has not finished yet: MediaRecorder hands over its last
    // chunk asynchronously after stop(). Whisper needs that chunk, so the
    // turn gets a Promise of the finished file rather than a file.
    deliver(utt.text() || null, finishRecording());
  };
  return recognition;
}

export const recognition = setupRecognition();

/* Bumped by every cancel and every onend. getUserMedia is awaited, so the end
   of a listen can land before the recorder exists; without this the recorder
   would start afterwards and its audio would ride along with the learner's
   next turn. */
let recordingGeneration = 0;

export async function startRecording() {
  const generation = recordingGeneration;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== recordingGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    state.recorder = new MediaRecorder(stream);
    state.chunks = [];
    state.recorder.ondataavailable = (e) => state.chunks.push(e.data);
    state.recorder.start();
  } catch {
    state.recorder = null; // mic denied — text input still works
  }
}

/* Throws the current listen away: nothing heard is delivered and the
   recording is discarded, not uploaded. abort() rather than stop() -- stop()
   asks Chrome to flush a last final result, which is exactly what a cancel
   does not want. onend still fires, and is where the cancel is reported. */
export function cancelListening() {
  if (!recognition) return;
  cancelling = true;
  recordingGeneration += 1;
  discardRecording();
  recognition.abort();
}

/* Every recognition.start() goes through here. `cancelling` is otherwise only
   cleared by the onend a cancel causes, and abort() on a recognition Chrome
   had no live session for raises no onend at all -- the flag would then
   silence the next listen's errors and turn its onend into a cancel, dropping
   the learner's next sentence without a word. Clearing it here is safe: the
   mic and re-speak buttons cannot be pressed while a cancel is still pending,
   so no onend of a cancel can be left to arrive after this. */
export function beginListening() {
  cancelling = false;
  recognition.start();
}

export function discardRecording() {
  if (state.recorder) {
    // stop() fires one last dataavailable; detach first so it cannot refill
    // the chunks cleared below.
    state.recorder.ondataavailable = null;
    if (state.recorder.state !== 'inactive') state.recorder.stop();
  }
  state.chunks = [];
}

/* Stops the recorder and resolves with everything it recorded, including the
   chunk MediaRecorder delivers after stop(). Null when there is no recorder
   (microphone denied) or nothing was captured. state.chunks is left alone --
   uploadPendingRecording attaches the same audio to the message afterwards. */
export function finishRecording() {
  const recorder = state.recorder;
  const build = () => (state.chunks.length ? new Blob(state.chunks, { type: 'audio/webm' }) : null);
  if (!recorder) return Promise.resolve(null);
  if (recorder.state === 'inactive') return Promise.resolve(build());
  return new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve(build()), { once: true });
    recorder.stop();
  });
}

export function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}
