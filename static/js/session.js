import { $, api, getJSON, postJSON, state, notify, setShown } from './api.js';
import { play, stopPlayback, setHeardHandler, recognition, BCP47, setRespeakHandler, setInterimHandler, setCancelHandler, cancelListening, beginListening, discardRecording, startRecording } from './audio.js';
import { matches } from './match.js';
import * as router from './router.js';
import * as turn from './turnstate.js';
import { annotate, attachMeaning, escapeHtml } from './reading.js';
import { setSuggestVisible } from './suggest.js';
// A leaf module (imports nothing): timed.js (the live screen) and this file
// (the report) both use it, so neither has to import the other -- session.js
// importing timed.js would be a cycle (timed.js already imports renderReport
// from here).
import { compareRounds, formatMetric } from './timedmath.js';

/* ---------- turn state ---------- */

let turnState = turn.INITIAL;

/* Set once a script's last line has been reached. The turn state machine has
   no notion of scripts, so `next` staying enabled after the script ends is
   not something `turnstate.js` can express -- this flag is the one place
   that knows, and `canDo`/`syncControls` are the only things that read it. */
let scriptExhausted = false;

/* Set once at load if this browser has no SpeechRecognition. turnstate.js has
   no notion of browser capability, so this is the one flag that knows --
   canDo('mic') is the only thing that reads it, the same way scriptExhausted
   is modelled for canDo('next'). Without this the mic button looks live on
   an unsupported browser and only explains itself once clicked. */
const micUnsupported = !recognition;

/* The live transcript while listening -- audio.js streams it in (finalised
   fragments + whatever is currently interim) via setInterimHandler below.
   Read only by syncControls, and reset wherever a fresh listen begins, or a
   stale value from the PREVIOUS utterance would flash in #mic-hint for the
   instant between pressing the mic and the first onresult of the new one. */
let liveHeard = '';

/* #mic-hint is two lines tall and never grows (spec R6). A long live
   transcript is cut from the FRONT -- the words just said are the ones the
   learner is checking, so they are the ones kept. CSS line-clamp alone would
   cut from the end and hide exactly those.

   The cap is in width units, not characters: a full-width glyph (CJK, kana,
   Hangul, full-width forms) is about two Latin letters wide at the hint's
   size, so a character cap that fits two lines of English ran a Japanese
   transcript to three lines on a phone -- and then line-clamp cut its end
   after all.

   The budget follows the hint's own width (hintUnits): a Latin letter averages
   about 0.55em, so two lines hold 2 * width / (0.55 * font size) units, less
   15% for word wrap leaving ragged line ends. A fixed 64 fitted a phone and
   cut a desktop dock at a third of a line. 64 stays as the fallback when there
   is no layout to measure (a hidden screen, or dom-shim). */
const HINT_FALLBACK_UNITS = 64;
// Hangul Jamo, CJK radicals through Yi (kana, CJK symbols, ideographs),
// Hangul syllables, compatibility ideographs and forms, full-width forms,
// and the supplementary ideograph planes.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const glyphUnits = (ch) => (WIDE.test(ch) ? 2 : 1);

export function hintUnits(hint) {
  const width = hint.clientWidth || 0;
  const fontPx = typeof getComputedStyle === 'function'
    ? parseFloat(getComputedStyle(hint).fontSize) : 0;
  if (!(width > 0) || !(fontPx > 0)) return HINT_FALLBACK_UNITS;
  return Math.floor(2 * width / (fontPx * 0.55) * 0.85);
}

export function clampHint(text, budget = HINT_FALLBACK_UNITS) {
  const glyphs = [...text];
  let units = 0;
  for (const ch of glyphs) units += glyphUnits(ch);
  if (units <= budget) return text;
  let start = glyphs.length;
  let kept = 0;
  while (start > 0 && kept + glyphUnits(glyphs[start - 1]) <= budget) {
    start -= 1;
    kept += glyphUnits(glyphs[start]);
  }
  return `…${glyphs.slice(start).join('').trimStart()}`;
}

/* The re-speak chip currently listening, if any -- `{ btn, resultEl }` or
   null. There can be several re-speak buttons on screen at once (one per
   correction the model has ever offered), and `recognition` is a single
   shared object, so only the button that started THIS re-speak session may
   stop it, and the live interim transcript below has to be routed to THIS
   chip's own result line, not some other chip's. Cleared -- and the button's
   label restored -- the instant a re-speak resolves, on every path
   (`setRespeakHandler`'s callback, both branches, and `startRespeak`'s own
   `catch`), or a failed or finished re-speak would leave a button stuck
   reading as the stop control for a session that no longer exists. */
let activeRespeak = null;
const RESPEAK_LABEL = '🎤 고쳐서 다시 말해보기';
const RESPEAK_STOP_LABEL = '🎤 그만 말하기';

/* The re-speak chip (`{ btn, resultEl }`) whose recording Whisper is
   transcribing, or null. The turn stays in `respeaking` (its controls are
   already locked), so this is what tells cancelTurn and the hint that the
   recognition session is over and a result is pending. `activeRespeak` is
   already cleared by then -- the button must stop reading as a stop control
   -- so this keeps the chip reachable for a cancel to hide its result line. */
let transcribingRespeak = null;

function clearActiveRespeak() {
  // The button's own label, not the chip's: my page's 🎤 말해보기 runs the
  // same re-speak and must not come back reading 고쳐서 다시 말해보기.
  if (activeRespeak && activeRespeak.btn) activeRespeak.btn.textContent = activeRespeak.label || RESPEAK_LABEL;
  activeRespeak = null;
}

/* A result line is either the chip's (comes and goes with `hidden`) or one
   that holds its row while empty (`data-hold`, my page's review card, spec
   R5), which comes and goes by class. */
function showRespeakResult(el, on) {
  if (el.dataset.hold) setShown(el, on);
  else el.hidden = !on;
}

/* The one place that knows what is in flight. Callers ask it rather than
   keeping their own copy -- two sources of truth about "is a turn running"
   is exactly the bug the old re-entrancy flag produced. */
export function canDo(control) {
  const c = turn.controls(turnState);
  if (control === 'next') return c.next && !scriptExhausted;
  if (control === 'mic') return c.mic && !micUnsupported;
  return c[control];
}

/* Applies the current turn state (and `scriptExhausted`) to the DOM. The only
   function that writes `disabled` on these buttons -- nothing else may, or
   two places could disagree about what's enabled. */
