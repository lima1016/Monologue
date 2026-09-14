/* startScript builds the script panel's HTML by interpolating each line's
 * text directly into innerHTML. Scenario text now comes from a local LLM
 * (POST /scenarios/generate), so a script line is no longer necessarily
 * something this codebase wrote -- it must be escaped the same way
 * renderTokens (reading.js) already escapes every token it draws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

/* A fake SpeechRecognition, installed before session.js (and, transitively,
 * audio.js) is ever evaluated -- mirrors audio.test.js's own fake, and for
 * the same reason: without one, `recognition` comes back null (a real,
 * mic-less browser is dom-shim's default -- see its own header comment), and
 * `startRespeak` bails out on its `if (!recognition)` guard before ever
 * touching `activeRespeak` or the turn state machine. The re-speak-ends-via-
 * the-big-mic bug below cannot be driven at all without this.
 *
 * `session.js` is therefore imported dynamically, after this is installed on
 * `window` -- a plain top-level `import` is hoisted and would evaluate
 * audio.js (and cache its `recognition` as null) before this file's own code
 * had a chance to run. */
let rec = null;
class FakeRecognition {
  constructor() { this.calls = []; rec = this; }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
}
window.webkitSpeechRecognition = FakeRecognition;

const session = await import('./session.js');
const { startSession, nextScriptLine, endSession } = session;

test('a script line with HTML-like text is escaped, not injected, into the panel', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en'; // avoid the ja-only annotate() round trip; irrelevant to escaping
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [{ speaker: 'bot', text: '<img src=x onerror=alert(1)>' }],
      });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 's1' });

  const html = $('panel-body').innerHTML;
  assert.doesNotMatch(html, /<img/, 'raw HTML from a script line must not reach innerHTML unescaped');
  assert.match(html, /&lt;img/);
});

/* Fix 1: advanceScript plays a bot line's audio and draws its bubble at the
 * same moment. Before this fix the bubble was drawn a beat later, only when
 * the learner pressed next -- what they heard was never what the chat log
 * showed at the time they heard it. */
test('a bot script line gets its bubble the same moment its audio would play', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [
          { speaker: 'bot', text: 'Morning! Ready for standup?', audio_key: 'k0' },
          { speaker: 'user', text: "Yeah, give me a sec. Okay, I'm ready." },
        ],
      });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'standup-meeting-en' });

  const bubbles = $('conversation').children.filter((n) => n.className === 'msg bot');
  assert.equal(bubbles.length, 1, 'the opening bot line must already be drawn, not deferred to next');
  assert.equal(bubbles[0].textContent, 'Morning! Ready for standup?');
  assert.equal(bubbles[0].dataset.audioKey, 'k0');
});

test('advancing past a bot line does not draw a second bubble for it', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [
          { speaker: 'bot', text: 'Morning!', audio_key: 'k0' },
          { speaker: 'user', text: 'Hi.' },
        ],
      });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  await nextScriptLine(); // learner presses "next" past the bot's line

  const botBubbles = $('conversation').children.filter((n) => n.className === 'msg bot');
  assert.equal(botBubbles.length, 1, 'the bot line must be drawn exactly once, not twice');
});

test('drawing a bot script line stores it, keyed by its own index', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const stored = [];
  stubFetch(async (url, options) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 42,
        mode: 'script',
        lines: [{ speaker: 'bot', text: 'Morning!', audio_key: 'k0' }],
      });
    }
    if (url === '/api/sessions/42/script-line') {
      stored.push(JSON.parse(options.body));
      return jsonResponse({ stored: true });
    }
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });

  assert.deepEqual(stored, [{ index: 0 }]);
});

