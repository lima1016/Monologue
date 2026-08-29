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
    if (el) el.hidden = screen !== name;
  }
  active = name;
}