function syncControls() {
  // Live while listening too -- pressing the mic again is what ends a turn
  // now, so the button must not go dead the moment a recognition session
  // starts. Checked against `listening` directly, not canDo('stop'): `stop`
  // is also true during `respeaking`, handled by the `activeRespeak` check
  // below.
  //
  // A re-speak in progress pulses the big mic exactly like an ordinary
  // listen (the `listening` class below is shared by both), so it must be
  // just as pressable -- a button that visibly pulses but does nothing when
  // pressed is the bug this replaced. Only one re-speak can ever be active
  // at a time (startRespeak's own `activeRespeak.btn === btn` guard), so
  // there is no ambiguity about whose session the big mic would be ending;
  // main.js's mic handler already calls recognition.stop() whenever
  // canDo('stop') is true, which ends this chip's session the same way its
  // own `그만 말하기` button would. `activeRespeak` (not `turnState ===
  // 'respeaking'` alone) is what gates this: once its recognition ends and
  // Whisper starts transcribing, `activeRespeak` is cleared but `turnState`
  // stays `respeaking` until the result comes back -- the big mic must go
  // dead again there, the same as at `transcribing` for an ordinary turn,
  // since there is nothing left for it to stop.
  $('btn-mic').disabled = !(canDo('mic') || turnState === 'listening' || activeRespeak);
  $('btn-send').disabled = !canDo('send');
  $('btn-next').disabled = !canDo('next');
  $('btn-end').disabled = !canDo('end');
  const listening = turnState === 'listening' || turnState === 'respeaking';
  $('btn-mic').classList.toggle('listening', listening);
  // The mic's glyph is a CSS ::after pseudo-element, not a DOM child, so it
  // cannot carry status text itself -- this hint line is what actually tells
  // the learner what's happening (carried from Task 4/5's ruling). While
  // listening, showing the live transcript as it's recognised is what lets a
  // learner actually notice a cut-off before it's sent, instead of only
  // finding out after. The non-listening text matches index.html's initial
  // markup so returning to idle doesn't visibly change the wording.
  const hint = $('mic-hint');
  hint.textContent = listening
    ? (transcribingRespeak ? '받아쓰는 중...' : (clampHint(liveHeard, hintUnits(hint)) || '듣고 있습니다...'))
    : turnState === 'transcribing'
      ? '받아쓰는 중...'
      : '누르고 말한 뒤, 다 말하면 다시 눌러서 전송하세요';
  // Both keep their place while hidden (spec R5), so neither the
  // conversation column nor the dock changes height as a turn runs.
  setShown($('thinking'), turnState === 'sending');
  setShown($('btn-cancel'), canDo('cancel'));
}

export function setTurnState(event) {
  const wasListening = turnState === 'listening' || turnState === 'respeaking';
  turnState = turn.next(turnState, event);
  const isListening = turnState === 'listening' || turnState === 'respeaking';
  // A fresh listen must not open on the previous utterance's leftover text --
  // audio.js's onstart clears its own utterance object the same way, for the
  // same reason.
  if (isListening && !wasListening) liveHeard = '';
  syncControls();
  if (state.shadowing) shadowHooks.turn(turnState);
  return turnState;
}

/* Shadowing (shadow.js) owns its own line card; session.js only hands it the
   session's lines, each final transcript, and each turn state. Injected, like
   audio.js's handlers, so neither module imports the other. */
let shadowHooks = { start() {}, heard() {}, turn() {} };
export function setShadowHooks(hooks) {
  shadowHooks = { ...shadowHooks, ...hooks };
}

/* Whisper's answer beats the browser's, but never blocks the turn: on any
   failure, after 8s, or when Whisper hears silence, the browser's transcript
   is used. No recording (microphone denied) means Whisper is not asked. */
let transcribeTimeoutMs = 8000;

/* Tests only: waiting 8s for a timeout is not a test anyone runs. */
export function setTranscribeTimeout(ms) {
  transcribeTimeoutMs = ms;
}

export async function finalTranscript(browserText, audioPromise) {
  let audio;
  try {
    // A recording that failed to finish is the same as no recording.
    audio = audioPromise ? await audioPromise : null;
  } catch {
    audio = null;
  }
  if (!audio) return browserText || null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transcribeTimeoutMs);
  try {
    const form = new FormData();
    form.append('language', state.language);
    form.append('file', audio, 'clip.webm');
    const res = await api('/transcribe', { method: 'POST', body: form, signal: controller.signal });
    const { text } = await res.json();
    return (text && text.trim()) || browserText || null;
  } catch {
    return browserText || null;
  } finally {
    clearTimeout(timer);
  }
}

/* Bumped when a transcription starts and when one is cancelled, so a result
   that arrives after a cancel is recognised as stale and dropped. */
let transcribeGeneration = 0;

export async function handleHeard(browserText, audioPromise) {
  setTurnState('HEARD_AUDIO');
  const generation = ++transcribeGeneration;
  const transcript = await finalTranscript(browserText, audioPromise);
  if (generation !== transcribeGeneration || turnState !== 'transcribing') return;
  sendHeard(transcript);
}

/* A recognised sentence becomes a turn automatically. Hearing nothing just
   returns control to the learner. Re-speak (Task 8) takes priority over this
   handler via audio.js's `deliver` and never reaches it. */
function sendHeard(transcript) {
  // Shadowing judges a line on the server and keeps the attempt in its own
  // card; it never posts a turn. `sending` holds the mic while it saves.
  if (state.shadowing) {
    if (!transcript) {
      discardRecording();
      setTurnState('HEARD_NOTHING');
      shadowHooks.heard(null);
      return;
    }
    setTurnState('HEARD');
    shadowHooks.heard(transcript);
    return;
  }
  if (!transcript) {
    // Nothing to attach the recording to, and chunks left behind would be
    // uploaded with whatever the learner types next.
    discardRecording();
    setTurnState('HEARD_NOTHING');
    return;
  }
  // Script mode owns its own turn cycle: nextScriptLine is the only thing
  // that advances scriptIndex and suppresses the LLM's reply, so a spoken
  // line must go through it rather than through sendText. Routing the mic
  // straight to sendText would post to /chat and speak an off-script LLM
  // reply over a script panel that never advances.
  if (state.mode === 'script') {
    $('text-input').value = transcript;
    setTurnState('HEARD_NOTHING'); // release the turn; nextScriptLine runs its own cycle
    nextScriptLine();
    return;
  }
  setTurnState('HEARD');
  sendText(transcript);
}
setHeardHandler(handleHeard);

/* Cancel: the learner changed their mind mid-utterance. Everything heard is
   dropped (audio.js discards the recording and does not deliver) and the turn
   goes straight back to idle. A cancelled re-speak clears its chip's result
   line rather than claiming it heard nothing -- nothing was attempted. */
export function cancelTurn() {
  if (!canDo('cancel')) return;
  // The recognition session is already over while Whisper works, so abort()
  // would raise no onend and nothing would report the cancel. Invalidate the
  // pending result and report it here instead.
  if (turnState === 'transcribing' || transcribingRespeak) {
    dropPendingTranscript();
    return;
  }
  cancelListening();
}

/* Invalidates a transcription in flight -- its result will be recognised as
   stale -- throws its recording away and returns the turn to idle. */
function dropPendingTranscript() {
  transcribeGeneration += 1;
  discardRecording();
  handleCancelled();
}

/* Esc cancels a live listen, except where Esc already means something else.
   The settings dialog can be opened mid-listen, and its Esc closes it -- taken
   here (main.js calls preventDefault), the dialog stays open and the
   recording is what disappears. During IME composition Esc backs out of the
   conversion, which a learner typing Japanese does constantly. */
