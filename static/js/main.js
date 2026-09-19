import { $, postJSON, notify, state } from './api.js';
import { play, stopPlayback, recognition, BCP47, startRecording, discardRecording, setRespeakHandler, beginListening } from './audio.js';
import { refreshHealth, sendTurn, nextScriptLine, endSession, undoLastTurn,
         setTurnState, canDo, cancelTurn, escapeCancels } from './session.js';
import { loadHome, resumeSession, swapToday, changeGoal, playReviewHome } from './home.js';
import { openPick, loadThemes, selectCategory, selectTheme, selectScenario,
         startFromPick, startTheme, syncLanguageButtons,
         selectQuestion, retryQuestions, onOwnInput } from './pick.js';
import { renderVoiceList, previewVoice, loadReadingPrefs, saveReadingPrefs, syncLanguageSections } from './settings.js';
import { toggleMeaning } from './reading.js';
import { suggestForLatest } from './suggest.js';
import { openMypage, leaveMypage, onReviewClick, onHistoryClick, loadHistory,
         selectTab, onTabKey, onTagClick, loadCoach, showMoreReviews } from './mypage.js';
import { replay, replaySlow, peek, mine, retry, nextLine, shadowState } from './shadow.js';
import { leaveTimed, startNow, stopNow, retryTranscribe, again, endTimed, playMine,
         playNative, retryNative } from './timed.js';
import * as router from './router.js';

/* ---------- screens ---------- */

router.register('home', 'home');
router.register('pick', 'pick');
router.register('session', 'session');
router.register('report', 'report');
router.register('mypage', 'mypage');
router.register('timed', 'timed');
router.show('home');

/* ---------- wiring ---------- */

/* What every way off a screen cleans up first. 1분 말하기 is the one screen with
   a live microphone and a clock of its own: a minute still recording is
   dropped (never uploaded) and its timers stop. A no-op anywhere else. */
function leaving() {
  leaveTimed();
}

/* Home, pick and my page each carry a language segment; all are the one
   state.language, so they share this handler and are kept in step by
   syncLanguageButtons. */
function switchLanguage(e) {
  const btn = e.target.closest('button[data-language]');
  if (!btn) return;
  state.language = btn.dataset.language;
  syncLanguageButtons();
  refreshHealth();
  // Themes, the resume card and the counters are all scoped by language:
  // without a reload the previous language's stay on screen under the new
  // selection. Only the visible screen reloads -- ← 홈 calls loadHome anyway.
  if (router.current() === 'pick') loadThemes();
  else if (router.current() === 'mypage') openMypage();
  else loadHome();
}
$('language-seg').addEventListener('click', switchLanguage);
$('pick-language-seg').addEventListener('click', switchLanguage);
$('mypage-language-seg').addEventListener('click', switchLanguage);

/* ---------- my page ---------- */

// Arrow functions, not openMypage itself: it takes { tab }, and a click
// handler's first argument is the Event.
$('btn-mypage').addEventListener('click', () => {
  leaving();
  openMypage();
});
$('btn-mypage-home').addEventListener('click', () => {
  leaveMypage();
  loadHome();
});
$('mypage-tabs').addEventListener('click', (e) => {
  // closest, so a press on 복습's count (#tab-review-n) still finds its tab.
  const tab = e.target.closest?.('[role="tab"]');
  if (tab) selectTab(tab.dataset.tab);
});
$('mypage-tabs').addEventListener('keydown', onTabKey);
$('review-list').addEventListener('click', onReviewClick);
$('btn-review-more').addEventListener('click', () => showMoreReviews());
$('history-list').addEventListener('click', onHistoryClick);
$('tag-bars').addEventListener('click', onTagClick);
$('coach-body').addEventListener('click', (e) => { if (e.target.closest('.coach-retry')) loadCoach({ force: true }); });
$('btn-history-more').addEventListener('click', () => loadHistory({ append: true }));
$('btn-report-back').addEventListener('click', () => {
  router.show('mypage');
  $('btn-report-back').hidden = true;
});

