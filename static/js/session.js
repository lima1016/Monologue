import { $, api, getJSON, postJSON, state, notify } from './api.js';
import { play, setHeardHandler, recognition, BCP47, setRespeakHandler, setInterimHandler } from './audio.js';
import { matches } from './match.js';
import * as router from './router.js';
import * as turn from './turnstate.js';
import { annotate, escapeHtml } from './reading.js';

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

function clearActiveRespeak() {
  if (activeRespeak) activeRespeak.btn.textContent = RESPEAK_LABEL;
  activeRespeak = null;
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
  // is also true during `respeaking` (a re-speak needs the same "press again
  // to end" ability -- see turnstate.js), but that stop belongs exclusively
  // to the chip's own button (startRespeak's `activeRespeak` check) -- the
  // main mic button must stay dead through a re-speak the same as it always
  // has, not become a second, unlabelled way to end someone else's session.
  $('btn-mic').disabled = !(canDo('mic') || turnState === 'listening');
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
  $('mic-hint').textContent = listening
    ? (liveHeard || '듣고 있습니다...')
    : '누르고 말한 뒤, 다 말하면 다시 눌러서 전송하세요';
  $('thinking').hidden = turnState !== 'sending';
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
  return turnState;
}

/* A recognised sentence becomes a turn automatically. Hearing nothing just
   returns control to the learner. Re-speak (Task 8) takes priority over this
   handler via audio.js's `deliver` and never reaches it. */
function handleHeard(transcript) {
  if (!transcript) { setTurnState('HEARD_NOTHING'); return; }
  // Script mode owns its own turn cycle: nextScriptLine is the only thing
  // that advances scriptIndex and suppresses the LLM's reply, so a spoken
  // line must go through it rather than through sendText. Routing the mic
  // straight to sendText would post to /chat and speak an off-script LLM
  // reply over a script panel that never advances.
  if (state.mode === 'script') {
    $('text-input').value = transcript;
    setTurnState('HEARD_NOTHING'); // release `listening`; nextScriptLine runs its own cycle
    nextScriptLine();
    return;
  }
  setTurnState('HEARD');
  sendText(transcript);
}
setHeardHandler(handleHeard);
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

export async function refreshHealth() {
  try {
    const h = await getJSON('/health');
    $('status-ollama').className = `dot ${h.ollama ? 'up' : 'down'}`;
    $('status-voicevox').className = `dot ${h.voicevox ? 'up' : 'down'}`;
    if (!h.ollama) notify('Ollama가 실행 중이 아닙니다. 터미널에서 ollama serve를 실행하세요.');
    else if (!h.voicevox && state.language === 'ja')
      notify('VOICEVOX가 꺼져 있습니다. docker compose up -d 를 실행하세요.');
    else notify('');
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
export async function startSession({ language, mode, scenarioId, topic } = {}) {
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
    router.show('session');
    $('conversation').innerHTML = '';
    notify('');

    if (data.mode === 'script') startScript(data.lines);
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
    notify(`세션을 시작하지 못했습니다: ${err.message}`);
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

  const detail = document.createElement('div');
  detail.className = 'chip-detail';
  detail.hidden = true;
  summary.setAttribute('aria-expanded', 'false');
  if (fb.correction) detail.appendChild(block('교정', fb.correction, 'corr'));
  if (fb.suggestion) detail.appendChild(block('이렇게도', fb.suggestion, 'sug'));

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
    detail.appendChild(row);
  }

  summary.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    summary.setAttribute('aria-expanded', String(!detail.hidden));
  });

  wrap.append(summary, detail);
  bubble.after(wrap);
  return wrap;
}

/* Re-speaking is deliberately a different state from a normal turn: the
   recognised text is compared against `target` and never sent to the bot.

   `respeak` is only allowed from `idle` (turnstate.js) -- a turn already in
   flight, the bot still speaking, or another re-speak already listening all
   say no here, silently, the same way sendTurn/undoLastTurn guard themselves.
   The chip's re-speak buttons are not wired into syncControls (they belong to
   whichever turn produced them, not to "the current turn"), so this guard is
   the only thing standing between a stray click and two recognitions
   overlapping. */
export function startRespeak(target, resultEl, btn) {
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
    return;
  }
  if (!canDo('respeak')) {
    notify('봇이 말하는 동안에는 다시 말할 수 없습니다. 끝날 때까지 기다려주세요.');
    return;
  }
  if (!recognition) { notify('이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
  setTurnState('RESPEAK');
  activeRespeak = { btn, resultEl };
  if (btn) btn.textContent = RESPEAK_STOP_LABEL;
  resultEl.hidden = false;
  resultEl.className = 'respeak-result';
  resultEl.textContent = '듣는 중...';

  setRespeakHandler((spoken) => {
    clearActiveRespeak();
    if (spoken === null) {
      setTurnState('HEARD_NOTHING');
      resultEl.textContent = '못 알아들었습니다. 다시 해보세요.';
      return;
    }
    setTurnState('HEARD');
    const good = matches(spoken, target, state.language);
    resultEl.classList.add(good ? 'good' : 'bad');
    resultEl.textContent = good ? `좋습니다 — "${spoken}"` : `"${spoken}" — 조금 다릅니다. 다시 해보세요.`;
  });
  recognition.lang = BCP47[state.language];
  try {
    recognition.start();
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
    notify(`음성 인식을 시작하지 못했습니다: ${err.message}`);
    resultEl.textContent = '음성 인식을 시작하지 못했습니다. 다시 눌러보세요.';
    setTurnState('HEARD_NOTHING');
  }
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
  if (state.language === 'ja') {
    const items = [...$('panel-body').querySelectorAll('li .line')];
    annotate(items.map((el, i) => ({ el, text: lines[i].text })));
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

export async function endSession() {
  if (!state.sessionId || ending) return;
  ending = true;
  // No disabled-write here: the turn state machine deliberately keeps `end`
  // always enabled (a hung request must never trap the learner in the
  // session), and writing it directly here would fight that -- an AUDIO_DONE
  // landing mid-request would silently re-enable a button this function had
  // just disabled.
  try {
    const data = await postJSON(`/sessions/${state.sessionId}/end`);
    router.show('report');
    renderReport(data);
    notify(''); // clear any stale notice ("전송 실패", "대본이 끝났습니다") left over from the session
  } catch (err) {
    notify(`리포트 생성 실패: ${err.message}`);
  } finally {
    ending = false;
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
function renderReport(data) {
  const s = data.stats || {};
  let counts = `말한 횟수 ${s.turns ?? 0} · 고칠 곳이 있던 횟수 ${s.wrong ?? 0}`;
  // A turn the model never graded (an Ollama/JSON failure) is neither right
  // nor wrong -- surfacing it is what stops a session where every grading
  // call failed from reading as a flawless one, since "고칠 곳이 있던 횟수 0"
  // alone looks exactly like a perfect session.
  if (s.ungraded) counts += ` · 교정을 받지 못한 발화 ${s.ungraded}회`;
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
