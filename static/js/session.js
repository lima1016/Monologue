import { $, api, getJSON, postJSON, state, notify } from './api.js';
import { play, setHeardHandler } from './audio.js';
import * as router from './router.js';
import * as turn from './turnstate.js';

/* ---------- turn state ---------- */

let turnState = turn.INITIAL;

/* The one place that knows what is in flight. Callers ask it rather than
   keeping their own copy -- two sources of truth about "is a turn running"
   is exactly the bug the old re-entrancy flag produced. */
export function canDo(control) {
  return turn.controls(turnState)[control];
}

export function setTurnState(event) {
  turnState = turn.next(turnState, event);
  const c = turn.controls(turnState);
  $('btn-mic').disabled = !c.mic;
  $('btn-send').disabled = !c.send;
  $('btn-next').disabled = !c.next;
  $('btn-end').disabled = !c.end;
  const listening = turnState === 'listening' || turnState === 'respeaking';
  $('btn-mic').classList.toggle('listening', listening);
  // The mic's glyph is a CSS ::after pseudo-element, not a DOM child, so it
  // cannot carry status text itself -- this hint line is what actually tells
  // the learner what's happening (carried from Task 4/5's ruling).
  $('mic-hint').textContent = listening
    ? '듣고 있습니다...'
    : '누르고 말하면 자동으로 전송됩니다';
  $('thinking').hidden = turnState !== 'sending';
  return turnState;
}

/* A recognised sentence becomes a turn automatically. Hearing nothing just
   returns control to the learner. Re-speak (Task 8) takes priority over this
   handler via audio.js's `deliver` and never reaches it. */
function handleHeard(transcript) {
  if (transcript) {
    setTurnState('HEARD');
    sendText(transcript);
  } else {
    setTurnState('HEARD_NOTHING');
  }
}
setHeardHandler(handleHeard);

/* ---------- status ---------- */

export async function refreshHealth() {
  try {
    const h = await getJSON('/health');
    $('status-ollama').className = `dot ${h.ollama ? 'up' : 'down'}`;
    $('status-voicevox').className = `dot ${h.voicevox ? 'up' : 'down'}`;
    if (!h.ollama) notify('Ollama가 실행 중이 아닙니다. 터미널에서 ollama serve를 실행하세요.');
    else if (!h.voicevox && $('language').value === 'ja')
      notify('VOICEVOX가 꺼져 있습니다. docker compose up -d 를 실행하세요.');
    else notify('');
  } catch {
    notify('서버에 연결할 수 없습니다.');
  }
}

/* ---------- setup ---------- */

export async function loadScenarios() {
  const language = $('language').value;
  const mode = $('mode').value;
  $('scenario-row').hidden = mode === 'lesson';
  $('topic-row').hidden = mode !== 'lesson';
  if (mode === 'lesson') return;

  const { scenarios } = await getJSON(`/scenarios?language=${language}&mode=${mode}`);
  $('scenario').innerHTML = scenarios
    .map((s) => `<option value="${s.id}">${s.title}</option>`)
    .join('');
}

export async function startSession() {
  const payload = {
    language: $('language').value,
    mode: $('mode').value,
    scenario_id: $('mode').value === 'lesson' ? null : $('scenario').value,
    topic: $('topic').value.trim() || null,
  };
  $('btn-start').disabled = true;
  try {
    const data = await postJSON('/sessions', payload);
    state.sessionId = data.session_id;
    state.language = payload.language;
    state.mode = payload.mode;
    router.show('session');
    $('conversation').innerHTML = '';
    notify('');

    if (data.mode === 'script') startScript(data.lines);
    else {
      // Scenario goal isn't in this response yet (Task 6 wires that up) --
      // fall back to the topic the learner typed, or leave the panel blank.
      $('panel-title').textContent = '목표';
      $('panel-body').textContent = payload.topic || '';
      $('btn-next').hidden = true;
      $('btn-send').hidden = false;
      addMessage('bot', data.opening);
      play(data.opening_audio, data.opening);
    }
  } catch (err) {
    notify(`세션을 시작하지 못했습니다: ${err.message}`);
  } finally {
    $('btn-start').disabled = false;
  }
}