export function escapeCancels(e) {
  if (e.key !== 'Escape' || e.isComposing) return false;
  if ($('settings').open) return false;
  return canDo('cancel');
}

export function handleCancelled() {
  const respeak = activeRespeak || transcribingRespeak;
  clearActiveRespeak();
  transcribingRespeak = null;
  if (respeak) {
    respeak.resultEl.textContent = '';
    showRespeakResult(respeak.resultEl, false);
  }
  // The caller learns the attempt is over without a verdict (my page wakes
  // the card it put to sleep for the listen).
  if (respeak && respeak.onCancel) respeak.onCancel();
  liveHeard = '';
  setTurnState('CANCEL');
}
setCancelHandler(handleCancelled);
// Streams the live transcript into #mic-hint via syncControls -- see
// `liveHeard`'s own comment for why it's reset separately, in setTurnState.
// While a re-speak is the one listening, the same text also goes to its own
// result line -- '듣는 중...' with nothing else until delivery was too little
// feedback to tell the recognition was even working with an open-ended
// listen. The good/bad rendering in startRespeak's handler overwrites this
// the moment a result actually arrives.
setInterimHandler((text) => {
  liveHeard = text;
  if (activeRespeak) activeRespeak.resultEl.textContent = text || '듣는 중...';
  syncControls();
});

/* ---------- status ---------- */

/* One plain-language line for whichever services are down, replacing the old
   status dots (the learner had no way to know what a red dot meant). Nothing
   down -> the bar stays [hidden] and empty, faded out by
   .health-notice[hidden] (components.css). Several down -> one line, parts
   joined with " · " so it stays the single compact element the layout rule
   calls for, instead of stacking separate notices that would each take their
   own space. */
export async function refreshHealth() {
  const bar = $('health-notice');
  try {
    const h = await getJSON('/health');
    const parts = [];
    if (!h.ollama) parts.push('AI가 꺼져 있어요 — 대화·교정·리포트가 안 돼요');
    if (!h.voicevox) parts.push('일본어 음성이 꺼져 있어요 — 일본어 문장을 들을 수 없어요');
    if (h.whisper === 'unavailable') parts.push('받아쓰기가 꺼져 있어요 — 브라우저 인식으로 대신해요');
    bar.textContent = parts.join(' · ');
    bar.hidden = parts.length === 0;
  } catch {
    notify('서버에 연결할 수 없습니다.');
  }
}

/* ---------- session ---------- */

/* `language` and `mode` are parameters, not reads of `state`, on purpose: the
   caller resolved a scenario id under a particular language and mode, possibly
   several seconds ago, and the session must be created under the same pair the
   id belongs to. Reading `state` here instead is exactly how a session came to
   be stamped with one language and bound to another language's scenario. */
export async function startSession({ language, mode, scenarioId, topic, shadowing = false } = {}) {
  // startScript resets this for a script session; a free session never went
  // through startScript before, so without this a free session started right
  // after a finished script session would inherit the earlier session's
  // exhausted flag. Harmless today only because btn-next stays hidden in free
  // mode -- cleared here so the invariant holds for every session, not just
  // script ones.
  scriptExhausted = false;
  const payload = {
    language,
    mode,
    scenario_id: mode === 'lesson' ? null : scenarioId,
    topic: topic || null,
    shadowing,
  };
  $('btn-start').disabled = true;
  try {
    const data = await postJSON('/sessions', payload);
    state.sessionId = data.session_id;
    // The session that was actually created is now the one the app is in, so
    // its language and mode become the app's -- exactly what resumeSession
    // does with resumeTarget.mode. In the normal case these are already equal;
    // they differ only when the learner switched during the generation wait,
    // and then every later read (handleHeard's script routing, the mic's
    // BCP47 language, re-speak matching) must follow the session that exists
    // rather than the button that was pressed after it was requested.
    state.language = payload.language;
    state.mode = payload.mode;
    setSuggestVisible(payload.mode);
    router.show('session');
    $('conversation').innerHTML = '';
    notify('');
    // What the server made, not what was asked: shadowing is a script session
    // with a flag, and the flag decides whose card the lines go to.
    state.shadowing = Boolean(data.shadowing);
    $('shadow-card').hidden = !state.shadowing;
    // Shadowing is spoken or nothing -- a typed line has no sound to judge.
    $('text-input').hidden = state.shadowing;

    if (state.shadowing) {
      // The card's own 다음 줄 moves on, and there is no turn to send.
      $('btn-next').hidden = true;
      $('btn-send').hidden = true;
      shadowHooks.start(data.lines);
    } else if (data.mode === 'script') startScript(data.lines);
    else {
      // The scenario's goal (free mode) or the topic the learner typed
      // (lesson mode) is what the panel shows. Lesson mode with no topic has
      // nothing to show -- hide the panel rather than leave a labelled void,
      // which is what a free-standing "목표" heading over nothing read as.
      const goal = data.goal || payload.topic || '';
      $('panel-title').textContent = '목표';
      $('panel-body').textContent = goal;
      $('side-panel').hidden = !goal;
      $('btn-next').hidden = true;
      $('btn-send').hidden = false;
      addMessage('bot', data.opening, data.opening_audio);
      play(data.opening_audio, data.opening);
    }
  } catch (err) {
    notify(`세션을 시작하지 못했어요: ${err.message}`);
  } finally {
    $('btn-start').disabled = false;
  }
}

/* ---------- conversation ---------- */

export function addMessage(who, text, audioKey = null) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  if (audioKey) div.dataset.audioKey = audioKey;
  $('conversation').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  // 자유·수업 모드의 봇 문장도 학습자가 못 읽는 것은 대본과 똑같다.
  // 이어서 하기 재생도 이 함수를 그대로 쓰므로 그 경로가 함께 덮인다.
  if (who === 'bot' && state.language === 'ja') {
    annotate([{ el: div, text }]);
  }
  // 영어 봇 문장도 뜻이 막히면 대화가 멈춘다. 읽기 보조는 없으니 뜻 버튼만.
  if (who === 'bot' && state.language === 'en') {
    attachMeaning(div, 'en', text);
  }
  return div;
}

/* One line under the learner's bubble, expanding in place.

   The prose the model returns is two Korean sentences per field, and it comes
   back on every single turn -- rendered in full it buries the conversation
   within two exchanges. Collapsed, a correct turn reads as praise rather than
   as the model's boilerplate "고칠 부분이 없습니다". */
