import { $, api, getJSON, postJSON, state, notify } from './api.js';
import { play, setHeardHandler, recognition, BCP47, setRespeakHandler } from './audio.js';
import { matches } from './match.js';
import * as router from './router.js';
import * as turn from './turnstate.js';

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
  $('btn-mic').disabled = !canDo('mic');
  $('btn-send').disabled = !canDo('send');
  $('btn-next').disabled = !canDo('next');
  $('btn-end').disabled = !canDo('end');
  const listening = turnState === 'listening' || turnState === 'respeaking';
  $('btn-mic').classList.toggle('listening', listening);
  // The mic's glyph is a CSS ::after pseudo-element, not a DOM child, so it
  // cannot carry status text itself -- this hint line is what actually tells
  // the learner what's happening (carried from Task 4/5's ruling).
  $('mic-hint').textContent = listening
    ? '듣고 있습니다...'
    : '누르고 말하면 자동으로 전송됩니다';
  $('thinking').hidden = turnState !== 'sending';
}

export function setTurnState(event) {
  turnState = turn.next(turnState, event);
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

/* ---------- home ---------- */

// Filled by loadHome (Task 8) once a resumable session is found; read by
// resumeSession (Task 8). Declared here, ahead of either function, so a
// module that only defines one of the two never references an identifier
// the other half hasn't declared yet.
let resumeTarget = null;

/* Everything on the home screen that depends on history. Fails quietly: a
   learner who wants to practise should never be stopped by a counter.

   `session.turns` here comes from GET /sessions/resumable, which counts
   *every* message in the session (bot and learner) -- not the same "turns"
   db.session_stats reports on the end-of-session screen, which counts only
   the learner's own messages. Relabelling this as "말한 횟수" (times you
   spoke) would overstate the learner's count by roughly double, since every
   learner line in a live conversation is followed by a bot reply. Getting
   the learner-only count would mean fetching this session's full message
   list just to count it, on a load that must stay best-effort and cheap --
   so instead this reads as a plain exchange count ("대화 N턴"), which is
   what the payload actually measures, rather than silently mislabelling it
   as effort. */
export async function loadHome() {
  // Hidden before the await, on every path (including catch below): a failed
  // request must never leave the previous language's card/counters on screen
  // under the newly selected language button. A missing card is honest; a
  // stale one silently lies, and the learner has no way to tell the two apart.
  $('resume-card').hidden = true;
  $('home-stats').hidden = true;
  $('recommend').hidden = true;

  // Captured at call time: two quick language-switch clicks start two
  // overlapping loads, and without this an older response that resolves last
  // would paint its (now wrong) language's data over the newer, correct one.
  const lang = state.language;
  try {
    const [{ session }, stats] = await Promise.all([
      getJSON(`/sessions/resumable?language=${lang}`),
      getJSON(`/stats/home?language=${lang}`),
    ]);

    if (state.language !== lang) return; // a newer switch already won

    $('resume-card').hidden = !session;
    if (session) {
      resumeTarget = session;
      $('resume-title').textContent = `이어서 하기 — ${session.title}`;
      $('resume-sub').textContent = `대화 ${session.turns}턴에서 멈췄습니다`;
    }

    $('stat-streak').textContent = stats.streak;
    $('stat-week').textContent = stats.week_turns;
    $('stat-fixed').textContent = stats.fixed_total;
    $('home-stats').hidden = !(stats.streak || stats.week_turns || stats.fixed_total);

    $('recommend').hidden = !stats.top_tag;
    if (stats.top_tag) {
      $('recommend').textContent = `요즘 ${stats.top_tag}에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`;
    }
  } catch {
    // history is a nicety -- never block the learner from starting. But the
    // three elements above must stay hidden on this path too: a later
    // refactor that moves the initial hide out of this function must not be
    // able to silently reopen the stale-data bug this guards against.
    $('resume-card').hidden = true;
    $('home-stats').hidden = true;
    $('recommend').hidden = true;
  }
}

/* 이어서 하기: attach to the existing session rather than starting a new one.
   GET /sessions/{id} already returns every message, so replaying them is
   enough to restore the conversation on screen.

   resumable_session (db.py) already excludes mode === 'script' sessions --
   the learner's position in a script (scriptIndex) lives only in the
   browser and is never persisted, so there is nothing server-side to place
   them back into. That exclusion predates this task (it shipped with
   GET /sessions/resumable itself); resumeSession does not need its own
   guard for it because resumeTarget can never hold a script session. */
export async function resumeSession() {
  if (!resumeTarget) return;
  try {
    const { messages } = await getJSON(`/sessions/${resumeTarget.id}`);
    state.sessionId = resumeTarget.id;
    state.mode = resumeTarget.mode;
    router.show('session');
    $('conversation').replaceChildren();
    for (const m of messages) addMessage(m.speaker, m.text);
    // Same rule as startSession: the side panel holds only 목표 or 대본, so a
    // resumed session with no goal (lesson mode, or free mode with none set)
    // hides the panel rather than showing the "목표" heading over nothing.
    const goal = resumeTarget.goal || '';
    $('panel-title').textContent = '목표';
    $('panel-body').textContent = goal;
    $('side-panel').hidden = !goal;
    notify('');
  } catch (err) {
    notify(`이어서 하지 못했습니다: ${err.message}`);
  }
}

/* The chips are the catalogue, not a required choice. A learner who knows what
   they want types it; the chips are for the ones they have used before and for
   the days they have no idea. */
export async function loadChips() {
  const box = $('chips');
  box.replaceChildren();
  if (state.mode === 'lesson') return;   // lesson takes a topic, not a scenario
  const { scenarios } = await getJSON(`/scenarios?language=${state.language}&mode=${state.mode}`);
  for (const s of scenarios.slice(0, 8)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.title;
    b.dataset.id = s.id;
    box.append(b);
  }
}

/* Three ways in, one button:
   - a chip, or text that names a scenario we already have -> reuse it
   - text we have never seen -> ask the model to build it
   - nothing typed -> pick one, because "고르세요" is what this screen removed */
export async function startFromHome(scenarioId = null) {
  const wish = $('wish').value.trim();
  $('btn-start').disabled = true;
  try {
    let id = scenarioId;
    if (!id && state.mode !== 'lesson' && wish) {
      const { scenarios } = await getJSON(`/scenarios?language=${state.language}&mode=${state.mode}`);
      const hit = scenarios.find((s) => s.title.trim() === wish);
      if (hit) id = hit.id;
      else {
        notify('상황을 만드는 중입니다...');
        const made = await postJSON('/scenarios/generate',
          { language: state.language, mode: state.mode, wish });
        id = made.id;
        notify('');
      }
    }
    if (!id && state.mode !== 'lesson') {
      const { scenarios } = await getJSON(`/scenarios?language=${state.language}&mode=${state.mode}`);
      if (!scenarios.length) { notify('연습할 상황이 없습니다.'); return; }
      id = scenarios[Math.floor(Math.random() * scenarios.length)].id;
    }
    await startSession({ scenarioId: id, topic: state.mode === 'lesson' ? wish : null });
  } catch (err) {
    notify(`시작하지 못했습니다: ${err.message}`);
  } finally {
    $('btn-start').disabled = false;
  }
}

export async function startSession({ scenarioId, topic } = {}) {
  // startScript resets this for a script session; a free session never went
  // through startScript before, so without this a free session started right
  // after a finished script session would inherit the earlier session's
  // exhausted flag. Harmless today only because btn-next stays hidden in free
  // mode -- cleared here so the invariant holds for every session, not just
  // script ones.
  scriptExhausted = false;
  const payload = {
    language: state.language,
    mode: state.mode,
    scenario_id: state.mode === 'lesson' ? null : scenarioId,
    topic: topic || null,
  };
  $('btn-start').disabled = true;
  try {
    const data = await postJSON('/sessions', payload);
    state.sessionId = data.session_id;
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
    btn.textContent = '🎤 고쳐서 다시 말해보기';
    const target = document.createElement('div');
    target.className = 'respeak-target';
    target.textContent = fb.fixed;
    const result = document.createElement('p');
    result.className = 'respeak-result';
    result.hidden = true;
    btn.addEventListener('click', () => startRespeak(fb.fixed, result));
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
export function startRespeak(target, resultEl) {
  if (!canDo('respeak')) {
    notify('봇이 말하는 동안에는 다시 말할 수 없습니다. 끝날 때까지 기다려주세요.');
    return;
  }
  if (!recognition) { notify('이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
  setTurnState('RESPEAK');
  resultEl.hidden = false;
  resultEl.className = 'respeak-result';
  resultEl.textContent = '듣는 중...';

  setRespeakHandler((spoken) => {
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
    // wrongly promote into the *next* recognition that does start.
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
  addMessage('bot', data.bot_reply);
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
    // `turnstate.js` has no notion of scripts, so this is the one flag that
    // knows -- `syncControls` (the only writer of `disabled`) reads it too,
    // so a later unrelated setTurnState call can't accidentally re-enable
    // `next` for a script that has already ended.
    scriptExhausted = true;
    syncControls();
    return;
  }
  if (line.speaker === 'bot') play(line.audio_key, line.text);
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

    // Scoped to the request alone -- see sendText for why.
    let data;
    try {
      data = await postJSON('/chat', { session_id: state.sessionId, text: spoken });
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
    addChip(bubble, data);
    await uploadPendingRecording(bubble); // clears state.chunks itself on this path
    state.scriptIndex += 1; // only advance past a turn that was actually recorded
    // Unlike sendText, nothing from this /chat reply is played as audio --
    // the script's own pre-recorded line audio plays via advanceScript()
    // below, uncoupled from turn state. So there is no clip to wait on:
    // return to idle immediately or `next`/`undo` would stay disabled.
    setTurnState('AUDIO_DONE');
  } else if (line) {
    addMessage('bot', line.text);
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
