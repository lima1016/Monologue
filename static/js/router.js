import { $ } from './api.js';

/* One screen visible at a time. Screens register themselves rather than the
   router knowing the list, so Phase 2C and 2D can add home and mypage without
   editing this file. */
const screens = new Map();
let active = null;

export function register(name, elementId) {
  screens.set(name, elementId);
}

export function current() {
  return active;
}

export function show(name) {
  if (!screens.has(name)) throw new Error(`unknown screen: ${name}`);
  for (const [screen, id] of screens) {
    const el = $(id);
    // Not `if (el)`. A registered screen that is not in the document means the
    // app is already broken -- every screen stays hidden and the page renders
    // blank -- and swallowing the miss here is what let an id be renamed out of
    // index.html with the whole test suite still green. Screen ids reach the
    // DOM through this variable, never as a literal at the lookup, so a source
    // scan for literal ids cannot see them; throwing is what makes the loss
    // visible, at load, in a test.
    if (!el) throw new Error(`screen ${screen} (#${id}) is not in the document`);
    el.hidden = screen !== name;
  }
  active = name;
}
