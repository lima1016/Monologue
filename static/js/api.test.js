import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, notify, setShown } from './api.js';
import { resetDom, window } from './dom-shim.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('notify shows a floating toast with the message and clears on empty', async () => {
  resetDom();
  notify('서버에 연결하지 못했어요');
  assert.equal($('notice').hidden, false);
  assert.equal($('notice-text').textContent, '서버에 연결하지 못했어요');
  notify('');
  await wait(160);
  assert.equal($('notice').hidden, true);
});

/* Clearing fades the toast out rather than dropping it in one frame; its
   message stays on it while it fades, so the box does not shrink first. */
test('notify clears by fading out, then hides', async () => {
  resetDom();
  notify('잠깐만요');
  notify('');
  assert.equal($('notice').hidden, false, 'hid in one frame instead of fading');
  assert.ok($('notice').classList.contains('is-leaving'));
  assert.equal($('notice-text').textContent, '잠깐만요', 'the message vanished before the fade');
  await wait(160);
  assert.equal($('notice').hidden, true);
  assert.equal($('notice').classList.contains('is-leaving'), false);
});

test('a message that arrives while the toast fades out keeps it up', async () => {
  resetDom();
  notify('first');
  notify('');
  notify('second');
  assert.equal($('notice').classList.contains('is-leaving'), false);
  await wait(160);
  assert.equal($('notice').hidden, false, 'the old fade-out hid the new message');
  assert.equal($('notice-text').textContent, 'second');
});

test('under reduced motion notify hides at once', () => {
  resetDom();
  const saved = window.matchMedia;
  window.matchMedia = (q) => ({ matches: q.includes('reduce') });
  try {
    notify('x');
    notify('');
    assert.equal($('notice').hidden, true);
    assert.equal($('notice').classList.contains('is-leaving'), false);
  } finally {
    window.matchMedia = saved;
  }
});

test('setShown keeps the element in the layout', () => {
  resetDom();
  const el = $('start-status');
  setShown(el, false);
  assert.equal(el.hidden, false);
  assert.ok(el.classList.contains('is-invisible'));
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  setShown(el, true);
  assert.equal(el.classList.contains('is-invisible'), false);
});
