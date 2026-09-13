/* audio.js의 취소 경로. dom-shim.js는 일부러 음성 API를 흉내 내지 않지만
   (그 경로는 `recognition`이 null인 브라우저를 본다), 취소가 옳은지는
   audio.js가 Chrome의 abort/onerror/onend 순서에 어떻게 반응하느냐에만
   달려 있다 -- session.test.js는 handleCancelled를 직접 부르므로
   cancelListening이 아무것도 안 하거나 들은 말을 넘겨도 초록으로 남는다.
   그래서 이 파일만 가짜 인식기와 녹음기를 깐다.

   audio.js는 불러오는 순간 setupRecognition()을 부르므로, 가짜는 그 전에
   window에 있어야 한다: dom-shim을 먼저 들이고, 가짜를 깔고, 그다음에
   동적으로 import한다. node --test는 파일마다 프로세스를 따로 쓰므로 이
   가짜가 다른 테스트 파일로 새지 않는다. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';

let rec = null;
class FakeRecognition {
  constructor() { this.calls = []; rec = this; }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
}
window.webkitSpeechRecognition = FakeRecognition;

class FakeRecorder {
  constructor(stream) { this.stream = stream; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  // 실제 MediaRecorder처럼 stop()이 마지막 dataavailable을 한 번 쏜다.
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: 'late' });
  }
}
globalThis.MediaRecorder = FakeRecorder;

/* getUserMedia를 테스트가 원하는 때에 풀 수 있게 한다. */
let pendingStream = null;
function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getTracks: () => tracks };
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => { pendingStream = resolve; }),
    },
  },
});

const audio = await import('./audio.js');

const finalResult = (transcript) => ({
  resultIndex: 0,
  results: [Object.assign([{ transcript }], { isFinal: true })],
});

let heard;
let cancelled;
beforeEach(() => {
  heard = [];
  cancelled = 0;
  audio.setHeardHandler((t) => heard.push(t));
  audio.setCancelHandler(() => { cancelled += 1; });
  state.recorder = null;
  state.chunks = [];
  $('notice').textContent = '';
  rec.calls = [];
});

test('cancelling aborts recognition rather than stopping it', () => {
  audio.beginListening();
  rec.onstart();
  audio.cancelListening();
  assert.ok(rec.calls.includes('abort'));
  assert.ok(!rec.calls.includes('stop'), 'stop()은 마지막 결과를 흘려보낸다');
  rec.onend();
});

test('the aborted error a cancel causes is not reported, and onend goes to the cancel handler', () => {
  audio.beginListening();
  rec.onstart();
  rec.onresult(finalResult('I want to'));
  audio.cancelListening();
  rec.onerror({ error: 'aborted' });
  assert.equal($('notice').textContent, '', '취소는 인식 실패가 아니다');
  rec.onend();
  assert.equal(cancelled, 1);
  assert.deepEqual(heard, [], '취소한 말은 턴이 되지 않는다');
});

test('a cancel leaves no chunks, even when the recorder fires one last dataavailable', () => {
  const recorder = new FakeRecorder(fakeStream());
  recorder.ondataavailable = (e) => state.chunks.push(e.data);
  recorder.start();
  state.recorder = recorder;
  state.chunks = ['early'];

  audio.beginListening();
  rec.onstart();
  audio.cancelListening();
  if (recorder.ondataavailable) recorder.ondataavailable({ data: 'later still' });
  rec.onend();
  assert.deepEqual(state.chunks, []);
});

test('a microphone granted after a cancel is closed and never becomes the recorder', async () => {
  const recording = audio.startRecording();
  audio.beginListening();
  rec.onstart();
  audio.cancelListening();

  // Before the cancel's onend: the cancel alone has to be enough.
  const stream = fakeStream();
  pendingStream(stream);
  await recording;
  assert.equal(state.recorder, null);
  assert.equal(stream.tracks[0].stopped, true, '마이크가 열린 채로 남는다');
  rec.onend();
});

test('a microphone granted after an ordinary stop is closed too', async () => {
  /* 짧게 말하고 바로 멈추면 getUserMedia보다 onend가 먼저 온다. 그때 녹음기가
     늦게 켜지면 그 소리가 다음(타이핑한) 턴에 붙는다. */
  const recording = audio.startRecording();
  audio.beginListening();
  rec.onstart();
  rec.onresult(finalResult('hello'));
  rec.onend();

  const stream = fakeStream();
  pendingStream(stream);
  await recording;
  assert.equal(state.recorder, null);
  assert.equal(stream.tracks[0].stopped, true);
  assert.deepEqual(heard, ['hello']);
});

test('discardRecording closes a recorder that started late and keeps none of its audio', async () => {
  /* main.js의 start()가 던지는 경로: 녹음은 아직 열리는 중이고, 그 턴은
     음성 없이 끝난다. 여기서 청크를 남기면 다음에 타이핑한 턴에 올라간다. */
  const recording = audio.startRecording();
  const stream = fakeStream();
  pendingStream(stream);
  await recording.then(audio.discardRecording);
  assert.equal(state.recorder.state, 'inactive');
  assert.deepEqual(state.chunks, []);
});

test('a cancel whose onend never arrives does not swallow the next listen', () => {
  audio.beginListening();
  rec.onstart();
  audio.cancelListening();
  // Chrome had no live session to abort, so no onerror and no onend come.

  audio.beginListening();
  rec.onstart();
  rec.onerror({ error: 'network' });
  assert.match($('notice').textContent, /network/, '다음 턴의 실패는 보여야 한다');

  audio.beginListening();
  rec.onstart();
  rec.onresult(finalResult('hello'));
  rec.onend();
  assert.deepEqual(heard, ['hello']);
  assert.equal(cancelled, 0);
});
