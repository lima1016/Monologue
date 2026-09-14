import { $ } from './api.js';

/* One screen visible at a time. Screens register themselves rather than the
   router knowing the list, so Phase 2C and 2D can add home and mypage without
   editing this file. */
const screens = new Map();
let active = null;
let generation = 0;
const ENTER_FALLBACK_MS = 200;   // --dur-fast (150ms) plus a frame or three

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
    // A screen left mid-fade drops its class, so it cannot carry a stale one
    // into its next entry.
    if (screen !== name) el.classList.remove('screen-enter');
  }
  // The entering screen eases in (spec R1); the ones being left are hidden
  // outright in the same pass above, so nothing overlaps mid-transition.
  // Re-showing the screen that is already active (e.g. a re-render that
  // calls show() again) must not replay the animation.
  if (active !== name) {
    const enteringId = screens.get(name);
    const entering = $(enteringId);
    // The class comes off when the fade actually ends: the screen's own
    // animationend (a bubble or chip fading in inside it bubbles one up too,
    // hence the target check), or a fallback a little past --dur-fast for when
    // no animation runs (reduced motion). Each entry has a generation, so on a
    // fast A -> B -> A the first entry's timer cannot end the latest fade.
    const gen = ++generation;
    const end = (e) => {
      if (e && e.target !== entering) return;
      entering.removeEventListener('animationend', end);
      if (gen === generation) entering.classList.remove('screen-enter');
    };
    entering.classList.add('screen-enter');
    entering.addEventListener('animationend', end);
    setTimeout(end, ENTER_FALLBACK_MS);
  }
  active = name;
}