export function addChip(bubble, fb) {
  if (fb.ok === null || fb.ok === undefined) return; // no feedback for this turn
  const wrap = document.createElement('div');
  wrap.className = 'chip-row';

  const summary = document.createElement('button');
  summary.className = `chip ${fb.ok ? 'ok' : 'fix'}`;
  summary.textContent = fb.ok ? '✓ 문장 정확' : `고칠 곳 · ${fb.tag || '문법'}`;

  // Collapsed by class, not `hidden` (spec R8): the grid row eases from 0fr
  // to 1fr, and the inner wrapper's overflow: hidden is what lets the row
  // actually shrink to nothing.
  const detail = document.createElement('div');
  detail.className = 'chip-detail is-collapsed';
  const inner = document.createElement('div');
  inner.className = 'chip-detail-inner';
  detail.appendChild(inner);
  summary.setAttribute('aria-expanded', 'false');
  if (fb.correction) inner.appendChild(block('교정', fb.correction, 'corr'));
  if (fb.suggestion) inner.appendChild(block('이렇게도', fb.suggestion, 'sug'));

  if (!fb.ok && fb.fixed) {
    const row = document.createElement('div');
    row.className = 'respeak-row';
    const btn = document.createElement('button');
    btn.className = 'respeak';
    btn.textContent = RESPEAK_LABEL;
    const target = document.createElement('div');
    target.className = 'respeak-target';
    target.textContent = fb.fixed;
    const result = document.createElement('p');
    result.className = 'respeak-result';
    result.hidden = true;
    btn.addEventListener('click', () => startRespeak(fb.fixed, result, btn));
    row.append(target, btn, result);
    inner.appendChild(row);
  }

  summary.addEventListener('click', () => {
    const expanded = detail.classList.toggle('is-collapsed') === false;
    summary.setAttribute('aria-expanded', String(expanded));
  });

  wrap.append(summary, detail);
  bubble.after(wrap);
  return wrap;
}

const RESPEAK_BUSY = '봇이 말하는 동안에는 다시 말할 수 없습니다. 끝날 때까지 기다려주세요.';

/* Re-speaking is deliberately a different state from a normal turn: the
   recognised text is compared against `target` and never sent to the bot.

   `respeak` is only allowed from `idle` (turnstate.js) -- a turn already in
   flight, the bot still speaking, or another re-speak already listening all
   say no here, silently, the same way sendTurn/undoLastTurn guard themselves.
   The chip's re-speak buttons are not wired into syncControls (they belong to
   whichever turn produced them, not to "the current turn"), so this guard is
   the only thing standing between a stray click and two recognitions
   overlapping.

   `onResult` is optional: once the attempt is judged it gets (true|false,
   spoken), and (null, null) when nothing was heard. A cancel or a start that
   throws never calls it -- nothing was attempted. The chip passes none.

   `onCancel` is called when a started attempt ends without a verdict (a
   cancel). The return value says whether an attempt started: false when it
   was refused, stopped an attempt already running, or failed to start -- in
   none of those will onResult or onCancel be called for this call.

   `busy` is what to say when a turn is already running. The chip's own words
   are about the bot speaking, which is the only way a chip can be refused;
   my page can be reached mid-turn, where that is not what is happening. */
export function startRespeak(target, resultEl, btn, onResult = null, { busy = RESPEAK_BUSY, onCancel = null } = {}) {
  // Mirrors main.js's mic handler: this button owns the active re-speak, so
  // a second click on it ends the session instead of trying to start a new
  // one. recognition.stop() lets Chrome flush a last final result, then
  // fires onend, which delivers through the setRespeakHandler callback below
  // -- not here. No setTurnState call on this path: HEARD/HEARD_NOTHING stay
  // raised from exactly one place. Any OTHER chip's button, clicked while
  // this one is active, falls through to the canDo('respeak') guard below
  // and is refused the same way it always was.
  if (activeRespeak && activeRespeak.btn === btn) {
    recognition.stop();
    return false;
  }
  // Whisper is already working on what this same chip's recognition heard --
  // there is nothing left to stop, and canDo('respeak') is false here (the
  // machine is in `respeaking`, not `idle`), so without this the same click
  // would fall through to the "bot is speaking" notice below, which is not
  // what is happening at all.
  if (transcribingRespeak && transcribingRespeak.btn === btn) return false;
  if (!canDo('respeak')) {
    notify(busy);
    return false;
  }
  if (!recognition) { notify('이 브라우저는 음성 인식을 지원하지 않습니다.'); return false; }
  setTurnState('RESPEAK');
  activeRespeak = { btn, resultEl, onCancel, label: btn ? btn.textContent : RESPEAK_LABEL };
  // setTurnState above already ran syncControls, but before `activeRespeak`
  // existed -- syncControls reads it to decide whether the big mic may end
  // this re-speak (see its own comment), so without a second call here the
  // button would stay disabled from the moment the chip is pressed until
  // something else happens to call syncControls again (the first interim
  // result, in practice) -- dead through exactly the window where a learner
  // who wants to stop immediately, or during silence, would press it.
  syncControls();
  if (btn) btn.textContent = RESPEAK_STOP_LABEL;
  showRespeakResult(resultEl, true);
  // Classes, not className: a caller's own class (review-result) stays on.
  resultEl.classList.remove('good', 'bad');
  resultEl.classList.add('respeak-result');
  resultEl.textContent = '듣는 중...';

  setRespeakHandler(async (browserSpoken, audioPromise) => {
    // Stay in `respeaking` while Whisper works -- every control but cancel is
    // already locked there. The chip says what is happening.
    // The button stops reading as the stop control now -- there is nothing
    // left to stop.
    transcribingRespeak = { btn, resultEl, onCancel };
    clearActiveRespeak();
    resultEl.textContent = '받아쓰는 중...';
    syncControls();
    const generation = ++transcribeGeneration;
    const spoken = await finalTranscript(browserSpoken, audioPromise);
    if (generation !== transcribeGeneration) return; // cancelled meanwhile
    transcribingRespeak = null;
    // A re-speak's audio is never uploaded for ▶ 내 발음; left in
    // state.chunks it would ride along with the next typed turn.
    discardRecording();
    if (spoken === null) {
      setTurnState('HEARD_NOTHING');
      resultEl.textContent = '못 알아들었습니다. 다시 해보세요.';
      if (onResult) onResult(null, null);
      return;
    }
    setTurnState('HEARD');
    const good = matches(spoken, target, state.language);
    resultEl.classList.add(good ? 'good' : 'bad');
    resultEl.textContent = good ? `좋습니다 — "${spoken}"` : `"${spoken}" — 조금 다릅니다. 다시 해보세요.`;
    if (onResult) onResult(good, spoken);
  });
  recognition.lang = BCP47[state.language];
  // Mirrors main.js's mic handler. Without its own recording, the re-speak's
  // onend would hand Whisper whatever the previous listen left behind.
  const recording = startRecording();
  try {
    beginListening();
  } catch (err) {
    // Mirrors main.js's mic handler: onend never fires when start() itself
    // throws, so nothing else would return the machine from `respeaking`.
    // The handler just staged above never gets promoted (onstart never runs
    // for a start() that threw) -- clear the stage itself too, or it would
    // wrongly promote into the *next* recognition that does start. Clearing
    // activeRespeak here too, or a start() that throws would leave this
    // button reading as the stop control for a session that never began.
    clearActiveRespeak();
    setRespeakHandler(null);
    recording.then(discardRecording); // see main.js: the recorder may not exist yet
    notify(`음성 인식을 시작하지 못했습니다: ${err.message}`);
    resultEl.textContent = '음성 인식을 시작하지 못했습니다. 다시 눌러보세요.';
    setTurnState('HEARD_NOTHING');
    return false;
  }
  return true;
}

