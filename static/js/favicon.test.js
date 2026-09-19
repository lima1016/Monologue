/* The browser-tab icon wears the current theme's accent, light or dark.
 *
 * favicon.svg stays the file fallback for first paint (no JS yet); this
 * module repaints the same <link rel="icon"> from the *computed* --accent
 * once the page (or a theme change) has one. There is no CSS engine here,
 * so every test supplies its own getComputedStyle stub instead of relying
 * on tokens.css.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $ } from './api.js';
import { resetDom } from './dom-shim.js';
import { paintFavicon } from './favicon.js';

const realGetComputedStyle = globalThis.getComputedStyle;
const realMatchMedia = globalThis.matchMedia;

function stubAccent(color) {
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (prop) => (prop === '--accent' ? color : ''),
  });
}

beforeEach(() => resetDom());
afterEach(() => {
  if (realGetComputedStyle === undefined) delete globalThis.getComputedStyle;
  else globalThis.getComputedStyle = realGetComputedStyle;
  if (realMatchMedia === undefined) delete globalThis.matchMedia;
  else globalThis.matchMedia = realMatchMedia;
});

function decodedHref() {
  const href = $('favicon-link').getAttribute('href');
  const prefix = 'data:image/svg+xml,';
  assert.ok(href.startsWith(prefix), `href should be a data URL, got ${href}`);
  return decodeURIComponent(href.slice(prefix.length));
}

test('paintFavicon sets a data: URL carrying the accent colour and the mark\'s five bars', () => {
  stubAccent('#a85a3c');
  paintFavicon();
  const svg = decodedHref();
  assert.match(svg, /fill="#a85a3c"/);
  // The five bars, straight from favicon.svg's <rect>s.
  assert.match(svg, /<rect x="5" y="10" width="8" height="44" rx="4"\/>/);
  assert.match(svg, /<rect x="17" y="16" width="8" height="32" rx="4"\/>/);
  assert.match(svg, /<rect x="28" y="22" width="8" height="20" rx="4"\/>/);
  assert.match(svg, /<rect x="39" y="16" width="8" height="32" rx="4"\/>/);
  assert.match(svg, /<rect x="51" y="10" width="8" height="44" rx="4"\/>/);
});

test('changing theme repaints the icon with the new accent', () => {
  stubAccent('#a85a3c');
  paintFavicon();
  assert.match(decodedHref(), /fill="#a85a3c"/);

  stubAccent('#56733a');
  paintFavicon();
  assert.match(decodedHref(), /fill="#56733a"/);
});

test('an empty computed accent leaves the current icon alone', () => {
  stubAccent('#a85a3c');
  paintFavicon();
  const before = $('favicon-link').getAttribute('href');

  stubAccent('');
  paintFavicon();
  assert.equal($('favicon-link').getAttribute('href'), before);
});

test('a computed accent that is not a colour leaves the current icon alone', () => {
  stubAccent('#a85a3c');
  paintFavicon();
  const before = $('favicon-link').getAttribute('href');

  stubAccent('not a colour; <script>');
  paintFavicon();
  assert.equal($('favicon-link').getAttribute('href'), before);
});

test('no getComputedStyle at all: no throw, icon left alone', () => {
  delete globalThis.getComputedStyle;
  const before = $('favicon-link').getAttribute('href');
  assert.doesNotThrow(() => paintFavicon());
  assert.equal($('favicon-link').getAttribute('href'), before);
});
