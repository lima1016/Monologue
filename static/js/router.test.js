import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $ } from './api.js';
import { document, resetDom } from './dom-shim.js';
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* The class comes off when the fade ends -- the screen's own animationend,
   not one bubbling up from a bubble fading in inside it. */
test('screen-enter comes off at the screen\'s own animationend, not a child\'s', () => {
  resetDom();
  router.register('home', 'home');
  router.register('pick', 'pick');
  router.show('home');
  router.show('pick');
  const pick = $('pick');
  const fire = (target) => (pick.listeners.animationend || []).slice().forEach((fn) => fn({ target }));
  fire(document.createElement('div'));
  assert.ok(pick.classList.contains('screen-enter'), 'a child\'s animationend ended the screen\'s fade');
  fire(pick);
  assert.equal(pick.classList.contains('screen-enter'), false);
});

/* home → pick → home inside one fade: the first entry's fallback timer must
   not take the class off the latest entry of the same screen mid-fade. */
test('a fast A→B→A keeps the latest entry\'s fade until its own fallback', async () => {
  resetDom();
  router.register('home', 'home');
  router.register('pick', 'pick');
  router.show('pick');
  router.show('home');                 // first entry of home
  router.show('pick');
  await wait(100);
  router.show('home');                 // latest entry, 100ms later
  await wait(130);                     // past the first entry's fallback only
  assert.ok($('home').classList.contains('screen-enter'), 'a stale timer cut the latest fade short');
  await wait(120);                     // past the latest entry's fallback
  assert.equal($('home').classList.contains('screen-enter'), false, 'the fallback never removed the class');
});
