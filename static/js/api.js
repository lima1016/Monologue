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
  const el = $('notice');
  el.textContent = message;
  el.hidden = !message;
}
