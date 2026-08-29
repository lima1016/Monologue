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
  };
}