$('modes').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) openPick(btn.dataset.mode);
});

/* 오늘의 추천 and 최근 테마 both start a theme in one press. Wired here, not in
   home.js: home.js importing pick.js would close an import cycle. */
function startThemeButton(e) {
  const btn = e.target.closest('button[data-mode][data-theme]');
  if (btn && !btn.disabled) startTheme(btn.dataset.mode, btn.dataset.theme);
}
$('today-body').addEventListener('click', startThemeButton);
$('recent-themes').addEventListener('click', startThemeButton);
$('today-alt').addEventListener('click', (e) => {
  if (e.target.closest('button')) swapToday();
});
$('goal-minus').addEventListener('click', () => changeGoal(-1));
$('goal-plus').addEventListener('click', () => changeGoal(+1));
$('week-more').addEventListener('click', () => openMypage({ tab: 'history' }));

/* 오늘 복습: 듣기 does not navigate -- playReviewHome handles the swap to
   음성 준비 중... itself. 복습하러 가기 and 기록 더 보기 both just open my page;
   home.js must not import mypage.js (cycle), so this is wired here. */
$('review-home-play').addEventListener('click', playReviewHome);
$('review-home-go').addEventListener('click', () => openMypage({ tab: 'review' }));

$('notice-close').addEventListener('click', () => notify(''));

$('btn-home').addEventListener('click', () => {
  leaving();
  router.show('home');
  loadHome();
});

/* 1분 말하기's card. Arrow functions: a click handler's first argument is the
   Event, and startNow/stopNow take the stage event they raise. */
$('btn-timed-home').addEventListener('click', () => {
  leaving();
  router.show('home');
  loadHome();
});
$('timed-start').addEventListener('click', () => startNow());
$('timed-stop').addEventListener('click', () => stopNow());
$('timed-retry-btn').addEventListener('click', () => retryTranscribe());
$('timed-native-play').addEventListener('click', () => playNative());
$('timed-native-retry').addEventListener('click', () => retryNative());
$('timed-mine').addEventListener('click', () => playMine());
$('timed-again').addEventListener('click', () => again());
$('timed-end').addEventListener('click', () => endTimed());

$('category-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-category]');
  if (btn) selectCategory(btn.dataset.category);
});

$('theme-grid').addEventListener('click', (e) => {
  const theme = e.target.closest('button[data-theme]');
  if (theme) { selectTheme(theme.dataset.theme); return; }
  const own = e.target.closest('button[data-scenario]');
  if (own) selectScenario(own.dataset.scenario);
});

/* 1분 말하기's questions: a card chooses, 다시 시도 asks again, and the field
   under them is the learner's own question (Enter starts, as #wish does). */
$('pick-question-list').addEventListener('click', (e) => {
  const card = e.target.closest('button[data-question]');
  if (card && !card.disabled) selectQuestion(Number(card.dataset.question));
});
$('pick-question-retry').addEventListener('click', retryQuestions);
$('pick-own').addEventListener('input', onOwnInput);
$('pick-own').addEventListener('keydown', (e) => { if (e.key === 'Enter') startFromPick(); });

