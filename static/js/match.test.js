import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, similarity, matches } from './match.js';

test('normalize strips the punctuation and case that STT never produces', () => {
  assert.equal(normalize('I went to the STORE, yesterday.'), 'i went to the store yesterday');
  assert.equal(normalize('  spaced   out  '), 'spaced out');
  assert.equal(normalize('きのう、レストランに行きました。'), 'きのうレストランに行きました');
});

test('an exact repeat matches', () => {
  assert.ok(matches('I went to the store yesterday.', 'I went to the store yesterday.', 'en'));
});

test('the punctuation and casing STT drops does not fail the learner', () => {
  // This is the whole reason for the threshold: Chrome returns no full stop
  // and arbitrary casing, so exact comparison would never pass.
  assert.ok(matches('i went to the store yesterday', 'I went to the store yesterday.', 'en'));
});

test('one wrong word passes only once the sentence is long enough', () => {
  // similarity for a single wrong word is 1 - 1/n, so clearing 0.9 needs
  // n >= 10. Ten words is where one slip stops failing -- worth stating,
  // because it is the practical meaning of the threshold: for the short
  // sentences a correction usually produces, the learner must get every
  // word right.
  const ten     = 'I went to the store yesterday morning before work again';
  const tenSaid = 'I went to a store yesterday morning before work again';
  assert.equal(ten.split(' ').length, 10);
  assert.ok(matches(tenSaid, ten, 'en'));

  const nine     = 'I went to the store yesterday morning before work';
  const nineSaid = 'I went to a store yesterday morning before work';
  assert.equal(nine.split(' ').length, 9);
  assert.ok(!matches(nineSaid, nine, 'en'));
});

test('saying something different fails', () => {
  assert.ok(!matches('I go store yesterday', 'I went to the store yesterday.', 'en'));
});

test('japanese compares by character because it has no word spaces', () => {
  assert.ok(matches('きのうレストランに行きました', 'きのう、レストランに行きました。', 'ja'));
  assert.ok(!matches('きのうレストランに行きます', 'きのう、レストランに行きました。', 'ja'));
});

test('similarity is symmetric and bounded', () => {
  const a = similarity('one two three', 'one two four', 'en');
  assert.equal(a, similarity('one two four', 'one two three', 'en'));
  assert.ok(a > 0 && a < 1);
});

test('empty input never passes', () => {
  assert.ok(!matches('', 'I went to the store yesterday.', 'en'));
  assert.ok(!matches('   ', 'I went to the store yesterday.', 'en'));
});