/* ---------- conversation ---------- */

export function addMessage(who, text) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  $('conversation').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

export function addFeedback(said, correction, suggestion) {
  // Task 7 renders correction chips under the speech bubble. Left as a
  // no-op (rather than deleted) because sendText/nextScriptLine still call it.
  return;
}

export async function sendText(text) {
  // Only the most recent learner bubble is undoable -- deleting a middle turn
  // would leave the conversation after it referring to something gone.
  const prev = $('conversation').querySelector('.msg.user.undoable');
  if (prev) { prev.classList.remove('undoable'); prev.removeAttribute('title'); }

  $('text-input').value = '';
  const bubble = addMessage('user', text);
  bubble.classList.add('undoable');
  bubble.title = '잘못 인식됐다면 눌러서 고치세요';
  bubble.dataset.turnText = text;
  try {
    const data = await postJSON('/chat', { session_id: state.sessionId, text });
    setTurnState('REPLY');
    addMessage('bot', data.bot_reply);
    addFeedback(text, data.correction, data.suggestion);
    // AUDIO_DONE returns the turn to `idle` once the bot's clip actually
    // finishes -- until then `speaking` still permits starting a new turn
    // (barge-in) but blocks undo/next/respeak (see turnstate.js).
    play(data.audio_key, data.bot_reply, () => setTurnState('AUDIO_DONE'));
    await uploadPendingRecording();
  } catch (err) {
    notify(`전송 실패: ${err.message}`);
    setTurnState('SEND_FAILED');
  } finally {
    state.chunks = []; // a failed turn has no message to attach a recording to
  }
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
  $('btn-next').hidden = false;
  $('btn-send').hidden = true;
  $('panel-title').textContent = '대본';
  $('panel-body').innerHTML = `<ol>${lines
    .map((l, i) => `<li data-i="${i}"><b>${l.speaker === 'bot' ? '봇' : '나'}</b> ${l.text}</li>`)
    .join('')}</ol>`;
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
    $('btn-next').disabled = true;
    return;
  }
  if (line.speaker === 'bot') play(line.audio_key, line.text);
}

export async function nextScriptLine() {
  const line = state.scriptLines[state.scriptIndex];
  if (line && line.speaker === 'user') {
    if (!canDo('send')) return;
    setTurnState('SEND');
    const spoken = $('text-input').value.trim() || line.text;
    $('text-input').value = '';
    addMessage('user', spoken);
    try {
      const data = await postJSON('/chat', { session_id: state.sessionId, text: spoken });
      setTurnState('REPLY');
      addFeedback(spoken, data.correction, data.suggestion);
      await uploadPendingRecording();
      state.scriptIndex += 1; // only advance past a turn that was actually recorded
      // Unlike sendText, nothing from this /chat reply is played as audio --
      // the script's own pre-recorded line audio plays via advanceScript()
      // below, uncoupled from turn state. So there is no clip to wait on:
      // return to idle immediately or `next`/`undo` would stay disabled.
      setTurnState('AUDIO_DONE');
    } catch (err) {
      notify(`저장 실패: ${err.message}`);
      setTurnState('SEND_FAILED');
    } finally {
      state.chunks = []; // a failed turn has no message to attach a recording to
    }
  } else if (line) {
    addMessage('bot', line.text);
    state.scriptIndex += 1;
  }
  advanceScript();
}

export async function uploadPendingRecording() {
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
  } catch {
    /* recording is a Phase 2 nicety — never interrupt practice for it */
  }
}

/* ---------- end ---------- */

export async function endSession() {
  if (!state.sessionId) return;
  $('btn-end').disabled = true;
  try {
    const data = await postJSON(`/sessions/${state.sessionId}/end`);
    router.show('report');
    $('report-level').textContent = `추정 수준: ${data.level}`;
    $('report-body').textContent = data.report;
  } catch (err) {
    notify(`리포트 생성 실패: ${err.message}`);
  } finally {
    $('btn-end').disabled = false;
  }
}
