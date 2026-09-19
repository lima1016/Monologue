import { $, api, getJSON, notify, postJSON } from './api.js';
import { setPrefs } from './reading.js';
import { paintFavicon } from './favicon.js';

let currentPreviewAudio = null;
let currentPreviewUrl = null;

/* Both languages' sections (#lang-section-en, #lang-section-ja) stay in the
   dialog at once -- see the .lang-sections grid cell in components.css --
   so only *which one is reachable* changes here, never what's rendered.
   .is-inactive drives the CSS (visibility: hidden, not hidden/display:none,
   so the inactive section keeps holding its height); `inert` and
   aria-hidden keep its radios/checkboxes out of focus, click and
   assistive-tech reach the same way `hidden` used to. Hiding/inerting
   changes nothing stored -- the prefs still apply to every Japanese
   session. */
export function syncLanguageSections() {
  const active = $('settings-language').value;
  for (const lang of ['en', 'ja']) {
    const section = $(`lang-section-${lang}`);
    const isActive = lang === active;
    section.classList.toggle('is-inactive', !isActive);
    section.inert = !isActive;
    section.setAttribute('aria-hidden', String(!isActive));
  }
}

/* Renders one language's voice list into its own container so the other
   language's list (and its height) is left untouched.

   The radio group is named voice-${language}, not a bare "voice" -- both
   lists sit in the dialog's DOM at once (see the header comment above), and
   a plain `name="voice"` on both makes every one of these radios, across
   both languages, one native radio group: the browser itself unchecks
   whichever list's selection rendered first the moment the other list draws
   its own `checked` radio. Naming each list's group after its own language
   keeps the two groups apart the same way the containers already are. */
export async function renderVoiceList(language) {
  try {
    const { voices, selected } = await getJSON(`/voices?language=${language}`);
    $(`voice-list-${language}`).innerHTML = voices
      .map(
        (v) => `<div class="voice">
          <input type="radio" name="voice-${language}" id="v-${v.id}" value="${v.id}" ${v.id === selected ? 'checked' : ''}>
          <label for="v-${v.id}">${v.label} <span class="hint">${v.gender === 'male' ? '남성' : '여성'}</span></label>
          <button data-preview="${v.id}">▶ 미리듣기</button>
        </div>`
      )
      .join('');
  } catch (err) {
    notify(`음성 목록을 불러올 수 없습니다: ${err.message}`);
    $(`voice-list-${language}`).innerHTML = '';
  }
}

/* Both languages' lists are fetched up front, when the dialog opens, so the
   grid cell already knows the taller one's height before the learner ever
   touches the language select. */
export async function renderVoiceLists() {
  await Promise.all(['en', 'ja'].map(renderVoiceList));
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
  paintFavicon();
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
  paintFavicon();
  watchSystemScheme();
  return current;
}

/* 자동 brightness follows the OS scheme (tokens.css's dark block is guarded
   by `:not([data-mode="light"])`, i.e. it also applies under "auto"); when
   the OS flips while the learner is on 자동, --accent's *computed* value
   changes even though data-theme/data-mode do not, so nothing else here
   would repaint the tab icon. Guarded for environments without matchMedia
   (the node test harness, a stripped-down webview) -- no listener, no
   throw, and the tab icon just keeps whatever it last had. */
