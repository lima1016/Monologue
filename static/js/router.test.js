import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $ } from './api.js';
import { resetDom } from './dom-shim.js';
import * as router from './router.js';

test('the entering screen gets the enter animation class; the others are hidden at once', () => {
  resetDom();
  router.register('home', 'home');
  router.register('pick', 'pick');
  router.show('home');
  router.show('pick');
  assert.equal($('home').hidden, true);
  assert.equal($('pick').hidden, false);
  assert.ok($('pick').classList.contains('screen-enter'));
});

test('showing the screen that is already active does not replay the animation', () => {
  resetDom();
  router.register('home', 'home');
  router.show('home');
  $('home').classList.remove('screen-enter');
  router.show('home');
  assert.equal($('home').classList.contains('screen-enter'), false);
});
