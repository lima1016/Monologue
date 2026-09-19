import { $, api, getJSON, notify, postJSON } from './api.js';
import { setPrefs } from './reading.js';

let currentPreviewAudio = null;
let currentPreviewUrl = null;

/* Only the dialog's chosen language's settings are shown. The voice list
   follows the select by being re-fetched; the reading aids are Japanese-only,
   so they are hidden rather than re-rendered. Hiding changes nothing stored --
   the prefs still apply to every Japanese session. */
export function syncLanguageSections() {
  $('reading-prefs').hidden = $('settings-language').value !== 'ja';
}

export async function renderVoiceList() {
  const language = $('settings-language').value;
  try {
    const { voices, selected } = await getJSON(`/voices?language=${language}`);
    $('voice-list').innerHTML = voices
      .map(
        (v) => `<div class="voice">
          <input type="radio" name="voice" id="v-${v.id}" value="${v.id}" ${v.id === selected ? 'checked' : ''}>
          <label for="v-${v.id}">${v.label} <span class="hint">${v.gender === 'male' ? '남성' : '여성'}</span></label>
          <button data-preview="${v.id}">▶ 미리듣기</button>
        </div>`
      )
      .join('');
  } catch (err) {
    notify(`음성 목록을 불러올 수 없습니다: ${err.message}`);
    $('voice-list').innerHTML = '';
  }
}

export async function previewVoice(voice) {
  const language = $('settings-language').value;
  try {
    // Stop and clean up any currently-playing preview
    if (currentPreviewAudio) {
      currentPreviewAudio.pause();
    }
    if (currentPreviewUrl) {
      URL.revokeObjectURL(currentPreviewUrl);
    }

    const res = await api('/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, voice }),
    });
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    currentPreviewAudio = audio;
    currentPreviewUrl = url;
    await audio.play();
  } catch (err) {
    notify(`미리듣기 실패: ${err.message}`);
  }
}

export async function loadReadingPrefs() {
  try {
    const prefs = await getJSON('/reading-prefs');
    $('pref-furigana').checked = prefs.furigana;
    $('pref-romaji').checked = prefs.romaji;
    const script = prefs.pron_script === 'romaji' ? 'romaji' : 'hangul';
    $('pref-pron-hangul').checked = script === 'hangul';
    $('pref-pron-romaji').checked = script === 'romaji';
    setPrefs({ ...prefs, pron_script: script });
  } catch {
    // 기본값(둘 다 켜짐)이 이미 reading.js 안에 있다. 설정을 못 읽는 것이
    // 보조를 끄는 이유가 되어서는 안 된다.
  }
}

export async function saveReadingPrefs() {
  const prefs = {
    furigana: $('pref-furigana').checked,
    romaji: $('pref-romaji').checked,
    pron_script: $('pref-pron-romaji').checked ? 'romaji' : 'hangul',
  };
  setPrefs(prefs);
  try {
    await postJSON('/reading-prefs', prefs);
  } catch (err) {
    notify(`읽기 보조 설정을 저장하지 못했습니다: ${err.message}`);
  }
}

/* ---------- 화면: theme and brightness ----------
   The attributes on <html> are what tokens.css keys on. The inline script at
   the top of index.html applies the saved pair before first paint; this is
   the same logic for the dialog, which applies a choice at once and saves
   it. Keep THEMES, MODES and the two keys in step with that script. */
export const THEMES = ['default', 'forest', 'sea', 'lavender', 'ink', 'white'];
export const MODES = ['auto', 'light', 'dark'];
const THEME_KEY = 'screen-theme';
const MODE_KEY = 'screen-mode';

function storedOr(key, allowed) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return allowed.includes(v) ? v : allowed[0];
  } catch {
    return allowed[0]; // private window, blocked storage: the defaults
  }
}

/* The saved pair, or 기본/자동 for anything missing, unknown or unreadable. */
export function readScreenPrefs() {
  return { theme: storedOr(THEME_KEY, THEMES), mode: storedOr(MODE_KEY, MODES) };
}

/* Mark the pressed swatch and brightness button. getAttribute/setAttribute
   by id, so it runs the same under the node dom-shim as in a browser. */
function syncScreenControls(theme, mode) {
  for (const t of THEMES) {
    const b = document.getElementById(`theme-${t}`);
    if (b) b.setAttribute('aria-pressed', String(t === theme));
  }
  for (const m of MODES) {
    const b = document.getElementById(`mode-${m}`);
    if (!b) continue;
    b.setAttribute('aria-pressed', String(m === mode));
    b.classList.toggle('on', m === mode);
  }
}

/* Apply a theme/brightness to <html> at once, reflect it in the dialog, and
   save it. Unknown values fall back to the defaults; a storage failure only
   means the choice lasts for this page. Returns what was applied. */
export function applyTheme(theme, mode) {
  const t = THEMES.includes(theme) ? theme : THEMES[0];
  const m = MODES.includes(mode) ? mode : MODES[0];
  const root = document.documentElement;
  root.setAttribute('data-theme', t);
  root.setAttribute('data-mode', m);
  syncScreenControls(t, m);
  try {
    globalThis.localStorage?.setItem(THEME_KEY, t);
    globalThis.localStorage?.setItem(MODE_KEY, m);
  } catch { /* not saved; still applied */ }
  return { theme: t, mode: m };
}

/* Wires the swatches and the brightness segment, and marks the current
   choice. Each button carries its own value, read with getAttribute. */
export function initScreenPrefs() {
  const current = { theme: readCurrentTheme(), mode: readCurrentMode() };
  syncScreenControls(current.theme, current.mode);
  for (const t of THEMES) {
    document.getElementById(`theme-${t}`)?.addEventListener('click', () => {
      applyTheme(t, readCurrentMode());
    });
  }
  for (const m of MODES) {
    document.getElementById(`mode-${m}`)?.addEventListener('click', () => {
      applyTheme(readCurrentTheme(), m);
    });
  }
  return current;
}

/* What is on <html> right now -- the source of truth once the page is up,
   so a storage that can't be read doesn't reset the other half of a choice. */
function readCurrentTheme() {
  const v = document.documentElement.getAttribute('data-theme');
  return THEMES.includes(v) ? v : THEMES[0];
}
function readCurrentMode() {
  const v = document.documentElement.getAttribute('data-mode');
  return MODES.includes(v) ? v : MODES[0];
}