test('a failed script-line store does not interrupt the session', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 1,
        mode: 'script',
        lines: [{ speaker: 'bot', text: 'Morning!', audio_key: 'k0' }],
      });
    }
    if (url === '/api/sessions/1/script-line') return jsonResponse({}, { ok: false, status: 500 });
    return jsonResponse({});
  });

  // Must not throw or reject -- the bubble is already drawn and that is the
  // contract, the same as reading.js's annotate().
  await assert.doesNotReject(
    startSession({ language: 'en', mode: 'script', scenarioId: 'x' }),
  );
  assert.equal($('conversation').children.filter((n) => n.className === 'msg bot').length, 1);
});

/* Fix 3: the learner's script turn posts to /script-turn, not /chat -- no LLM
 * reply to invent, no grammar feedback to render. */
test('a script turn is sent to /script-turn, not /chat', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const calls = [];
  stubFetch(async (url, options) => {
    calls.push(url);
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 7,
        mode: 'script',
        lines: [{ speaker: 'user', text: 'Hello.' }],
      });
    }
    if (url === '/api/script-turn') return jsonResponse({ turn: 1 });
    return jsonResponse({});
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  $('text-input').value = 'Hello.';
  await nextScriptLine();

  assert.ok(calls.includes('/api/script-turn'), 'must post to /script-turn');
  assert.ok(!calls.includes('/api/chat'), 'must not post to /chat');
});

test('reading the script line correctly shows a good accuracy result', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 7,
        mode: 'script',
        lines: [{ speaker: 'user', text: 'Hello there.' }],
      });
    }
    return jsonResponse({ turn: 1 });
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  $('text-input').value = 'hello there'; // matches() ignores case/punctuation
  await nextScriptLine();

  const result = $('conversation').children.find((n) => n.className.includes('respeak-result'));
  assert.ok(result, 'an accuracy result must be rendered under the learner bubble');
  assert.ok(result.className.includes('good'));
});

test('reading the script line differently shows the script original, not a grammar chip', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  stubFetch(async (url) => {
    if (url === '/api/sessions') {
      return jsonResponse({
        session_id: 7,
        mode: 'script',
        lines: [{ speaker: 'user', text: 'Hello there.' }],
      });
    }
    return jsonResponse({ turn: 1 });
  });

  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  $('text-input').value = 'This is something completely different.';
  await nextScriptLine();

  const result = $('conversation').children.find((n) => n.className.includes('respeak-result'));
  assert.ok(result);
  assert.ok(result.className.includes('bad'));
  assert.match(result.textContent, /Hello there\./, 'must show the script line itself, not just "wrong"');
  // Not a grammar chip -- there is nothing to correct, the learner read the line.
  assert.equal($('conversation').children.some((n) => n.className.includes('chip')), false);
});

/* Fix 2 (fix round) -- a script session stores ok=None on every learner turn
 * by design, so s.wrong is always 0 and s.ungraded always equals s.turns.
 * The free-mode report line ("교정을 받지 못한 발화 N회") exists to flag a
 * genuine grading outage; reused for script mode it would appear on every
 * single script report and read as the app having broken. */
test('a script session report does not use the free-mode grading-failure wording', async () => {
  resetDom();
  router.register('session', 'session');
  router.register('report', 'report');
  state.mode = 'script';
  state.sessionId = 1;
  stubFetch(async (url) => {
    if (url === '/api/sessions/1/end') {
      return jsonResponse({
        summary: '요약', weak_points: [], expressions: [], next_focus: '',
        stats: { turns: 4, wrong: 0, ungraded: 4, sentences: [] },
      });
    }
    return jsonResponse({});
  });

  await endSession();

  const text = $('report-counts').textContent;
  assert.match(text, /말한 횟수 4/);
  assert.doesNotMatch(
    text, /교정을 받지 못한 발화/,
    'a by-design ungraded script session must not read as a grading failure',
  );
});

test('a free session with a genuine grading failure still reports it', async () => {
  resetDom();
  router.register('session', 'session');
  router.register('report', 'report');
  state.mode = 'free';
  state.sessionId = 1;
  stubFetch(async (url) => {
    if (url === '/api/sessions/1/end') {
      return jsonResponse({
        summary: '요약', weak_points: [], expressions: [], next_focus: '',
        stats: { turns: 3, wrong: 0, ungraded: 2, sentences: [] },
      });
    }
    return jsonResponse({});
  });

  await endSession();

  const text = $('report-counts').textContent;
  assert.match(
    text, /교정을 받지 못한 발화 2회/,
    'a real grading outage in free mode must still be visible, not silently dropped',
  );
});

