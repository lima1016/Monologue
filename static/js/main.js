import { $, postJSON, notify } from './api.js';
import { recognition, BCP47, startRecording, stopRecording, setRespeakHandler } from './audio.js';
import { refreshHealth, loadScenarios, startSession,
         sendTurn, nextScriptLine, endSession, undoLastTurn, setTurnState, canDo } from './session.js';
import { renderVoiceList, previewVoice } from './settings.js';
import * as router from './router.js';

/* ---------- screens ---------- */

router.register('home', 'home');
router.register('session', 'session');
router.register('report', 'report');
router.show('home');

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
  // Route the same way the visible button would, and ask the same authority
  // it does too -- the turn state machine, via canDo, not the button's own
  // disabled attribute (which is just a reflection of the same answer).
  if ($('btn-next').hidden) {
    if (canDo('send')) sendTurn();
  } else if (canDo('next')) {
    nextScriptLine();
  }
});
$('btn-mic').addEventListener('click', () => {
  if (!recognition) {
    notify('이 브라우저는 음성 인식을 지원하지 않습니다. 아래 입력창에 직접 입력하세요.');
    return;
  }
  notify('');
  setTurnState('MIC');
  const recording = startRecording();
  // An ordinary listen never belongs to a re-speak. Discard any handler left
  // staged by a re-speak whose recognition never reached onstart -- Chrome
  // fires error+end with no start at all for not-allowed/audio-capture/
  // service-not-allowed/network, so startRespeak's own catch never runs and
  // the stage would otherwise still be armed here. Cleared before start(),
  // never in onend, so a click landing between a previous session's end and
  // its queued onend can't wipe a handler this call is about to stage.
  setRespeakHandler(null);
  recognition.lang = BCP47[$('language').value];
  try {
    recognition.start();
  } catch (err) {
    // e.g. an InvalidStateError from a recognition that's already running.
    // onend never fires when start() itself throws, so nothing would
    // otherwise return the machine from `listening` -- HEARD_NOTHING does
    // the same thing a real "heard nothing" result would. startRecording()
    // is async and un-awaited above, so the stream/recorder it opens may not
    // exist yet -- stop it once that promise actually settles, or the mic
    // stays open until the next startRecording() call replaces it.
    recording.then(stopRecording);
    notify(`음성 인식을 시작하지 못했습니다: ${err.message}`);
    setTurnState('HEARD_NOTHING');
  }
});
$('conversation').addEventListener('click', (e) => {
  const bubble = e.target.closest('.msg.user.undoable');
  if (bubble) undoLastTurn(bubble);
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
