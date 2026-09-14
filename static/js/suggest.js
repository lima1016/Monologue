import { $, postJSON, state, notify } from './api.js';
import { annotate, attachMeaning } from './reading.js';

export const SUGGEST_TITLE = '이렇게 말해볼 수 있어요';
export const SUGGEST_LOADING = '생각하는 중...';
export const SUGGEST_FAILED = '지금은 추천을 만들 수 없어요';

/* 봇 말풍선마다 카드는 하나. 로딩 중인 카드도 여기 들어가므로, 같은 말풍선에서
   다시 누르면 요청 중이든 끝났든 새로 묻지 않는다. 대화창이 비워지면 말풍선과
   함께 사라진다(WeakMap). */
const cards = new WeakMap();

/* 대본 모드는 할 말이 이미 정해져 있다. */
export function setSuggestVisible(mode) {
  $('btn-suggest').hidden = !(mode === 'free' || mode === 'lesson');
}

export function latestBotBubble() {
  const bots = [...$('conversation').children]
    .filter((n) => n.classList.contains('msg') && n.classList.contains('bot'));
  return bots[bots.length - 1] || null;
}

/* 누른 그 순간의 봇 말풍선을 붙잡는다. 응답을 기다리는 사이 다음 봇 대사가
   와도 카드는 물어본 말에 붙는다 -- 서버도 요청 시점의 마지막 봇 대사로 답한다.
   턴 상태 머신과는 독립이다: 녹음·전송·재생과 겹칠 자원이 없다. */
export async function suggestForLatest() {
  const bubble = latestBotBubble();
  if (!bubble || !state.sessionId) return;
  const existing = cards.get(bubble);
  if (existing) {
    existing.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const card = document.createElement('div');
  card.className = 'suggest-card';
  const title = document.createElement('p');
  title.className = 'suggest-title';
  title.textContent = SUGGEST_LOADING;
  card.appendChild(title);
  bubble.after(card);
  cards.set(bubble, card);

  const button = $('btn-suggest');
  button.disabled = true;
  const language = state.language;
  const sessionId = state.sessionId;
  try {
    const { replies } = await postJSON(`/sessions/${sessionId}/suggest`, {});
    if (!Array.isArray(replies) || !replies.length) throw new Error('no replies');
    title.textContent = SUGGEST_TITLE;
    renderReplies(card, replies, language);
  } catch {
    card.remove();
    cards.delete(bubble);
    // 응답이 오는 사이 학습자가 다른 세션으로 넘어갔다면, 지금 와서 실패를
    // 알리는 것은 지금 세션과 무관한 소음이다 -- 카드와 WeakMap 항목은
    // 그래도 치운다: 이 요청은 끝났고, 다시 물으면 새로 물어야 한다.
    if (state.sessionId === sessionId) notify(SUGGEST_FAILED);
  } finally {
    button.disabled = false;
  }
}

/* 줄마다 문장과 뜻. 문장을 누르면 듣는다(main.js의 대화창 클릭 핸들러).
   보내는 경로는 없다 -- 학습자가 소리 내어 말해야 연습이다. 원문은
   dataset.source에 둔다: 읽기 보조와 뜻 버튼이 textContent를 바꾼다. */
export function renderReplies(card, replies, language) {
  const japanese = [];
  for (const reply of replies) {
    const row = document.createElement('div');
    row.className = 'suggest-row';
    const line = document.createElement('div');
    line.className = 'suggest-line';
    line.textContent = reply.text;
    line.dataset.source = reply.text;
    line.dataset.sourceLang = language;
    if (reply.audio_key) line.dataset.audioKey = reply.audio_key;
    row.appendChild(line);
    if (reply.meaning) {
      line.dataset.hasMeaning = '1';
      const meaning = document.createElement('div');
      meaning.className = 'suggest-meaning';
      meaning.textContent = reply.meaning;
      row.appendChild(meaning);
    } else if (language === 'en') {
      attachMeaning(line, 'en', reply.text);
    } else if (language === 'ja') {
      // annotate() may fail (network, or a bad /reading response) and never
      // touch this line -- without a fallback button, a null-meaning
      // Japanese reply would then have no way to reach its meaning at all.
      // When annotate does succeed, it replaces the whole line via
      // innerHTML, which drops this button; renderTokens draws its own in
      // its place, so there is never a duplicate.
      attachMeaning(line, 'ja', reply.text);
    }
    if (language === 'ja') japanese.push({ el: line, text: reply.text });
    card.appendChild(row);
  }
  if (japanese.length) annotate(japanese);
}
