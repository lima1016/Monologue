import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL, next, controls } from './turnstate.js';

test('a full happy turn returns to idle', () => {
  let s = INITIAL;
  s = next(s, 'MIC');        assert.equal(s, 'listening');
  s = next(s, 'HEARD');      assert.equal(s, 'sending');
  s = next(s, 'REPLY');      assert.equal(s, 'speaking');
  s = next(s, 'AUDIO_DONE'); assert.equal(s, 'idle');
});

test('a failed recognition returns to idle without sending', () => {
  let s = next(INITIAL, 'MIC');
  s = next(s, 'HEARD_NOTHING');
  assert.equal(s, 'idle');
});

test('a failed send returns to idle so the learner can retry', () => {
  let s = next(next(INITIAL, 'MIC'), 'HEARD');
  assert.equal(next(s, 'SEND_FAILED'), 'idle');
});

test('undo runs from idle and comes back to idle', () => {
  assert.equal(next('idle', 'UNDO'), 'undoing');
  assert.equal(next('undoing', 'UNDO_DONE'), 'idle');
});

test('re-speaking is its own state so its result is not sent to the bot', () => {
  assert.equal(next('idle', 'RESPEAK'), 'respeaking');
  assert.equal(next('respeaking', 'HEARD'), 'idle');
  assert.equal(next('respeaking', 'HEARD_NOTHING'), 'idle');
});

test('an event with no transition leaves the state untouched', () => {
  // The guard that state.busy used to provide: a second MIC while already
  // sending must not start a second turn.
  assert.equal(next('sending', 'MIC'), 'sending');
  assert.equal(next('listening', 'MIC'), 'listening');
  assert.equal(next('undoing', 'UNDO'), 'undoing');
});

test('controls are disabled exactly while work is in flight', () => {
  assert.deepEqual(controls('idle'),
    { mic: true, send: true, undo: true, next: true, end: true, respeak: true });
  for (const busy of ['sending', 'undoing']) {
    const c = controls(busy);
    assert.equal(c.mic, false, `${busy} must not allow a new turn`);
    assert.equal(c.send, false);
    assert.equal(c.undo, false);
    assert.equal(c.next, false);
    assert.equal(c.respeak, false);
  }
});

test('the session can always be ended, even mid-flight', () => {
  // Trapping a learner in a hung turn with no way out is worse than an
  // interrupted request.
  for (const s of ['idle', 'listening', 'sending', 'speaking', 'undoing', 'respeaking']) {
    assert.equal(controls(s).end, true, `end must stay available in ${s}`);
  }
});

test('the mic is free again while the bot is still speaking', () => {
  assert.equal(controls('speaking').mic, true);
});