/* Task 7: the headline is assembled from counts the app already has, and
 * script mode gets its own phrasing -- same reason the counts line above
 * already forks (script sessions store ok=None on every turn by design). */
test('대본 세션의 헤드라인은 턴이 아니라 줄을 센다', () => {
  resetDom();
  state.mode = 'script';
  session.renderReport({ summary: 'x', stats: { turns: 8, wrong: 0, minutes: 3 } });
  assert.equal($('report-headline').textContent, '대본 8줄을 읽었어요.');
  // 대본 세션은 문법 교정을 하지 않으므로 "0 고침"이 아니라 '—' -- 0은
  // 완벽하게 읽었다는 뜻으로 오해된다.
  assert.equal($('rep-wrong').textContent, '—');
});

test('자유 세션의 헤드라인', () => {
  resetDom();
  state.mode = 'free';
  session.renderReport({ summary: 'x', stats: { turns: 12, wrong: 5, minutes: 9 } });
  assert.equal($('report-headline').textContent, '오늘 12턴을 주고받았어요.');
  assert.equal($('rep-wrong').textContent, '5');
});

test('an English bot bubble carries a meaning toggle; a learner bubble does not', () => {
  resetDom();
  state.language = 'en';
  const bot = session.addMessage('bot', 'Welcome back!');
  const me = session.addMessage('user', 'Thanks.');
  assert.ok(bot.childNodes.some((n) => n.className === 'meaning'), '봇 말풍선에 ▸ 뜻 버튼이 없다');
  assert.equal(bot.dataset.source, 'Welcome back!');
  assert.ok(!me.childNodes.some((n) => n.className === 'meaning'));
});

test('Esc cancels a listen, but not while the settings dialog is open or an IME is composing', () => {
  /* 설정 창의 Esc는 창을 닫는 키다. 여기서 preventDefault로 가로채면 창이
     안 닫히고 녹음만 사라진다. 일본어 IME의 Esc는 변환을 취소하는 키다. */
  resetDom();
  session.setTurnState('MIC');
  assert.equal(session.escapeCancels({ key: 'Escape', isComposing: false }), true);
  assert.equal(session.escapeCancels({ key: 'Enter', isComposing: false }), false);
  assert.equal(session.escapeCancels({ key: 'Escape', isComposing: true }), false);
  $('settings').open = true;
  assert.equal(session.escapeCancels({ key: 'Escape', isComposing: false }), false);
  $('settings').open = false;
  session.setTurnState('CANCEL');
  assert.equal(session.escapeCancels({ key: 'Escape', isComposing: false }), false);
});

test('cancelling a listen returns to idle, hides the cancel button, and sends nothing', async () => {
  resetDom();
  const requests = [];
  stubFetch(async (url) => { requests.push(url); return jsonResponse({}); });

  session.setTurnState('MIC');
  assert.equal($('btn-cancel').hidden, false, '듣는 동안 취소 버튼이 보여야 한다');

  session.handleCancelled();
  assert.equal($('btn-cancel').hidden, true);
  assert.equal(session.canDo('send'), true, '취소 뒤에는 바로 다시 말하거나 입력할 수 있어야 한다');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(requests, [], '취소한 발화가 서버로 가면 안 된다');
});

/* Whisper 최종 받아쓰기. 브라우저 인식은 미리보기이고, 턴은 받아쓴 문장으로 간다.
   실패하면 브라우저 문장으로 -- 연습이 막히면 안 된다. */
