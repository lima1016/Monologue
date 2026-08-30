/* 일본어 읽기 보조를 화면에 얹는 층.
 *
 * 핵심 계약: 먼저 평문을 그리고 나중에 덧입힌다. 이 모듈이 하는 일이 실패해도
 * -- 사전이 죽었든, 요청이 실패했든, 느리든 -- 줄은 항상 읽을 수 있는 상태로
 * 남아야 한다. 덧입히기가 안 될 뿐이다. 학습자가 읽어야 할 줄이 비는 것은
 * 보조가 없는 것보다 나쁘다.
 *
 * 후리가나 정렬 규칙은 여기에 없다. 서버(app/reading.py)가 확정한 `parts`를
 * 순서대로 그리기만 한다 -- 규칙이 두 곳에 있으면 반드시 갈라진다.
 */
import { postJSON } from './api.js';

let prefs = { furigana: true, romaji: true };

export function getPrefs() { return { ...prefs }; }
export function setPrefs(next) { prefs = { ...prefs, ...next }; }

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderTokens(tokens, options = prefs) {
  const body = tokens.map((t) => t.parts.map((p) => {
    const text = escapeHtml(p.text);
    if (!p.ruby || !options.furigana) return text;
    return `<ruby>${text}<rt>${escapeHtml(p.ruby)}</rt></ruby>`;
  }).join('')).join('');

  const romaji = options.romaji
    ? tokens.map((t) => t.romaji || t.surface).join(' ').trim()
    : '';

  return `<span class="ja">${body}</span>`
    + (romaji ? `<span class="romaji">${escapeHtml(romaji)}</span>` : '')
    + '<button class="meaning" type="button">▸ 뜻</button>'
    + '<span class="meaning-body" hidden></span>';
}

/* entries: [{ el, text }]. 화면에 새로 그려진 일본어 줄 전부를 한 번에 넘긴다.
   요청이 실패하면 조용히 돌아간다 -- el은 이미 평문을 들고 있고, 그것이
   이 함수가 지켜야 할 최소치다. */
export async function annotate(entries) {
  if (!entries.length) return;
  let readings;
  try {
    const res = await postJSON('/reading', {
      language: 'ja',
      texts: entries.map((e) => e.text),
    });
    readings = res.readings;
  } catch {
    return; // 평문이 그대로 남는다
  }
  entries.forEach((entry, i) => {
    const tokens = readings[i];
    if (!tokens || !tokens.length) return;
    entry.el.innerHTML = renderTokens(tokens);
    entry.el.dataset.ja = entry.text;
  });
}

/* 뜻은 el.dataset.meaning에 한 번만 담아두고, 그 뒤로는 열고 닫기만 한다.
   서버도 캐시하지만 여기서 한 번 더 막는 이유는, 왕복 자체를 없애야 접었다
   폈다 하는 동작이 즉각적으로 느껴지기 때문이다. */
export async function toggleMeaning(el, body) {
  if (body.textContent) {
    body.hidden = !body.hidden;
    return;
  }
  try {
    const { meaning } = await postJSON('/translate', {
      language: 'ja',
      text: el.dataset.ja,
    });
    body.textContent = meaning;
  } catch {
    body.textContent = '뜻을 가져오지 못했습니다.';
  }
  body.hidden = false;
}