function block(label, text, kind) {
  const el = document.createElement('div');
  el.className = `chip-block ${kind}`;
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  el.append(labelEl, document.createTextNode(' '), document.createTextNode(text));
  return el;
}

export async function sendText(text) {
  $('text-input').value = '';
  const bubble = addMessage('user', text);

  // Scoped to the request alone: nothing below this point may throw (see the
  // comments on each call), so a throw here can only mean the turn never
  // reached the server. `.undoable` is applied only past this point too --
  // marking it earlier would leave a bubble that represents no real server
  // turn wired up to delete the previous, real one.
  let data;
  try {
    data = await postJSON('/chat', { session_id: state.sessionId, text });
  } catch (err) {
    bubble.remove();
    $('text-input').value = text;
    notify(`전송 실패: ${err.message}`);
    state.chunks = []; // a failed turn has no message to attach a recording to
    setTurnState('SEND_FAILED');
    return;
  }

  // Only the most recent learner bubble is undoable -- deleting a middle turn
  // would leave the conversation after it referring to something gone. Only
  // touched now that the turn is confirmed real.
  const prev = $('conversation').querySelector('.msg.user.undoable');
  if (prev) { prev.classList.remove('undoable'); prev.removeAttribute('title'); }
  bubble.classList.add('undoable');
  bubble.title = '잘못 인식됐다면 눌러서 고치세요';
  bubble.dataset.turnText = text;

  // A clip still playing from before (the learner typed over the last reply)
  // is cut off now, while the turn is still `sending`: the AUDIO_DONE its
  // stop raises lands where it changes nothing. Left to the play() below, it
  // would land after REPLY and end this reply's `speaking` at once.
  stopPlayback();
  setTurnState('REPLY');
  addMessage('bot', data.bot_reply, data.audio_key);
  addChip(bubble, data);
  // AUDIO_DONE returns the turn to `idle` once the bot's clip actually
  // finishes -- until then `speaking` still permits starting a new turn
  // (barge-in) but blocks undo/next/respeak (see turnstate.js).
  play(data.audio_key, data.bot_reply, () => setTurnState('AUDIO_DONE'));
  await uploadPendingRecording(bubble); // clears state.chunks itself on this path
}

export async function sendTurn() {
  if (!canDo('send')) return;
  const text = $('text-input').value.trim();
  if (!text || !state.sessionId) return;
  setTurnState('SEND');
  await sendText(text);
}

/* ---------- undo ---------- */

export async function undoLastTurn(bubble) {
  if (!canDo('undo')) return;
  setTurnState('UNDO');
  try {
    await api(`/sessions/${state.sessionId}/last-turn`, { method: 'DELETE' });
    // Drop the learner bubble, its chip, and the bot reply that followed.
    let node = bubble.nextSibling;
    while (node) { const gone = node; node = node.nextSibling; gone.remove(); }
    const text = bubble.dataset.turnText;
    bubble.remove();
    // The learner almost always wants to fix and re-say the same sentence.
    $('text-input').value = text || '';
    $('text-input').focus();
  } catch (err) {
    notify(`되돌리지 못했습니다: ${err.message}`);
  } finally {
    setTurnState('UNDO_DONE');
  }
}

/* ---------- script mode ---------- */

function startScript(lines) {
  state.scriptLines = lines;
  state.scriptIndex = 0;
  scriptExhausted = false;
  $('btn-next').hidden = false;
  $('btn-send').hidden = true;
  // A prior free/lesson session with no goal or topic hides the panel (see
  // startSession) -- a script always has content, so restore it here.
  $('side-panel').hidden = false;
  $('panel-title').textContent = '대본';
  // l.text can now come from a local LLM (POST /scenarios/generate), not just
  // this codebase's own built-in scenarios -- escaped the same way
  // renderTokens (reading.js) escapes every token it draws into innerHTML.
  $('panel-body').innerHTML = `<ol>${lines
    .map((l, i) => `<li data-i="${i}"><b>${l.speaker === 'bot' ? '봇' : '나'}</b> `
      + `<span class="line">${escapeHtml(l.text)}</span></li>`)
    .join('')}</ol>`;
  const items = [...$('panel-body').querySelectorAll('li .line')];
  if (state.language === 'ja') {
    annotate(items.map((el, i) => ({ el, text: lines[i].text })));
  } else {
    items.forEach((el, i) => attachMeaning(el, state.language, lines[i].text));
  }
  advanceScript();
}

function advanceScript() {
  const items = [...$('panel-body').querySelectorAll('li')];
  items.forEach((li, i) => {
    li.classList.toggle('current', i === state.scriptIndex);
    li.classList.toggle('done', i < state.scriptIndex);
  });
  const line = state.scriptLines[state.scriptIndex];
  if (!line) {
    notify('대본이 끝났습니다. 세션을 끝내면 리포트를 받을 수 있습니다.');
    // `turnstate.js` has no notion of scripts, so this is the one flag that
    // knows -- `syncControls` (the only writer of `disabled`) reads it too,
    // so a later unrelated setTurnState call can't accidentally re-enable
    // `next` for a script that has already ended.
    scriptExhausted = true;
    syncControls();
    return;
  }
  if (line.speaker === 'bot') {
    // The bubble is drawn here, at the same instant the audio plays -- not a
    // beat later when the learner presses next (nextScriptLine used to draw
    // it there, one action behind what they'd already heard). What just
    // played is what the chat log shows right now.
    addMessage('bot', line.text, line.audio_key);
    play(line.audio_key, line.text);
    storeScriptLine(state.scriptIndex);
  }
}

/* Records the bot line just drawn, keyed by its own index in the script.
   Fire-and-forget, same contract as reading.js's annotate(): the bubble is
   already on screen, which is the part that matters to the learner right
   now, and a storage hiccup must not interrupt practice. Storing every line
   up front instead (at session start) was considered and rejected -- that
   would put lines the learner has not reached yet into the record, and
   resuming would show them the future. */
function storeScriptLine(index) {
  postJSON(`/sessions/${state.sessionId}/script-line`, { index }).catch(() => {});
}

/* One line under the learner's bubble in script mode: did they say the
   script's own line, not a grammar judgement -- they read it, they did not
   compose it, so there is nothing for a correction chip to fix. Deliberately
   not addChip, which renders ok/tag/correction/suggestion that a script turn
   never has. Reuses re-speak's .respeak-result good/bad styling (Task 8)
   rather than inventing a third look for the same "did you say this" idea. */
function renderScriptAccuracy(bubble, spoken, target) {
  const good = matches(spoken, target, state.language);
  const p = document.createElement('p');
  p.className = `respeak-result ${good ? 'good' : 'bad'}`;
  p.textContent = good
    ? '좋습니다 — 대본대로 잘 읽었습니다.'
    : `대본과 다릅니다 — 대본: "${target}"`;
  bubble.after(p);
  return p;
}