async function openFree(extraRoutes = {}) {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const chats = [];
  const transcribes = [];
  stubFetch(async (url, options) => {
    if (url === '/api/sessions') {
      // The fields startSession actually reads for a free session.
      return jsonResponse({ session_id: 5, mode: 'free', opening: 'Hi.', opening_audio: null, goal: null });
    }
    if (url === '/api/transcribe') {
      transcribes.push(options.body);
      return extraRoutes.transcribe ? extraRoutes.transcribe(options) : jsonResponse({ text: 'I went there yesterday.' });
    }
    if (url === '/api/chat') {
      chats.push(JSON.parse(options.body).text);
      return jsonResponse({ bot_reply: 'Nice.', audio_key: null, ok: true, fixed: '', tag: '없음', correction: '', suggestion: '' });
    }
    return jsonResponse({});
  });
  await startSession({ language: 'en', mode: 'free', scenarioId: 'x' });
  return { chats, transcribes };
}
const clip = () => Promise.resolve(new Blob(['audio']));

test('a turn is sent as Whisper heard it, not as the browser did', async () => {
  const { chats, transcribes } = await openFree();
  session.setTurnState('MIC');
  await session.handleHeard('I go there yesterday', clip());
  assert.equal(transcribes.length, 1);
  assert.deepEqual(chats, ['I went there yesterday.']);
});

test('when Whisper is unavailable the browser transcript is sent', async () => {
  const { chats } = await openFree({ transcribe: () => jsonResponse({ detail: 'loading' }, { ok: false, status: 503 }) });
  session.setTurnState('MIC');
  await session.handleHeard('I go there yesterday', clip());
  assert.deepEqual(chats, ['I go there yesterday']);
});

test('silence from Whisper falls back to what the browser heard', async () => {
  const { chats } = await openFree({ transcribe: () => jsonResponse({ text: '' }) });
  session.setTurnState('MIC');
  await session.handleHeard('I go there', clip());
  assert.deepEqual(chats, ['I go there']);
});

test('nothing from either returns to idle without sending', async () => {
  const { chats } = await openFree({ transcribe: () => jsonResponse({ text: '' }) });
  session.setTurnState('MIC');
  await session.handleHeard(null, clip());
  assert.deepEqual(chats, []);
  assert.equal(session.canDo('send'), true);
});

test('with no recording Whisper is not asked', async () => {
  const { chats, transcribes } = await openFree();
  session.setTurnState('MIC');
  await session.handleHeard('I go there', Promise.resolve(null));
  assert.equal(transcribes.length, 0);
  assert.deepEqual(chats, ['I go there']);
});

test('cancelling while Whisper works drops the late result', async () => {
  const releases = [];
  const { chats } = await openFree({
    transcribe: () => new Promise((resolve) => { releases.push((text) => resolve(jsonResponse({ text }))); }),
  });
  session.setTurnState('MIC');
  const pending = session.handleHeard('browser', clip());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('btn-cancel').hidden, false, '받아쓰는 중에도 취소할 수 있어야 한다');
  session.cancelTurn();
  assert.equal(session.canDo('send'), true);

  // A second turn is already transcribing when the first one's answer
  // arrives. Only the generation tells the two apart -- the state alone is
  // `transcribing` for both.
  session.setTurnState('MIC');
  const second = session.handleHeard('browser two', clip());
  await new Promise((r) => setTimeout(r, 0));
  releases[0]('late');
  await pending;
  releases[1]('second');
  await second;
  assert.deepEqual(chats, ['second'], '취소한 뒤 도착한 받아쓰기로 턴이 생기면 안 된다');
});

test('ending the session while Whisper works drops the late result', async () => {
  let release;
  router.register('report', 'report');
  const { chats } = await openFree({
    transcribe: () => new Promise((resolve) => { release = () => resolve(jsonResponse({ text: 'late' })); }),
  });
  session.setTurnState('MIC');
  const pending = session.handleHeard('browser', clip());
  await new Promise((r) => setTimeout(r, 0));
  await endSession();
  release();
  await pending;
  assert.deepEqual(chats, [], '끝난 세션에 턴이 들어가면 안 된다');
  assert.equal(session.canDo('send'), true, '다음 세션이 받아쓰는 중에 묶여 있으면 안 된다');
});

