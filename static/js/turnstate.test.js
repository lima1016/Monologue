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

test('every state pins exactly which controls are live', () => {
  const T = { mic: true,  send: true,  undo: true,  next: true,  respeak: true,  end: true, stop: false };
  const S = { mic: true,  send: true,  undo: false, next: false, respeak: false, end: true, stop: false };
  const F = { mic: false, send: false, undo: false, next: false, respeak: false, end: true, stop: false };

  assert.deepEqual(controls('idle'), T);
  // Interactive, not in-flight: the learner may answer over the bot's clip,
  // but not undo the turn it belongs to or re-speak into it.
  assert.deepEqual(controls('speaking'), S);
  // listening and respeaking are both F's shape with one exception: `stop`
  // is the only way to end a turn now that nothing sends on a timer
  // (utterance.js) -- pressing the mic again while listening, or the active
  // re-speak button while respeaking, has to be live, or a learner could
  // never finish without Chrome finalising on its own (and for respeak,
  // "finalising on its own" mid-phrase is a false negative on the very
  // sentence the learner is trying to get right).
  assert.deepEqual(controls('listening'), { ...F, stop: true });
  assert.deepEqual(controls('sending'), F);
  assert.deepEqual(controls('undoing'), F);
  assert.deepEqual(controls('respeaking'), { ...F, stop: true });
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

test('every enabled control has a transition that answers it', () => {
  // The bug this file exists to prevent: a button that renders live and does
  // nothing because the machine has no transition for it.
  const EVENT = { mic: 'MIC', send: 'SEND', undo: 'UNDO', respeak: 'RESPEAK' };
  for (const state of ['idle', 'listening', 'sending', 'speaking', 'undoing', 'respeaking']) {
    const c = controls(state);
    for (const [control, event] of Object.entries(EVENT)) {
      if (!c[control]) continue;
      assert.notEqual(next(state, event), state,
        `${state}: ${control} is enabled but ${event} has no transition`);
    }
  }
});

test('stop has no event of its own, but HEARD and HEARD_NOTHING answer it', () => {
  // `stop` deliberately isn't in the EVENT map above: pressing the mic while
  // listening (or the active re-speak button while respeaking) doesn't fire
  // a `STOP` transition -- it calls recognition.stop(), which lets Chrome
  // flush a last result and fire onend, which then raises HEARD or
  // HEARD_NOTHING same as any other end of listening/respeaking. This is the
  // same invariant `stop` needs as every other control -- something must
  // actually move the machine off the state -- it just gets answered
  // indirectly instead of by an event named `stop`. Re-speak needs this too:
  // continuous recognition means it no longer ends on its own first final
  // result either, and a re-speak that finalises mid-phrase on its own would
  // compare only that fragment against the target -- a false negative on the
  // sentence the learner is trying to get right.
  for (const state of ['listening', 'respeaking']) {
    assert.equal(controls(state).stop, true);
    assert.notEqual(next(state, 'HEARD'), state);
    assert.notEqual(next(state, 'HEARD_NOTHING'), state);
  }
});
