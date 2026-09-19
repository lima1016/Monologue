export const $ = (id) => document.getElementById(id);
export const api = async (path, options) => {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const err = new Error(body.detail || 'request failed');
    err.status = res.status;   // lets a caller tell "gone" (404) from "down"
    throw err;
  }
  return res;
};
export const getJSON = async (path) => (await api(path)).json();
export const postJSON = async (path, body) =>
  (await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })).json();

export const state = {
  sessionId: null,
  language: 'en',
  mode: 'free',
  // A shadowing session is mode 'script' with this set (shadow.js has the card).
  shadowing: false,
  scriptLines: [],
  scriptIndex: 0,
  recorder: null,
  chunks: [],
};

/* Home, pick and my page each carry a language segment, and all show the one
   state.language. Lives here rather than in pick.js because home.js's
   resumeSession changes the language too, and home.js must not import pick.js
   (that closes an import cycle -- see home.js's header). */
export function syncLanguageButtons() {
  for (const seg of [$('language-seg'), $('pick-language-seg'), $('mypage-language-seg')]) {
    for (const b of seg.children) b.classList.toggle('on', b.dataset.language === state.language);
  }
}

/* True when the learner asked the OS for less motion. Timers that exist only
   to let a fade finish skip straight to the end state then. */
export function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --dur-fast in tokens.css: how long a fade-out runs before the element goes.
export const LEAVE_MS = 150;

let noticeToken = 0;

export function notify(message) {
  const box = $('notice');
  const text = $('notice-text');
  // Message goes on the child span, not on the toast's own textContent: in a
  // real DOM, setting an element's textContent replaces every child node, so
  // writing the message onto `box` would silently delete `#notice-close`
  // (and its listener) the first time a notice was shown. `#notice-text` is
  // the only piece of `#notice` that should ever hold the message.
  const token = ++noticeToken;
  if (message) {
    text.textContent = message;
    box.classList.remove('is-leaving');
    box.hidden = false;
    return;
  }
  const done = () => {
    box.hidden = true;
    box.classList.remove('is-leaving');
    text.textContent = '';
  };
  if (box.hidden || reducedMotion()) { done(); return; }
  // Fades out (.toast.is-leaving) with its message still on it, then hides.
  // A message that arrives meanwhile bumps the token, and this hide is void.
  box.classList.add('is-leaving');
  setTimeout(() => { if (token === noticeToken) done(); }, LEAVE_MS);
}

// Hides `el` without pulling it out of the layout -- `hidden` keeps its
// space, only `.is-invisible` (visibility: hidden + opacity: 0, see
// components.css) makes it invisible, so nothing else on screen shifts when
// a status line or a secondary button comes and goes (spec R5).
export function setShown(el, on) {
  el.classList.toggle('is-invisible', !on);
  el.setAttribute('aria-hidden', String(!on));
  el.hidden = false;
}