$('btn-start').addEventListener('click', startFromPick);
$('btn-resume').addEventListener('click', resumeSession);
$('wish').addEventListener('keydown', (e) => { if (e.key === 'Enter') startFromPick(); });
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
$('btn-cancel').addEventListener('click', cancelTurn);
// Esc cancels a live listen; session.js's escapeCancels says when it must not.
document.addEventListener('keydown', (e) => {
  if (escapeCancels(e)) {
    e.preventDefault();
    cancelTurn();
  }
});
$('btn-mic').addEventListener('click', () => {
  if (canDo('stop')) {
    // Ends the turn: recognition.stop() lets Chrome flush any last final
    // result, then fires onend, which delivers to handleHeard and raises
    // HEARD, HEARD_AUDIO, or HEARD_NOTHING there -- not here. Two places calling
    // setTurnState for the same recognition session is exactly what
    // turnstate.js's header comment warns against; this button only ever
    // asks for the stop, never decides what state it leads to.
    recognition.stop();
    return;
  }
  if (!recognition) {
    // Shadowing hides the input: there is no typing a line instead of saying it.
    notify(state.shadowing
      ? '이 브라우저는 음성 인식을 지원하지 않아 쉐도잉을 할 수 없어요. Chrome에서 열어 주세요.'
      : '이 브라우저는 음성 인식을 지원하지 않습니다. 아래 입력창에 직접 입력하세요.');
    return;
  }
  notify('');
  // The microphone must hear the learner, not a clip still playing -- in
  // shadowing that clip is the very line being judged. Before MIC: a bot reply
  // cut off here raises its AUDIO_DONE while the turn is still `speaking`.
  stopPlayback();
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
    beginListening();
  } catch (err) {
    // e.g. an InvalidStateError from a recognition that's already running.
    // onend never fires when start() itself throws, so nothing would
    // otherwise return the machine from `listening` -- HEARD_NOTHING does
    // the same thing a real "heard nothing" result would. startRecording()
    // is async and un-awaited above, so the stream/recorder it opens may not
    // exist yet -- stop it once that promise actually settles, or the mic
    // stays open until the next startRecording() call replaces it. Discard,
    // not stop: this turn has no utterance, and chunks left behind would be
    // uploaded with whatever the learner types next.
    recording.then(discardRecording);
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
  // 뜻 토글이 먼저다. renderTokens가 말풍선과 추천 줄 안에도 '▸ 뜻' 버튼을
  // 그리므로, 대본 패널과 똑같이 여기서도 받아줘야 한다.
  const meaning = e.target.closest('button.meaning');
  if (meaning) {
    const host = meaning.closest('.msg.bot, .suggest-line');
    if (host) toggleMeaning(host, host.querySelector('.meaning-body'));
    return;
  }
  // 추천 줄은 들을 수만 있다. 키가 없으면(TTS가 죽어 있었음) 브라우저 음성.
  const reply = e.target.closest('.suggest-line');
  if (reply) {
    play(reply.dataset.audioKey || null, reply.dataset.source);
    return;
  }
  const bubble = e.target.closest('.msg.bot');
  if (!bubble || e.target.closest('button')) return;
  // No key means nothing to play, not a failed synthesis -- a resumed bubble
  // never had a TTS key of its own attempted on it (GET /sessions/{id} only
  // ever hands back a key for a clip already on disk). Calling play(null,
  // ...) here would tell the learner "서버 음성 생성에 실패해" for a clip that
  // was never asked for, and fall them back to browser speech for nothing.
  if (!bubble.dataset.audioKey) return;
  // dataset.source, not textContent: a bubble with a meaning toggle also holds
  // the button's label and, once opened, the Korean meaning.
  play(bubble.dataset.audioKey, bubble.dataset.source || bubble.textContent);
});
$('btn-suggest').addEventListener('click', suggestForLatest);

/* Shadowing's line card: one listener for every button on it. While a line
   saves none of them applies -- the attempt being saved is this line's, and
   다음 or 다시 하기 would move the card out from under its verdict. */
const SHADOW_ACTIONS = {
  replay, slow: replaySlow, peek, native: replay, mine, retry, next: nextLine,
};
$('shadow-card').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-shadow]');
  if (!btn || btn.disabled || shadowState().saving) return;
  const action = SHADOW_ACTIONS[btn.dataset.shadow];
  if (action) action();
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

refreshHealth();
loadHome();
loadReadingPrefs();

/* ---------- settings ---------- */

$('btn-settings').addEventListener('click', async () => {
  $('settings-language').value = state.language;
  syncLanguageSections();
  await renderVoiceList();
  await loadReadingPrefs();
  $('settings').showModal();
});
$('settings-language').addEventListener('change', () => {
  syncLanguageSections();
  renderVoiceList();
});
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
