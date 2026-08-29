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
  speaking:   { AUDIO_DONE: 'idle', MIC: 'listening' },
  undoing:    { UNDO_DONE: 'idle', UNDO_FAILED: 'idle' },
  respeaking: { HEARD: 'idle', HEARD_NOTHING: 'idle' },
};

export function next(state, event) {
  const to = TRANSITIONS[state] && TRANSITIONS[state][event];
  return to || state;
}

/* Work is in flight during `sending` and `undoing`: a request is out and the
   conversation's shape depends on its answer. Everything else is interactive. */
const IN_FLIGHT = new Set(['sending', 'undoing']);

export function controls(state) {
  const free = !IN_FLIGHT.has(state) && state !== 'listening' && state !== 'respeaking';
  return {
    // The mic stays live while the bot is speaking so the learner can answer
    // before the clip finishes, which is what happens in a real conversation.
    mic: state === 'idle' || state === 'speaking',
    send: free,
    undo: free,
    next: free,
    respeak: free,
    // Ending must never be blocked -- a hung request should not trap the
    // learner in a session with no exit.
    end: true,
  };
}
