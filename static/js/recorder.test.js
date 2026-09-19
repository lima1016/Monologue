/* recorder.js: the level test's microphone and its short clips. A leaf, so it
 * is driven here with nothing but its own fakes -- getUserMedia, a stream and
 * MediaRecorder -- and no DOM. */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { micAvailable, openMic, startRecording, stopRecording, closeMic } from './recorder.js';

let recorderMode = 'ok';   // 'ok' | 'throw-new' | 'throw-start' | 'no-data'
const recorders = [];
class FakeRecorder {
  constructor(stream) {
    if (recorderMode === 'throw-new') throw new Error('NotSupportedError');
    this.stream = stream; this.state = 'inactive'; this.listeners = {}; this.calls = [];
    recorders.push(this);
  }
  start() {
    if (recorderMode === 'throw-start') throw new Error('NotSupportedError');
    this.state = 'recording'; this.calls.push('start');
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  stop() {
    this.calls.push('stop');
    this.state = 'inactive';
    if (recorderMode !== 'no-data' && this.ondataavailable) this.ondataavailable({ data: 'chunk' });
    for (const fn of this.listeners.stop || []) fn();
  }
}

let micMode = 'ok';        // 'ok' | 'denied' | 'ended' | 'one-live'
function fakeStream() {
  const make = (state) => ({ stopped: false, readyState: state, stop() { this.stopped = true; } });
  const tracks = micMode === 'ended' ? [make('ended'), make('ended')]
    : micMode === 'one-live' ? [make('ended'), make('live')]
    : [make('live')];
  return { tracks, getTracks: () => tracks, getAudioTracks: () => tracks };
}
let lastStream = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => {
        if (micMode === 'denied') return Promise.reject(new Error('NotAllowedError'));
        lastStream = fakeStream();
        return Promise.resolve(lastStream);
      },
    },
  },
});

beforeEach(() => {
  recorderMode = 'ok';
  micMode = 'ok';
  lastStream = null;
  globalThis.MediaRecorder = FakeRecorder;
});

test('openMic hands back the stream when the microphone is granted', async () => {
  const mic = await openMic();
  assert.ok(mic);
  assert.equal(mic.stream, lastStream);
  assert.equal(micAvailable(), true);
});

test('openMic is null when the microphone is refused', async () => {
  micMode = 'denied';
  assert.equal(await openMic(), null);
});

test('openMic is null, and lets the stream go, when every audio track has ended', async () => {
  micMode = 'ended';
  assert.equal(await openMic(), null);
  assert.ok(lastStream.tracks.every((t) => t.stopped));
});

test('one live track among ended ones is still a microphone', async () => {
  micMode = 'one-live';
  assert.ok(await openMic());
});

test('openMic is null where the browser cannot record at all', async () => {
  delete globalThis.MediaRecorder;
  assert.equal(micAvailable(), false);
  assert.equal(await openMic(), null);
});

test('startRecording is null when the recorder throws -- from the constructor or from start()', async () => {
  const mic = await openMic();
  recorderMode = 'throw-new';
  assert.equal(startRecording(mic), null);
  recorderMode = 'throw-start';
  assert.equal(startRecording(mic), null);
});

test('startRecording is null on a stream that died after it was opened, without touching MediaRecorder', async () => {
  const mic = await openMic();
  mic.stream.tracks.forEach((t) => { t.readyState = 'ended'; });
  const before = recorders.length;
  assert.equal(startRecording(mic), null);
  assert.equal(recorders.length, before);
  assert.equal(startRecording(null), null);
});

test('stopRecording waits for the stop event and returns the clip as one Blob', async () => {
  const mic = await openMic();
  const handle = startRecording(mic);
  assert.deepEqual(handle.recorder.calls, ['start']);
  const blob = await stopRecording(handle);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 'chunk'.length);
  assert.deepEqual(handle.recorder.calls, ['start', 'stop']);
});

test('a recording with no data is null, not an empty Blob', async () => {
  const mic = await openMic();
  recorderMode = 'no-data';
  const handle = startRecording(mic);
  assert.equal(await stopRecording(handle), null);
  assert.equal(await stopRecording(null), null);
});

test('closeMic stops every track', async () => {
  const mic = await openMic();
  closeMic(mic);
  assert.ok(mic.stream.tracks.every((t) => t.stopped));
  closeMic(null);   // harmless
});