export async function nextScriptLine() {
  const line = state.scriptLines[state.scriptIndex];
  if (line && line.speaker === 'user') {
    // Gated on 'next', not 'send': 'next' is what the button that calls this
    // is gated on (via canDo in main.js and syncControls), and 'send' answers
    // a different question -- it is true in `speaking`, where `next` is not.
    // Two different answers to "may this run" is exactly what the turn state
    // machine exists to prevent.
    if (!canDo('next')) return;
    setTurnState('SEND');
    const spoken = $('text-input').value.trim() || line.text;
    $('text-input').value = '';
    const bubble = addMessage('user', spoken);

    // Scoped to the request alone -- see sendText for why. /script-turn, not
    // /chat: the bot's next line already exists in the script and the
    // learner read theirs rather than composing it, so there is no reply to
    // invent and nothing to grade.
    try {
      await postJSON('/script-turn', { session_id: state.sessionId, text: spoken });
    } catch (err) {
      bubble.remove();
      $('text-input').value = spoken;
      notify(`저장 실패: ${err.message}`);
      state.chunks = []; // a failed turn has no message to attach a recording to
      setTurnState('SEND_FAILED');
      advanceScript();
      return;
    }

    setTurnState('REPLY');
    renderScriptAccuracy(bubble, spoken, line.text);
    await uploadPendingRecording(bubble); // clears state.chunks itself on this path
    state.scriptIndex += 1; // only advance past a turn that was actually recorded
    // Unlike sendText, nothing from /script-turn is played as audio -- the
    // script's own pre-recorded line audio plays via advanceScript() below,
    // uncoupled from turn state. So there is no clip to wait on: return to
    // idle immediately or `next`/`undo` would stay disabled.
    setTurnState('AUDIO_DONE');
  } else if (line) {
    // The bubble for this line was already drawn by advanceScript() the
    // moment it became current -- only the index moves here now.
    state.scriptIndex += 1;
  }
  advanceScript();
}

/* The learner's own recording, next to the bot's native-speaker clip. Hearing
   the two back to back is what makes pronunciation differences audible.
   Phase 1 stored these and never played them. */
function addPlayButton(bubble, messageId) {
  const btn = document.createElement('button');
  btn.className = 'play-mine';
  btn.textContent = '▶ 내 발음';
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // the bubble itself is the undo target
    new Audio(`/api/messages/${messageId}/audio`).play()
      .catch(() => notify('녹음을 재생할 수 없습니다.'));
  });
  bubble.appendChild(btn);
}

/* The learner's recording for one known message -- shadowing knows its row id,
   and a retried line keeps it, so "the last user message" would be wrong. */
export async function uploadRecordingFor(messageId, sessionId = state.sessionId) {
  if (!state.chunks.length) return false;
  const blob = new Blob(state.chunks, { type: 'audio/webm' });
  state.chunks = [];
  try {
    const form = new FormData();
    form.append('message_id', messageId);
    form.append('file', blob, 'clip.webm');
    await api(`/sessions/${sessionId}/audio`, { method: 'POST', body: form });
    return true;
  } catch {
    return false;   // a recording never interrupts practice
  }
}

export async function uploadPendingRecording(bubble) {
  if (!state.chunks.length) return;
  const blob = new Blob(state.chunks, { type: 'audio/webm' });
  state.chunks = [];
  try {
    const { messages } = await getJSON(`/sessions/${state.sessionId}`);
    const lastUser = [...messages].reverse().find((m) => m.speaker === 'user');
    if (!lastUser) return;
    const form = new FormData();
    form.append('message_id', lastUser.id);
    form.append('file', blob, 'clip.webm');
    await api(`/sessions/${state.sessionId}/audio`, { method: 'POST', body: form });
    if (bubble) addPlayButton(bubble, lastUser.id);
  } catch {
    /* recording is a Phase 2 nicety — never interrupt practice for it */
  }
}

/* ---------- end ---------- */

// Report generation is a multi-second local LLM call, and the server only
// rejects a second /end request with 409 after the first one has already
// committed -- so an impatient second click lands inside that window, passes
// the guard, and generates (and overwrites) the report twice. This flag is
// the in-flight guard for that, checked instead of disabling the button: `end`
// stays pressable on purpose (see the comment below), a second press while
// one is already in flight just does nothing.
let ending = false;

/* A report is being made: shadow.js stops reporting a save that lands now. */
export function sessionEnding() { return ending; }

export async function endSession() {
  if (!state.sessionId || ending) return;
  ending = true;
  // Nothing from the session plays on into the report (shadowing's native
  // clip, a bot reply still talking).
  stopPlayback();
  // Visible from the first frame: the report takes the local model 10-20s,
  // and a screen that does not change reads as a button that did nothing.
  $('report-wait').hidden = false;
  $('btn-end').textContent = '리포트 만드는 중…';
  // A transcription still in flight must not post a turn into a session that
  // is ending. The pending turn is also returned to idle, or the next session
  // would open stuck in `transcribing`.
  transcribeGeneration += 1;
  if (turnState === 'transcribing' || transcribingRespeak) dropPendingTranscript();
  // No disabled-write here: the turn state machine deliberately keeps `end`
  // always enabled (a hung request must never trap the learner in the
  // session), and writing it directly here would fight that -- an AUDIO_DONE
  // landing mid-request would silently re-enable a button this function had
  // just disabled.
  try {
    const data = await postJSON(`/sessions/${state.sessionId}/end`);
    // The session is over, and with it the card: turn states stop going to
    // shadow.js, and a save still answering knows it has no one to tell.
    state.shadowing = false;
    router.show('report');
    // Only a report opened from my page has a way back there.
    $('btn-report-back').hidden = true;
    renderReport(data);
    notify(''); // clear any stale notice ("전송 실패", "대본이 끝났습니다") left over from the session
  } catch (err) {
    notify(`리포트 생성 실패: ${err.message}`);
  } finally {
    ending = false;
    $('report-wait').hidden = true;
    $('btn-end').textContent = '세션 끝내기';
  }
}

/* The report is what the learner is left with when the session ends, so it is
   laid out rather than dumped. The counts come from code and are exact; the
   prose comes from the model and is fallible; the sentences to re-practise are
   the part they will actually act on, so they get their own card.

   `data.level` is deliberately never shown here: Task 11 ran the same
   transcript through the model three times and got three different levels,
   matching what a few real sessions on one scenario already show in the
   database. A single session cannot support a verdict, so displaying one
   would just be a coin flip the learner believes. The value is still stored
   -- a later phase needs the history to compute a level over several
   sessions -- this function just does not render it. */