export function watchSystemScheme() {
  let mq;
  try {
    mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  } catch {
    return;
  }
  if (!mq || typeof mq.addEventListener !== 'function') return;
  mq.addEventListener('change', () => {
    if (readCurrentMode() === 'auto') paintFavicon();
  });
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

/* ---------- 기록 지우기 ----------
   #reset-prefs picks the scope (English / 日本語 / 둘 다, starting at the
   current language); 기록 지우기… opens #reset-confirm, which counts what
   would go before its own 기록 지우기 can be pressed. The scope deleted is
   the one the counts were shown for, whatever the radios say by then. Both
   dialogs keep their size throughout: the count line and the error line have
   their room reserved in components.css, and the confirm button's two
   labels share one min-width. */
const RESET_SCOPES = ['en', 'ja', 'all'];
const RESET_NAMES = { en: 'English', ja: '日本語', all: '모든' };
const RESET_KINDS = [
  ['sessions', '세션', '개'], ['reports', '리포트', '개'], ['reviews', '복습 카드', '개'],
  ['timed_rounds', '1분 말하기', '회'], ['level_tests', '레벨 테스트', '개'], ['recordings', '내 녹음', '개'],
];
const RESET_COUNTING = '개수를 세는 중이에요';
const RESET_LABEL = '기록 지우기';
const RESET_BUSY = '지우는 중이에요';

let resetCall = 0;        // the latest open; a count answering an older one is dropped
let resetFor = null;      // the scope the shown counts are for, once they are in
let resetBusy = false;    // a reset is out

export function setResetScope(language) {
  const scope = RESET_SCOPES.includes(language) ? language : 'en';
  for (const s of RESET_SCOPES) $(`reset-scope-${s}`).checked = s === scope;
}

export function resetScope() {
  return RESET_SCOPES.find((s) => $(`reset-scope-${s}`).checked) || 'en';
}

/* 세션 71개 · 복습 카드 16개 · ... -- kinds with nothing are left out; '' for none. */
export function resetCountsLine(counts) {
  return RESET_KINDS.filter(([key]) => counts[key] > 0)
    .map(([key, name, unit]) => `${name} ${counts[key]}${unit}`)
    .join(' · ');
}

export async function openResetConfirm() {
  const scope = resetScope();
  const call = ++resetCall;
  resetFor = null;
  $('reset-title').textContent = `${RESET_NAMES[scope]} 기록을 지울까요?`;
  $('reset-counts').textContent = RESET_COUNTING;
  $('reset-error').textContent = '';
  $('btn-reset-confirm').disabled = true;
  if (!$('reset-confirm').open) $('reset-confirm').showModal();
  try {
    const { counts } = await getJSON(`/history/summary?language=${scope}`);
    if (call !== resetCall) return;
    const line = resetCountsLine(counts);
    $('reset-counts').textContent = line || '지울 기록이 없어요';
    if (line) {
      resetFor = scope;
      $('btn-reset-confirm').disabled = false;
    }
  } catch {
    if (call !== resetCall) return;
    $('reset-counts').textContent = '';
    $('reset-error').textContent = '개수를 세지 못했어요. 닫고 다시 열어 주세요.';
  }
}

export function cancelReset() {
  if (resetBusy) return;
  resetCall++;
  resetFor = null;
  $('reset-confirm').close();
}

/* `onDone(scope)` reloads whatever screen is showing (main.js knows which). */
export async function confirmReset(onDone) {
  const scope = resetFor;
  if (!scope || resetBusy) return;
  resetBusy = true;
  const confirm = $('btn-reset-confirm');
  confirm.disabled = true;
  confirm.textContent = RESET_BUSY;
  $('btn-reset-cancel').disabled = true;
  $('reset-error').textContent = '';
  let ok = false;
  try {
    await postJSON('/history/reset', { language: scope });
    ok = true;
  } catch {
    $('reset-error').textContent = '지우지 못했어요. 잠시 뒤 다시 해 주세요.';
    confirm.disabled = false;
  } finally {
    resetBusy = false;
    confirm.textContent = RESET_LABEL;
    $('btn-reset-cancel').disabled = false;
  }
  if (!ok) return;
  resetCall++;
  resetFor = null;
  $('reset-confirm').close();
  $('settings').close();
  notify(`${RESET_NAMES[scope]} 기록을 지웠어요`);
  await onDone?.(scope);
}

export function initResetPrefs(onDone) {
  $('btn-reset-open').addEventListener('click', () => openResetConfirm());
  $('btn-reset-cancel').addEventListener('click', () => cancelReset());
  $('btn-reset-confirm').addEventListener('click', () => confirmReset(onDone));
  // Escape fires `cancel` on a modal dialog: let it close the confirm like
  // 취소 does, except while a reset is out -- that one has to be seen through.
  $('reset-confirm').addEventListener('cancel', (e) => {
    if (resetBusy) { e.preventDefault(); return; }
    resetCall++;
    resetFor = null;
  });
}
