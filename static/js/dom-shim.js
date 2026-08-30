/* A minimal DOM, for `node --test` only.
 *
 * Nothing in the app imports this and index.html never loads it; it exists so
 * that the real modules under static/js can be imported from disk by a test
 * and driven with a stubbed `fetch`. Dependency-free on purpose -- jsdom is
 * far bigger than the problem, and the problem is small: `audio.js` reads
 * `window` at module load, so without a `window` the module graph cannot be
 * imported under node at all, and a whole failure class (a ReferenceError at
 * evaluation, `$()` returning null for an id index.html no longer has, an
 * unhandled rejection during startup) has no test that can see it.
 *
 * Import this module *before* any app module -- ES modules evaluate their
 * dependencies in import-statement order, so a plain
 *   import './dom-shim.js';
 *   import { ... } from './session.js';
 * installs the globals before session.js's graph is evaluated.
 *
 * What it deliberately does NOT do: CSS selectors (querySelector/-All return
 * nothing), layout, or event dispatch. It models identity, the handful of
 * properties the app writes, and the tree well enough for the start paths.
 */
import { readFileSync } from 'node:fs';

const HTML_URL = new URL('../index.html', import.meta.url);

/* Parsed out of index.html rather than hand-listed here. A copied list rots,
   and the single most valuable property of this shim is that an id the JS
   looks up but the markup no longer carries returns null -- failing a test
   instead of failing silently in a browser. */
export function htmlIds() {
  const html = readFileSync(HTML_URL, 'utf8');
  // `\s`, not `\b`: a word boundary also matches after the `-` in `data-id="…"`,
  // so a future data-id would register a phantom id here and mask a real miss --
  // the same quiet failure the shim exists to prevent. Attributes are always
  // preceded by whitespace, so this loses nothing.
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

class ClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  write(s) { this.el.className = [...s].join(' '); }
  add(...names) { const s = this.set; names.forEach((n) => s.add(n)); this.write(s); }
  remove(...names) { const s = this.set; names.forEach((n) => s.delete(n)); this.write(s); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

class El {
  constructor(tag = 'div', id = null) {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
  }

  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get innerHTML() { return this._innerHTML || ''; }
  set innerHTML(html) { this._innerHTML = html; this.childNodes = []; }

  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i < 0 ? null : this.parentNode.childNodes[i + 1] || null;
  }

  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  appendChild(node) {
    if (node instanceof El) node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  after(node) {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (node instanceof El) node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(i + 1, 0, node);
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }

  /* No selector engine: nothing in the start paths this harness drives needs
     one, and a half-working one would be worse than an obviously absent one. */
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }

  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

class TextNode {
  constructor(text) { this.textContent = String(text); this.parentNode = null; }
}

const elements = new Map();
const ids = htmlIds();

export const document = {
  /* null for anything index.html does not declare -- see htmlIds above. */
  getElementById(id) {
    if (!ids.has(id)) return null;
    if (!elements.has(id)) elements.set(id, new El('div', id));
    return elements.get(id);
  },
  createElement(tag) { return new El(tag); },
  createTextNode(text) { return new TextNode(text); },
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

/* No SpeechRecognition and no speechSynthesis: that is a real browser
   configuration (and the one CI-like environments have), and the app already
   has a path for it -- `recognition` comes back null and `micUnsupported`
   turns the mic off. Adding fake speech APIs would test the shim, not the app. */
export const window = { document };

globalThis.document = document;
globalThis.window = window;
globalThis.Audio = class Audio {
  constructor(src) { this.src = src; }
  addEventListener() {}
  play() { return Promise.resolve(); }
};

/* Every test installs its own; this default keeps a bare import of the graph
   (which calls loadChips/refreshHealth/loadHome at once) from hitting the
   network or throwing before a test has had a chance to say what it wants. */
export function stubFetch(handler) {
  globalThis.fetch = async (url, options = {}) => handler(url, options);
}

export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: String(status), json: async () => body };
}

stubFetch(async () => jsonResponse({}));

/* Reset between tests: element state is module-global (the app's `$` memoises
   through getElementById), so a test that wants a clean tree asks for one. */
export function resetDom() {
  elements.clear();
}