export function renderReport(data) {
  // Keyed on the payload's own kind, not state.mode/state.shadowing: a report
  // reopened from my page belongs to no current session, so those flags say
  // nothing about it (and endSession clears state.shadowing before this runs).
  if (data.kind === 'shadow') { renderShadowReport(data); return; }
  if (data.kind === 'timed') { renderTimedReport(data); return; }
  const s = data.stats || {};
  // 헤드라인. LLM 에 새 필드를 요구하지 않는다 -- 리포트 프롬프트는 여러 라운드에
  // 걸쳐 다듬어졌고, 필드를 하나 더 넣는 것만으로 그 품질이 회귀할 수 있다.
  // 이미 손에 있는 숫자로 조립한다.
  $('report-headline').textContent = state.mode === 'script'
    ? `대본 ${s.turns ?? 0}줄을 읽었어요.`
    : `오늘 ${s.turns ?? 0}턴을 주고받았어요.`;

  // Script mode stores ok=None on every learner turn by design (Fix 3): the
  // learner read a line, they did not compose one, so there is nothing to
  // grade. That makes s.wrong always 0 and s.ungraded always equal to
  // s.turns -- for a free/lesson session those numbers mean "grading broke",
  // but for a script session they are just what every normal session looks
  // like. Reusing 고칠 곳/교정을 받지 못한 발화 here would either falsely claim
  // grading happened (0 고칠 곳) or read as a failure on every single script
  // report (교정을 받지 못한 발화 N회) -- so this mode gets its own line
  // instead of the free-mode grading vocabulary.
  const counts = state.mode === 'script'
    ? `말한 횟수 ${s.turns ?? 0} · 대본 읽기는 문법 교정 없이 정확도만 확인합니다`
    // A turn the model never graded (an Ollama/JSON failure) is neither
    // right nor wrong -- surfacing it is what stops a session where every
    // grading call failed from reading as a flawless one, since "고칠 곳이
    // 있던 횟수 0" alone looks exactly like a perfect session.
    : `말한 횟수 ${s.turns ?? 0} · 고칠 곳이 있던 횟수 ${s.wrong ?? 0}`
      // An old prose report (graded === false) predates grading: nothing
      // failed, so there is no ungraded count to confess.
      + (s.ungraded && data.graded !== false ? ` · 교정을 받지 못한 발화 ${s.ungraded}회` : '');
  $('report-counts').textContent = counts;

  const body = $('report-body');
  body.replaceChildren();
  body.append(reportCard('총평', [data.summary]));
  const hasWeakPoints = Boolean(data.weak_points && data.weak_points.length);
  if (hasWeakPoints) body.append(reportCard('부족한 부분', data.weak_points));
  if (data.expressions && data.expressions.length) {
    body.append(reportCard('외워둘 표현', data.expressions));
  }
  if (data.next_focus) body.append(reportCard('다음엔 이것을', [data.next_focus]));
  const hasSentenceCard = Boolean(s.sentences && s.sentences.length);
  if (hasSentenceCard) body.append(sentenceCard(s.sentences));
  // s.wrong counts every ok===0 turn, but weak_points can come back empty and
  // sentences requires a non-empty `fixed` -- so a wrong count with neither
  // card rendered would otherwise claim mistakes no card ever explains.
  if (s.wrong > 0 && !hasWeakPoints && !hasSentenceCard) {
    body.append(reportCard('부족한 부분', ['고칠 곳이 있었지만 자세한 내용을 만들지 못했습니다.']));
  }

  $('rep-turns').textContent = s.turns ?? 0;
  $('rep-turns-label').textContent = '턴';
  // 대본 세션은 문법 교정을 하지 않는다(위 counts 분기와 같은 이유) -- "0 고침"은
  // 완벽하게 읽었다는 뜻으로 오해되므로, 애초에 세지 않는다는 뜻의 '—'를 대신 쓴다.
  $('rep-wrong').textContent = state.mode === 'script' ? '—' : String(s.wrong ?? 0);
  $('rep-minutes').textContent = s.minutes ?? 0;

  // 누적 약점. 이 세션이 아니라 앱 전체 기록이라, 리포트가 매번 똑같아 보이지
  // 않게 하는 것이 이 패널의 목적이다. /stats/home 이 이미 3회 하한을 걸어
  // 돌려주므로 여기서 다시 거르지 않는다.
  loadWeakPoints().catch(() => {});   // 리포트를 막지 않는다
}

async function loadWeakPoints() {
  const list = $('weak-list');
  list.replaceChildren();
  $('report-weak').hidden = true;
  const { top_tags: tags = [] } = await getJSON(`/stats/home?language=${state.language}`);
  for (const t of tags) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = t.tag;
    const n = document.createElement('span');
    n.className = 'weak-n';
    n.textContent = `${t.n}회`;
    li.append(name, n);
    list.append(li);
  }
  $('report-weak').hidden = tags.length === 0;
}

/* Shadowing's report (Task 4): no model call ever ran (see `_shadow_report`
   in app/api.py), so there is nothing to summarise -- 총평/부족한 부분/외워둘
   표현/다음엔 이것을 all stay off, and so does the cumulative-weak-points
   panel (that reads across every session, not this one; a session with
   nothing graded has no grammar signal to feed it). Just the counts the
   server already computed, and the lines worth trying again. */
function renderShadowReport(data) {
  const sh = data.shadow || {};
  const s = data.stats || {};
  $('report-headline').textContent = `${sh.done ?? 0}줄을 따라 말했어요.`;
  $('report-counts').textContent =
    `따라 한 줄 ${sh.done ?? 0}/${sh.lines ?? 0} · 대본과 같음 ${sh.matched ?? 0} · 글자 보고 함 ${sh.peeked ?? 0}`;

  const body = $('report-body');
  body.replaceChildren();
  const hard = sh.hard || [];
  if (hard.length) {
    body.append(shadowHardCard(hard));
  } else {
    const p = document.createElement('p');
    p.textContent = '전부 대본대로 따라 했어요 🎉';
    body.append(p);
  }

  $('rep-turns').textContent = s.turns ?? 0;
  $('rep-turns-label').textContent = '턴';
  // No grammar correction happens in a shadowing session (same reason script
  // mode uses '—' above): 0 would read as "every line was perfect".
  $('rep-wrong').textContent = '—';
  $('rep-minutes').textContent = s.minutes ?? 0;

  // Not loadWeakPoints(): that panel is app-wide history, and a shadowing
  // session graded nothing that could feed it.
  $('report-weak').hidden = true;
}

/* 1분 말하기's report (Task 7): every round exactly as it was graded live --
   _timed_report (app/api.py) never calls the model again, so there is
   nothing to summarise here either (no 총평/부족한 부분/외워둘 표현/다음엔 이것을,
   same reason renderShadowReport skips them). Unlike shadowing, though,
   round 1 *did* grade real turns and feed messages/복습/레벨 (Global
   Constraint: "1회차만 기록"), so this session's turns do count toward the
   app-wide weak-points panel -- loadWeakPoints() runs here.

   No recording: finish_session sweeps every round's audio before this
   payload is even built (Global Constraint), so there is no ▶ 내 녹음 here
   the way the live screen has one. */
