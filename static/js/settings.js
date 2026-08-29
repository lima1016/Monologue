import { $, api, getJSON, postJSON } from './api.js';
import { notify } from './session.js';

let currentPreviewAudio = null;
let currentPreviewUrl = null;

export async function renderVoiceList() {
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

export async function previewVoice(voice) {
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
