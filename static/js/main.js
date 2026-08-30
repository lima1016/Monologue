import { $, postJSON, notify, state } from './api.js';
import { play, recognition, BCP47, startRecording, stopRecording, setRespeakHandler } from './audio.js';
import { refreshHealth, sendTurn, nextScriptLine, endSession, undoLastTurn,
         setTurnState, canDo } from './session.js';
import { loadChips, loadHome, resumeSession, startFromHome } from './home.js';
import { renderVoiceList, previewVoice, loadReadingPrefs, saveReadingPrefs } from './settings.js';
import { toggleMeaning } from './reading.js';
import * as router from './router.js';

/* ---------- screens ---------- */

router.register('home', 'home');
router.register('session', 'session');
router.register('report', 'report');
router.show('home');

/* ---------- wiring ---------- */

$('language-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-language]');
  if (!btn) return;
  state.language = btn.dataset.language;
  [...$('language-seg').children].forEach((b) => b.classList.toggle('on', b === btn));
  loadChips();
  refreshHealth();
  // Both GET /sessions/resumable and GET /stats/home are scoped by
  // language: without this, switching languages leaves the previous
  // language's resume card and counters on screen under the new selection.
  loadHome();
});

$('modes').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  [...$('modes').children].forEach((b) => b.classList.toggle('on', b === btn));
  $('wish').placeholder = state.mode === 'lesson'
    ? '예: 과거형, 식당에서 쓰는 표현'
    : '예: 구직 면접, 병원 접수, 길 묻기';
  loadChips();
});

$('chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) startFromHome(btn.dataset.id);
});

$('btn-start').addEventListener('click', () => startFromHome());
$('btn-resume').addEventListener('click', resumeSession);
$('wish').addEventListener('keydown', (e) => { if (e.key === 'Enter') startFromHome(); });
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
  recognition.lang = BCP47[state.language];
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

// 봇 말풍선만이다. 내 말풍선의 클릭은 이미 되돌리기가 쓰고 있고(위 핸들러),
// 한 클릭에 두 동작을 얹으면 되돌리려다 소리가 나거나 그 반대가 된다.
// 대본 패널에는 되돌리기가 없으므로 거기서는 양쪽 줄 다 눌러 들을 수 있다.
$('conversation').addEventListener('click', (e) => {
  // 뜻 토글이 먼저다. renderTokens가 말풍선 안에도 '▸ 뜻' 버튼을 그리므로,
  // 대본 패널과 똑같이 여기서도 받아줘야 한다 -- 안 그러면 대화창의 뜻만
  // 눌러도 아무 일이 없는 반쪽짜리가 된다.
  const meaning = e.target.closest('button.meaning');
  if (meaning) {
    const bubble = meaning.closest('.msg.bot');
    toggleMeaning(bubble, bubble.querySelector('.meaning-body'));
    return;
  }
  const bubble = e.target.closest('.msg.bot');
  if (!bubble || e.target.closest('button')) return;
  play(bubble.dataset.audioKey || null, bubble.dataset.ja || bubble.textContent);
});

$('panel-body').addEventListener('click', (e) => {
  const meaning = e.target.closest('button.meaning');
  if (meaning) {
    const li = meaning.closest('li');
    toggleMeaning(li.querySelector('.line'), li.querySelector('.meaning-body'));
    return;
  }
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const line = state.scriptLines[Number(li.dataset.i)];
  if (line) play(line.audio_key, line.text);
});

loadChips();
refreshHealth();
loadHome();
loadReadingPrefs();

/* ---------- settings ---------- */

$('btn-settings').addEventListener('click', async () => {
  $('settings-language').value = state.language;
  await renderVoiceList();
  await loadReadingPrefs();
  $('settings').showModal();
});
$('settings-language').addEventListener('change', renderVoiceList);
$('btn-close-settings').addEventListener('click', () => $('settings').close());
$('voice-list').addEventListener('click', (e) => {
  const preview = e.target.dataset.preview;
  if (preview) previewVoice(preview);
});
$('reading-prefs').addEventListener('change', saveReadingPrefs);
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
