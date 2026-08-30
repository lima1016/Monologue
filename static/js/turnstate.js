/* One turn's lifecycle, as a pure state machine.

   Phase 1 guarded re-entrancy with a single `state.busy` boolean, and a bug
   fixed in 07caa64 came from exactly that: one flag cannot describe which of
   several overlapping activities is in flight. This file owns the answer to
   both "what is happening" and "which controls may be pressed", so the two can
   never disagree.

   No imports and no DOM: `node --test` runs it directly. */

export const INITIAL = 'idle';

const TRANSITIONS = {
  idle:       { MIC: 'listening', SEND: 'sending', UNDO: 'undoing', RESPEAK: 'respeaking' },
  listening:  { HEARD: 'sending', HEARD_NOTHING: 'idle' },
  sending:    { REPLY: 'speaking', SEND_FAILED: 'idle' },
  speaking:   { AUDIO_DONE: 'idle', MIC: 'listening', SEND: 'sending' },
  undoing:    { UNDO_DONE: 'idle', UNDO_FAILED: 'idle' },
  respeaking: { HEARD: 'idle', HEARD_NOTHING: 'idle' },
};

export function next(state, event) {
  const to = TRANSITIONS[state] && TRANSITIONS[state][event];
  return to || state;
}

/* `speaking` is interactive, not in-flight: nothing is pending on the server,
   the bot's clip is simply still playing, and a learner answering over it is
   the point. So it permits the two ways of starting a turn and nothing else —
   undo would delete the turn whose reply is playing, and re-speaking would run
   recognition while the bot talks over it. Every state listed here also has a
   matching transition, or a button would sit enabled and do nothing. */
const CAN_START_TURN = new Set(['idle', 'speaking']);

export function controls(state) {
  const interactive = state === 'idle';
  return {
    mic: CAN_START_TURN.has(state),
    send: CAN_START_TURN.has(state),
    undo: interactive,
    next: interactive,
    respeak: interactive,
    // Ending must never be blocked -- a hung request should not trap the
    // learner in a session with no exit.
    end: true,
    // `stop` is how a turn now ends: nothing sends on a timer any more
    // (utterance.js just accumulates), so pressing the mic again while
    // `listening`, or the active re-speak button while `respeaking`, is the
    // learner's only way to say "that's everything". It has no `STOP` event
    // of its own in TRANSITIONS -- the caller responds to it by calling
    // recognition.stop(), and Chrome's `onend` raises HEARD or HEARD_NOTHING
    // same as any other end of listening/respeaking, both of which already
    // have transitions out of their state above.
    //
    // `respeaking` needs this for the same reason `listening` does, not a
    // smaller one: continuous recognition means a re-speak no longer ends on
    // its first final result either, and unlike a normal turn, a re-speak
    // that Chrome finalises mid-phrase on its own compares only that
    // fragment against the target -- a false negative on the exact sentence
    // the learner is trying to get right. An earlier version of this file
    // withheld `stop` from `respeaking` to keep the change small; that was a
    // mistake, not a narrower-but-valid choice -- it left re-speak with no
    // way to end at all except a 90s safety net (audio.js).
    stop: state === 'listening' || state === 'respeaking',
  };
}
