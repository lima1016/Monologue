import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, notify, setShown } from './api.js';
import { resetDom } from './dom-shim.js';

test('notify shows a floating toast with the message and clears on empty', () => {
  resetDom();
  notify('서버에 연결하지 못했어요');
  assert.equal($('notice').hidden, false);
  assert.equal($('notice-text').textContent, '서버에 연결하지 못했어요');
  notify('');
  assert.equal($('notice').hidden, true);
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