function renderTimedReport(data) {
  const rounds = data.rounds || [];
  $('report-headline').textContent = `1분 말하기 ${rounds.length}회`;
  $('report-counts').textContent = data.topic || '';

  const body = $('report-body');
  body.replaceChildren();
  if (!rounds.length) {
    const p = document.createElement('p');
    p.textContent = '말한 기록이 없어요';
    body.append(p);
  } else {
    // state.language, not a field off `data`: _timed_report carries no
    // language of its own. Live, this is always the session just spoken in.
    // Reopened from my page, openReport's own staleness check ties the
    // request to the language its history row was loaded under -- it bails
    // before renderReport ever runs if the learner switches language while
    // the request is in flight -- so state.language is the right source
    // either way, not something this function needs to guess at.
    const language = state.language;
    body.append(timedRoundsCard(rounds, language));
    const first = rounds[0];
    if (first.sentences && first.sentences.length) body.append(timedSentencesCard(first.sentences));
    const last = rounds[rounds.length - 1];
    if (last.native) body.append(timedNativeCard(last.native));
  }

  const s = data.stats || {};
  $('rep-turns').textContent = s.turns ?? 0;
  // round 1's sentences, not conversation turns. The panel is shared by every
  // kind of report, so the others put 턴 back.
  $('rep-turns-label').textContent = '문장';
  $('rep-wrong').textContent = String(s.wrong ?? 0);
  $('rep-minutes').textContent = s.minutes ?? 0;

  loadWeakPoints().catch(() => {}); // 리포트를 막지 않는다
}

/* 회차 표: one line per round, 회차 · 단어(글자) · 분당 · 긴 멈춤 · 고친 곳 --
   round 1's own line has nothing to compare against (compareRounds(null, …)),
   every later round is measured against round 1 and the metric that moved
   the good way is marked .timed-better, exactly as the live result screen
   marks it (timed.js's toResult) -- same functions, same class, same rule. */
function timedRoundsCard(rounds, language) {
  const card = document.createElement('section');
  card.className = 'report-card';
  const heading = document.createElement('p');
  heading.className = 'label';
  heading.textContent = '회차별 기록';
  card.append(heading);
  const first = rounds[0];
  for (const r of rounds) card.append(timedRoundRow(r, first, language));
  return card;
}

function timedRoundRow(round, first, language) {
  const p = document.createElement('p');
  const n = document.createElement('span');
  n.className = 'timed-report-round-n';
  n.textContent = `${round.round}회차`;
  p.append(n);
  const compared = compareRounds(round === first ? null : first, round);
  for (const m of compared) {
    p.append(document.createTextNode(' · '));
    const span = document.createElement('span');
    span.className = m.better ? 'timed-metric timed-better' : 'timed-metric';
    span.textContent = formatMetric(m, language);
    p.append(span);
  }
  return p;
}

/* 1회차 문장 목록: 내 말(never struck through -- not .fix-row .said, which is
   a correction's wrong half) / 고친 문장 / 설명. A filler line ("Um.") has
   nothing to judge -- it shows plainly, just what was said, no verdict. */
function timedSentencesCard(sentences) {
  const card = document.createElement('section');
  card.className = 'report-card';
  const heading = document.createElement('p');
  heading.className = 'label';
  heading.textContent = '1회차에 말한 문장';
  card.append(heading);
  for (const s of sentences) {
    const row = document.createElement('div');
    row.className = 'fix-row';
    const mine = document.createElement('p');
    mine.className = 'mine';
    mine.append(labelled('내 말'), document.createTextNode(' '), plain(s.text));
    row.append(mine);
    if (!s.filler) {
      // A correct sentence has nothing to fix and nothing to explain --
      // 설명 for one is just "이미 맞습니다", which says nothing. Show the
      // same ✓ 좋아요 the live result screen shows instead (timed.js's
      // drawVerdict, same wording and class) and skip 고친 문장/설명.
      if (s.ok === true) {
        const good = document.createElement('p');
        good.className = 'timed-good';
        good.textContent = '✓ 좋아요';
        row.append(good);
      } else {
        if (s.ok === false && s.fixed) {
          const fixed = document.createElement('p');
          fixed.className = 'fixed';
          fixed.append(labelled('고친 문장'), document.createTextNode(' '), plain(s.fixed));
          row.append(fixed);
        }
        if (s.correction) {
          const why = document.createElement('p');
          why.append(labelled('설명'), document.createTextNode(' '), plain(s.correction));
          row.append(why);
        }
      }
    }
    card.append(row);
  }
  return card;
}

function timedNativeCard(native) {
  const card = document.createElement('section');
  card.className = 'report-card';
  const heading = document.createElement('p');
  heading.className = 'label';
  heading.textContent = '원어민이라면';
  card.append(heading);
  const p = document.createElement('p');
  p.textContent = native;
  card.append(p);
  return card;
}

function shadowHardCard(hard) {
  const card = document.createElement('section');
  card.className = 'report-card';
  const heading = document.createElement('p');
  heading.className = 'label';
  heading.textContent = '어려웠던 줄';
  card.append(heading);
  for (const h of hard) {
    const row = document.createElement('div');
    row.className = 'fix-row';
    // Labelled like my page's shadowing review card. Not .said: that class is
    // a correction's struck-through wrong half, and nothing here was wrong --
    // it is only what the learner said back.
    const said = document.createElement('p');
    said.className = 'mine';
    said.append(labelled('내 말'), document.createTextNode(' '), plain(h.said));
    const target = document.createElement('p');
    target.className = 'fixed';
    target.append(labelled('대본'), document.createTextNode(' '), plain(h.target));
    // No ▶ 내 발음: the recording is gone by the time this renders (the
    // session's own end route sweeps it, see _forget_recordings).
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-stable';
    btn.textContent = '▶ 원어민';
    btn.addEventListener('click', () => play(h.audio_key, h.target));
    row.append(said, target, btn);
    card.append(row);
  }
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = '이 줄들은 내일 복습에 나와요';
  card.append(note);
  return card;
}

function labelled(text) {
  const span = document.createElement('span');
  span.className = 'label';
  span.textContent = text;
  return span;
}

function plain(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function reportCard(title, items) {
  const card = document.createElement('section');
  card.className = 'report-card';
  const heading = document.createElement('p');
  heading.className = 'label';
  heading.textContent = title;
  card.append(heading);
  for (const item of items) {
    const p = document.createElement('p');
    p.textContent = item;
    card.append(p);
  }
  return card;
}

function sentenceCard(sentences) {
  const card = document.createElement('section');
  card.className = 'report-card';
  const heading = document.createElement('p');
  heading.className = 'label';
  heading.textContent = '다시 말해볼 문장';
  card.append(heading);
  for (const s of sentences) {
    const row = document.createElement('div');
    row.className = 'fix-row';
    const said = document.createElement('p');
    said.className = 'said';
    said.textContent = s.said;
    const fixed = document.createElement('p');
    fixed.className = 'fixed';
    fixed.textContent = s.fixed;
    row.append(said, fixed);
    card.append(row);
  }
  return card;
}
