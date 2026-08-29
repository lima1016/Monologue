'use strict';

const $ = (id) => document.getElementById(id);
const api = async (path, options) => {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || 'request failed');
  }
  return res;
};
const getJSON = async (path) => (await api(path)).json();
const postJSON = async (path, body) =>
  (await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })).json();

const state = {
  sessionId: null,
  language: 'en',
  mode: 'free',
  scriptLines: [],
  scriptIndex: 0,
  recorder: null,
  chunks: [],
  busy: false, // re-entrancy guard: blocks a second sendTurn/nextScriptLine while one is in flight
};

const BCP47 = { en: 'en-US', ja: 'ja-JP' };

/* ---------- status ---------- */

async function refreshHealth() {
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

function notify(message) {
  const el = $('notice');
  el.textContent = message;
  el.hidden = !message;
}

/* ---------- setup ---------- */

async function loadScenarios() {
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

async function startSession() {
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
    $('setup').hidden = true;
    $('session').hidden = false;
    $('feedback').hidden = false;
    $('conversation').innerHTML = '';
    $('feedback-list').innerHTML = '';
    notify('');

    if (data.mode === 'script') startScript(data.lines);
    else {
      $('script-panel').hidden = true;
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

function addMessage(who, text) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  $('conversation').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function addFeedback(said, correction, suggestion) {
  if (!correction && !suggestion) return;
  const div = document.createElement('div');
  div.className = 'fb';
  div.innerHTML = `<div class="said">"${said}"</div>`;
  if (correction) div.innerHTML += `<div><span class="label">교정</span><br>${correction}</div>`;
  if (suggestion) div.innerHTML += `<div><span class="label">이렇게도</span><br>${suggestion}</div>`;
  $('feedback-list').prepend(div);
}

async function sendTurn() {
  const text = $('text-input').value.trim();
  if (!text || !state.sessionId || state.busy) return;
  state.busy = true;
  $('text-input').value = '';
  addMessage('user', text);
  $('btn-send').disabled = true;
  try {
    const data = await postJSON('/chat', { session_id: state.sessionId, text });
    addMessage('bot', data.bot_reply);
    addFeedback(text, data.correction, data.suggestion);
    play(data.audio_key, data.bot_reply);
    await uploadPendingRecording();
  } catch (err) {
    notify(`전송 실패: ${err.message}`);
  } finally {
    state.chunks = []; // a failed turn has no message to attach a recording to
    state.busy = false;
    $('btn-send').disabled = false;
  }
}

/* ---------- script mode ---------- */

function startScript(lines) {
  state.scriptLines = lines;
  state.scriptIndex = 0;
  $('script-panel').hidden = false;
  $('btn-next').hidden = false;
  $('btn-send').hidden = true;
  $('script-lines').innerHTML = lines
    .map((l, i) => `<li data-i="${i}"><b>${l.speaker === 'bot' ? '봇' : '나'}</b> ${l.text}</li>`)
    .join('');
  advanceScript();
}

function advanceScript() {
  const items = [...$('script-lines').children];
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

async function nextScriptLine() {
  if (state.busy) return;
  const line = state.scriptLines[state.scriptIndex];
  if (line && line.speaker === 'user') {
    state.busy = true;
    const spoken = $('text-input').value.trim() || line.text;
    $('text-input').value = '';
    addMessage('user', spoken);
    $('btn-next').disabled = true;
    try {
      const data = await postJSON('/chat', { session_id: state.sessionId, text: spoken });
      addFeedback(spoken, data.correction, data.suggestion);
      await uploadPendingRecording();
      state.scriptIndex += 1; // only advance past a turn that was actually recorded
    } catch (err) {
      notify(`저장 실패: ${err.message}`);
    } finally {
      state.chunks = []; // a failed turn has no message to attach a recording to
      state.busy = false;
      $('btn-next').disabled = false;
    }
  } else if (line) {
    addMessage('bot', line.text);
    state.scriptIndex += 1;
  }
  advanceScript();
}

/* ---------- audio out ---------- */

function play(audioKey, fallbackText) {
  if (audioKey) {
    notify(''); // a real server clip means any earlier quality warning no longer applies
    new Audio(`/api/audio/${audioKey}.wav`).play().catch(() => speakInBrowser(fallbackText));
    return;
  }
  notify('서버 음성 생성에 실패해 브라우저 음성으로 대체합니다. 품질이 떨어집니다.');
  speakInBrowser(fallbackText);
}

function speakInBrowser(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = BCP47[state.language];
  speechSynthesis.speak(u);
}

/* ---------- speech in ---------- */

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $('btn-mic').disabled = true;
    notify('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome을 쓰거나 아래 입력창에 직접 입력하세요.');
    return null;
  }
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.onresult = (e) => { $('text-input').value = e.results[0][0].transcript; };
  recognition.onerror = (e) => notify(`음성 인식 실패(${e.error}). 입력창에 직접 입력하세요.`);
  recognition.onend = () => { $('btn-mic').textContent = '🎤 말하기'; stopRecording(); };
  return recognition;
}

const recognition = setupRecognition();

async function startRecording() {
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

function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

async function uploadPendingRecording() {
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

async function endSession() {
  if (!state.sessionId) return;
  $('btn-end').disabled = true;
  try {
    const data = await postJSON(`/sessions/${state.sessionId}/end`);
    $('session').hidden = true;
    $('report').hidden = false;
    $('report-level').textContent = `추정 수준: ${data.level}`;
    $('report-body').textContent = data.report;
  } catch (err) {
    notify(`리포트 생성 실패: ${err.message}`);
  } finally {
    $('btn-end').disabled = false;
  }
}

/* ---------- wiring ---------- */

$('language').addEventListener('change', () => { loadScenarios(); refreshHealth(); });
$('mode').addEventListener('change', loadScenarios);
$('btn-start').addEventListener('click', startSession);
$('btn-send').addEventListener('click', sendTurn);
$('btn-next').addEventListener('click', nextScriptLine);
$('btn-end').addEventListener('click', endSession);
$('btn-restart').addEventListener('click', () => window.location.reload());
$('text-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // Route the same way the visible button would, and respect its disabled state too —
  // Enter should not be able to start work the UI is currently showing as unavailable.
  if ($('btn-next').hidden) {
    if (!$('btn-send').disabled) sendTurn();
  } else if (!$('btn-next').disabled) {
    nextScriptLine();
  }
});
$('btn-mic').addEventListener('click', () => {
  if (!recognition) return;
  notify('');
  $('btn-mic').textContent = '● 듣는 중...';
  startRecording();
  recognition.lang = BCP47[$('language').value];
  recognition.start();
});

loadScenarios();
refreshHealth();

/* ---------- settings ---------- */

let currentPreviewAudio = null;
let currentPreviewUrl = null;

async function renderVoiceList() {
  const language = $('settings-language').value;
  try {
    const { voices, selected } = await getJSON(`/voices?language=${language}`);
    $('voice-list').innerHTML = voices
      .map(
        (v) => `<div class="voice">
          <input type="radio" name="voice" id="v-${v.id}" value="${v.id}" ${v.id === selected ? 'checked' : ''}>
          <label for="v-${v.id}">${v.label} <span class="hint">${v.gender === 'male' ? '남성' : '여성'}</span></label>
          <button data-preview="${v.id}">▶ 미리듣기</button>
        </div>`
      )
      .join('');
  } catch (err) {
    notify(`음성 목록을 불러올 수 없습니다: ${err.message}`);
    $('voice-list').innerHTML = '';
  }
}

async function previewVoice(voice) {
  const language = $('settings-language').value;
  try {
    // Stop and clean up any currently-playing preview
    if (currentPreviewAudio) {
      currentPreviewAudio.pause();
    }
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
    }

    const res = await api('/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, voice }),
    });
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    currentPreviewAudio = audio;
    currentPreviewUrl = url;
    await audio.play();
  } catch (err) {
    notify(`미리듣기 실패: ${err.message}`);
  }
}

$('btn-settings').addEventListener('click', async () => {
  $('settings-language').value = $('language').value;
  await renderVoiceList();
  $('settings').showModal();
});
$('settings-language').addEventListener('change', renderVoiceList);
$('btn-close-settings').addEventListener('click', () => $('settings').close());
$('voice-list').addEventListener('click', (e) => {
  const preview = e.target.dataset.preview;
  if (preview) previewVoice(preview);
});
$('voice-list').addEventListener('change', async (e) => {
  if (e.target.name !== 'voice') return;
  try {
    await postJSON('/voices', {
      language: $('settings-language').value,
      voice: e.target.value,
    });
  } catch (err) {
    notify(`음성 설정을 저장할 수 없습니다: ${err.message}`);
    await renderVoiceList();
  }
});
