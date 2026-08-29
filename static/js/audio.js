import { state, notify } from './api.js';

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

/* `onDone` is optional and, when given, fires once playback actually finishes
   (or immediately if nothing could be played at all) -- session.js uses it to
   fire the AUDIO_DONE event that returns the turn state machine to `idle`. */
export function play(audioKey, fallbackText, onDone) {
  const done = onDone ? once(onDone) : null;
  if (audioKey) {
    notify(''); // a real server clip means any earlier quality warning no longer applies
    const clip = new Audio(`/api/audio/${audioKey}.wav`);
    if (done) {
      clip.addEventListener('ended', done);
      clip.addEventListener('error', done);
    }
    clip.play().catch(() => speakInBrowser(fallbackText, done));
    return;
  }
  notify('서버 음성 생성에 실패해 브라우저 음성으로 대체합니다. 품질이 떨어집니다.');
  speakInBrowser(fallbackText, done);
}

export function speakInBrowser(text, onDone) {
  if (!('speechSynthesis' in window)) {
    if (onDone) onDone();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = BCP47[state.language];
  if (onDone) {
    u.addEventListener('end', onDone);
    u.addEventListener('error', onDone);
  }
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

export function setHeardHandler(fn) { heardHandler = fn; }
export function setRespeakHandler(fn) { pendingRespeakHandler = fn; }

function deliver(transcript) {
  const handler = respeakHandler || heardHandler;
  respeakHandler = null;
  if (handler) handler(transcript);
}

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    notify('이 브라우저는 음성 인식을 지원하지 않습니다. 아래 입력창에 직접 입력하세요.');
    return null;
  }
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  let heard = false;
  recognition.onstart = () => {
    heard = false;
    // A new session has genuinely begun: whatever was staged for it (or
    // nothing, for a plain listen) is now the truth, and anything left over
    // from an earlier attempt that never delivered is discarded here.
    respeakHandler = pendingRespeakHandler;
    pendingRespeakHandler = null;
  };
  recognition.onresult = (e) => { heard = true; deliver(e.results[0][0].transcript); };
  recognition.onerror = (e) => notify(`음성 인식 실패(${e.error}). 입력창에 직접 입력하세요.`);
  // onend fires whether or not anything was recognised, and it is the only
  // event that always arrives -- so it is where the "heard nothing" path has
  // to live, or a failed recognition would strand the state machine in
  // `listening` with every control disabled.
  recognition.onend = () => {
    stopRecording();
    if (!heard) deliver(null);
  };
  return recognition;
}

export const recognition = setupRecognition();

export async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recorder = new MediaRecorder(stream);
    state.chunks = [];
    state.recorder.ondataavailable = (e) => state.chunks.push(e.data);
    state.recorder.start();
  } catch {
    state.recorder = null; // mic denied — text input still works
  }
}

export function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}
