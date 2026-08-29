import { $, state } from './api.js';

export const BCP47 = { en: 'en-US', ja: 'ja-JP' };

/* ---------- audio out ---------- */

export function play(audioKey, fallbackText) {
  if (audioKey) {
    notify(''); // a real server clip means any earlier quality warning no longer applies
    new Audio(`/api/audio/${audioKey}.wav`).play().catch(() => speakInBrowser(fallbackText));
    return;
  }
  notify('서버 음성 생성에 실패해 브라우저 음성으로 대체합니다. 품질이 떨어집니다.');
  speakInBrowser(fallbackText);
}

export function speakInBrowser(text) {
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