test('a transcription that takes too long gives way to the browser transcript', async () => {
  const { chats } = await openFree({
    transcribe: (options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  session.setTranscribeTimeout(5);
  try {
    session.setTurnState('MIC');
    await session.handleHeard('I go there', clip());
  } finally {
    session.setTranscribeTimeout(8000);
  }
  assert.deepEqual(chats, ['I go there']);
});

test('a recording that failed to finish counts as no recording', async () => {
  const { chats, transcribes } = await openFree();
  session.setTurnState('MIC');
  await session.handleHeard('browser', Promise.reject(new Error('x')));
  assert.equal(transcribes.length, 0);
  assert.deepEqual(chats, ['browser']);
});

test('hearing nothing throws the silent recording away', async () => {
  await openFree({ transcribe: () => jsonResponse({ text: '' }) });
  session.setTurnState('MIC');
  state.chunks = [new Blob(['silence'])];
  await session.handleHeard(null, clip());
  assert.deepEqual(state.chunks, [], '다음에 입력한 턴에 조용한 녹음이 붙어 올라가면 안 된다');
});

test('a script line is read back as Whisper heard it', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const turns = [];
  stubFetch(async (url, options) => {
    if (url === '/api/sessions') {
      return jsonResponse({ session_id: 8, mode: 'script', lines: [{ speaker: 'user', text: 'Hello there.' }] });
    }
    if (url === '/api/transcribe') return jsonResponse({ text: 'Hello their.' });
    if (url === '/api/script-turn') { turns.push(JSON.parse(options.body).text); return jsonResponse({ turn: 1 }); }
    return jsonResponse({});
  });
  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  session.setTurnState('MIC');
  await session.handleHeard('hello dare', clip());
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(turns, ['Hello their.'], 'Whisper가 들은 대로 -- 대본 문장이 아니라');
});

/* 리포트는 로컬 모델이 10~20초에 걸쳐 쓴다. 그동안 화면이 그대로면 버튼이
   눌렸는지조차 알 수 없다 -- 실제로 여러 번 눌러도 반응이 없다는 말이 나왔다. */
function pendingEnd() {
  let finish;
  stubFetch((url) => {
    if (url === '/api/sessions/9/end') {
      return new Promise((resolve) => { finish = resolve; });
    }
    return Promise.resolve(jsonResponse({}));
  });
  return (response) => finish(response);
}

test('while the report is being written the learner sees that it is', async () => {
  resetDom();
  router.register('session', 'session');
  router.register('report', 'report');
  state.mode = 'free';
  state.sessionId = 9;
  const finish = pendingEnd();
  // dom-shim does not read index.html's hidden attribute; start from the real first state.
  $('report-wait').hidden = true;

  const ending = endSession();
  assert.equal($('report-wait').hidden, false, '리포트를 만드는 동안 표시가 보여야 한다');
  assert.equal($('btn-end').textContent, '리포트 만드는 중…');

  finish(jsonResponse({ summary: '요약', weak_points: [], expressions: [], next_focus: '',
    stats: { turns: 2, wrong: 0, ungraded: 0, sentences: [] } }));
  await ending;
  assert.equal($('report-wait').hidden, true);
  assert.equal($('btn-end').textContent, '세션 끝내기');
});

test('a failed report takes the waiting card down and says so', async () => {
  resetDom();
  router.register('session', 'session');
  router.register('report', 'report');
  state.mode = 'free';
  state.sessionId = 9;
  const finish = pendingEnd();

  const ending = endSession();
  finish(jsonResponse({ detail: 'model down' }, { ok: false, status: 503 }));
  await ending;
  assert.equal($('report-wait').hidden, true, '실패하면 표시를 내리고 다시 누를 수 있어야 한다');
  assert.equal($('btn-end').textContent, '세션 끝내기');
  assert.match($('notice').textContent, /리포트 생성 실패/);
});

/* The pulsing-mic-does-nothing bug: syncControls disabled #btn-mic through
 * the whole of `respeaking`, even though the mic visibly pulses then (the
 * `listening` class is shared by `listening` and `respeaking`) and the
 * learner has no other way to end a re-speak than the chip's own
 * `그만 말하기` button. Only one re-speak can ever be active (startRespeak's
 * own `activeRespeak.btn === btn` guard), so there is no ambiguity about
 * whose session the big mic would be ending -- it may end it too.
 *
 * main.js's own `$('btn-mic')` click handler is not exercised here (main.js
 * pulls in home.js/settings.js, which hit the network at import time) -- it
 * already calls `recognition.stop()` whenever `canDo('stop')` is true, and
 * `canDo('stop')` is true in `respeaking` the same as in `listening`
 * (turnstate.js), so once the button is no longer disabled, pressing it ends
 * the re-speak exactly like the chip's own button does. That much is
 * confirmed by reading, not by a test -- the `canDo('stop')` assertion below
 * is what main.js's handler itself checks before calling recognition.stop(). */
const respeakFinal = (transcript) => ({
  resultIndex: 0,
  results: [Object.assign([{ transcript }], { isFinal: true })],
});

test('the big mic is pressable the instant a re-speak starts, before anything is heard', () => {
  resetDom();
  rec.calls = [];
  const btn = document.createElement('button');
  const result = document.createElement('p');

  session.startRespeak('Hello there.', result, btn);
  rec.onstart();
  // No onresult at all yet -- a learner who presses the chip and immediately
  // wants to stop (or who stays silent) must not find the big mic dead. This
  // is the moment startRespeak itself sets `activeRespeak`; syncControls must
  // already reflect it here, not only once some later event (an interim
  // result) happens to call syncControls again.

  assert.equal($('btn-mic').disabled, false,
    '재발화가 시작된 순간부터 큰 마이크를 눌러 끝낼 수 있어야 한다 (아직 아무것도 못 들었어도)');
  assert.equal($('btn-mic').classList.contains('listening'), true, '펄스는 원래도 돌고 있었다');
  // What main.js's own mic handler actually checks before calling
  // recognition.stop() -- the disabled check above is the DOM's reflection
  // of this, but this is the authority syncControls itself reads.
  assert.equal(session.canDo('stop'), true, '누르면 main.js가 recognition.stop()을 부를 수 있어야 한다');

  // Let this re-speak finish so it does not bleed into the next test.
  rec.onresult(respeakFinal('Hello there.'));
  rec.onend();
});

test('once Whisper is transcribing the re-speak, the big mic goes dead again', async () => {
  resetDom();
  rec.calls = [];
  const btn = document.createElement('button');
  const result = document.createElement('p');

  session.startRespeak('Hello there.', result, btn);
  rec.onstart();
  rec.onresult(respeakFinal('Hello there.'));
  // onend runs the re-speak handler synchronously up to its first await --
  // by the time control returns here, `transcribingRespeak` is set,
  // `activeRespeak` is already cleared, and syncControls has already run
  // reflecting both.
  rec.onend();

  assert.equal($('btn-mic').disabled, true,
    '받아쓰는 동안에는 끝낼 대상이 없으니 다시 죽어 있어야 한다');

  // Let the pending transcript resolve before the next test reuses `rec`.
  await new Promise((r) => setTimeout(r, 0));
});

test('a session that could not be created says so in the same voice as the pick screen', async () => {
  resetDom();
  router.register('home', 'home');
  router.register('session', 'session');
  stubFetch(async (url) => {
    if (url === '/api/sessions') return jsonResponse({ detail: 'boom' }, { ok: false, status: 500 });
    return jsonResponse({});
  });
  await startSession({ language: 'en', mode: 'free', scenarioId: 'x' });
  assert.match($('notice').textContent, /^세션을 시작하지 못했어요: /);
});
