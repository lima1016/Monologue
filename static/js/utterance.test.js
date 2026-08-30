import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUtterance } from './utterance.js';

/* A fake clock: setTimer/clearTimer are injected (same pattern turnstate.js's
   caller-owns-the-transition style uses elsewhere in this app -- here it's the
   only way to test a silence timer under `node --test` without a real
   passage of time). advance(ms) runs due callbacks in schedule order. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id -> { at, fn }
  const setTimer = (fn, ms) => {
    const id = nextId++;
    pending.set(id, { at: now + ms, fn });
    return id;
  };
  const clearTimer = (id) => { pending.delete(id); };
  const advance = (ms) => {
    now += ms;
    // Fire everything due, in the order they were scheduled -- a callback
    // firing may itself schedule a new timer, which must not be swept up in
    // this same pass (that would fire a just-armed timer immediately).
    const due = [...pending.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [id, t] of due) {
      if (!pending.has(id)) continue; // cleared by an earlier callback in this batch
      pending.delete(id);
      t.fn();
    }
  };
  return { setTimer, clearTimer, advance, pendingCount: () => pending.size };
}

test('final fragments join with a single space', () => {
  const clock = fakeClock();
  const utt = createUtterance({ onSilence: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('Thanks a lot,');
  utt.final('have a good day');
  assert.equal(utt.text(), 'Thanks a lot, have a good day');
});

test('the pin: each final fragment restarts the silence timer', () => {
  // This is the bug itself. Before the fix, a mid-sentence pause finalised
  // "Thanks" and the turn was sent while the learner kept talking. If
  // onSilence fires before a second silenceMs has elapsed since the LAST
  // fragment, this test must fail.
  const clock = fakeClock();
  let fired = 0;
  const utt = createUtterance({ silenceMs: 2000, onSilence: () => { fired += 1; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('Thanks a lot,');
  clock.advance(1500); // less than silenceMs since the first fragment
  utt.final('have a good day'); // restarts the timer
  clock.advance(1500); // 1500ms since the second fragment: still not silent
  assert.equal(fired, 0, 'onSilence must not fire before silenceMs since the LAST fragment');
  clock.advance(500); // now 2000ms since the second fragment
  assert.equal(fired, 1);
});

test('interim results also restart the timer, without collecting text', () => {
  const clock = fakeClock();
  let fired = 0;
  const utt = createUtterance({ silenceMs: 2000, onSilence: () => { fired += 1; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('Thanks a lot,');
  clock.advance(1900);
  utt.interim(); // still talking, no final result yet -- must push the deadline out
  clock.advance(1900);
  assert.equal(fired, 0, 'interim() must restart the silence timer');
  assert.equal(utt.text(), 'Thanks a lot,', 'interim() must not collect into the transcript');
  clock.advance(200);
  assert.equal(fired, 1);
});

test('stop() cancels the timer and onSilence never fires', () => {
  const clock = fakeClock();
  let fired = 0;
  const utt = createUtterance({ silenceMs: 2000, onSilence: () => { fired += 1; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('Thanks');
  utt.stop();
  clock.advance(5000);
  assert.equal(fired, 0);
  assert.equal(clock.pendingCount(), 0);
});

test('begin() clears a previous utterance\'s text', () => {
  const clock = fakeClock();
  const utt = createUtterance({ onSilence: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('first utterance');
  utt.stop();
  utt.begin();
  assert.equal(utt.text(), '', 'a second utterance must not inherit the first\'s text');
  utt.final('second utterance');
  assert.equal(utt.text(), 'second utterance');
});

test('empty and whitespace-only fragments do not dirty text()', () => {
  const clock = fakeClock();
  const utt = createUtterance({ onSilence: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('');
  utt.final('   ');
  utt.final('Thanks');
  utt.final('');
  utt.final('a lot');
  assert.equal(utt.text(), 'Thanks a lot');
});

test('begin() cancels a timer left pending from a stale utterance', () => {
  const clock = fakeClock();
  let fired = 0;
  const utt = createUtterance({ silenceMs: 2000, onSilence: () => { fired += 1; },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  utt.begin();
  utt.final('stale');
  utt.begin(); // a fresh start before the stale timer ever fired
  clock.advance(5000);
  assert.equal(fired, 0, 'begin() must cancel any timer pending from a previous utterance');
});
