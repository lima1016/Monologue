import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUtterance } from './utterance.js';

test('the pin: final fragments accumulate across a pause instead of overwriting', () => {
  // This mirrors the learner's actual report verbatim: "Thanks a lot," is
  // Chrome's first final result (finalised at the comma pause, not because
  // the learner stopped talking), and "have a good day" is a second final
  // result from the same recognition session once continuous = true lets it
  // keep listening. If final() only remembered the latest fragment, this
  // would come back as just "have a good day" -- the mirror image of the bug
  // that shipped ("Thanks" only, before this fix).
  const utt = createUtterance();
  utt.begin();
  utt.final('Thanks a lot,');
  utt.final('have a good day');
  assert.equal(utt.text(), 'Thanks a lot, have a good day');
});

test('begin() clears a previous utterance\'s fragments', () => {
  const utt = createUtterance();
  utt.begin();
  utt.final('first utterance');
  utt.begin();
  assert.equal(utt.text(), '', 'a second utterance must not inherit the first\'s text');
  utt.final('second utterance');
  assert.equal(utt.text(), 'second utterance');
});

test('empty and whitespace-only final fragments do not dirty text()', () => {
  const utt = createUtterance();
  utt.begin();
  utt.final('');
  utt.final('   ');
  utt.final('Thanks');
  utt.final('');
  utt.final('a lot');
  assert.equal(utt.text(), 'Thanks a lot');
});

test('interim text shows live, appended after what has already been finalised', () => {
  const utt = createUtterance();
  utt.begin();
  utt.final('Thanks a lot,');
  utt.interim('have a');
  assert.equal(utt.text(), 'Thanks a lot, have a');
  utt.interim('have a good day'); // Chrome revises the same interim result in place
  assert.equal(utt.text(), 'Thanks a lot, have a good day');
});

test('a fragment becoming final replaces its own interim rather than duplicating it', () => {
  const utt = createUtterance();
  utt.begin();
  utt.interim('have a good');
  utt.final('have a good day');
  assert.equal(utt.text(), 'have a good day', 'the interim tail must not linger once its own text is finalised');
});

test('a blank interim clears the live tail without adding an empty fragment', () => {
  const utt = createUtterance();
  utt.begin();
  utt.final('Thanks');
  utt.interim('   ');
  assert.equal(utt.text(), 'Thanks');
});
