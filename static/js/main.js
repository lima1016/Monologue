import { $, state, postJSON } from './api.js';
import { recognition, BCP47, startRecording } from './audio.js';
import { notify, refreshHealth, loadScenarios, startSession,
         sendTurn, nextScriptLine, endSession } from './session.js';
import { renderVoiceList, previewVoice } from './settings.js';

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
