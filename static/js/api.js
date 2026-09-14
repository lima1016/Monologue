export const $ = (id) => document.getElementById(id);
export const api = async (path, options) => {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || 'request failed');
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
  scriptLines: [],
  scriptIndex: 0,
  recorder: null,
  chunks: [],
};

export function notify(message) {
  const box = $('notice');
  const text = $('notice-text');
  // Message goes on the child span, not on the toast's own textContent: in a
  // real DOM, setting an element's textContent replaces every child node, so
  // writing the message onto `box` would silently delete `#notice-close`
  // (and its listener) the first time a notice was shown. `#notice-text` is
  // the only piece of `#notice` that should ever hold the message.
  text.textContent = message || '';
  box.hidden = !message;
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
