/* Shadowing: hear a line, say it straight back, and only then see it. One card
   rather than a chat log -- one line is in play at a time, and a card whose
   parts fade in place keeps the dock still from stage to stage.

   The verdict is the server's (/shadow-line), not match.js here: the report
   counts matched lines, so the judgement shown has to be the one stored.

   session.js hands this module the lines, each final transcript and each turn
   state through setShadowHooks (bottom of the file); it never imports this. */
import { $, postJSON, state, notify, setShown } from './api.js';
import { play } from './audio.js';
import { annotate, attachMeaning } from './reading.js';
import { setShadowHooks, endSession, uploadRecordingFor, setTurnState, canDo } from './session.js';

const SLOW = 0.75;
const HIDDEN_TEXT = '●●●●●';
let lines = [];
let items = [];           // the side panel's text span per line, in order
let index = 0;
let stage = 'listen';     // 'listen': heard, not yet shown | 'reveal': judged and shown
let peeked = false;
let saving = false;
let annotated = false;    // this line's card text already has its reading aids
let lastMessageId = null;
let recorded = false;     // this line's last attempt has a recording on the server

export function shadowState() {
  return { index, stage, peeked, revealed: stage === 'reveal', saving };
}

export function startShadow(newLines) {
  lines = newLines;
  index = 0;
  // main.js's panel click plays state.scriptLines[i]; without this it would
  // play the previous script session's lines.
  state.scriptLines = lines;
  state.scriptIndex = 0;
  $('side-panel').hidden = false;
  $('panel-title').textContent = '쉐도잉';
  const ol = document.createElement('ol');
  items = lines.map((l, i) => {
    const li = document.createElement('li');
    li.dataset.i = String(i);
    const who = document.createElement('b');
    who.textContent = l.speaker === 'bot' ? '봇' : '나';
    const text = document.createElement('span');
    text.className = 'line shadow-hidden';
    text.textContent = HIDDEN_TEXT;
    li.append(who, document.createTextNode(' '), text);
    ol.append(li);
    return text;
  });
  $('panel-body').replaceChildren(ol);
  showLine();
}

/* The two stages swap their button rows; everything else in the card fades
   in place (setShown), so only this row changes, and in one step. */
function setStage(next) {
  stage = next;
  $('shadow-listen-actions').hidden = next !== 'listen';
  $('shadow-reveal-actions').hidden = next !== 'reveal';
}

function showLine() {
  const line = lines[index];
  setStage('listen');
  peeked = false;
  annotated = false;
  lastMessageId = null;
  recorded = false;
  $('shadow-count').textContent = `${index + 1} / ${lines.length}`;
  $('shadow-status').textContent = '';
  $('shadow-text').textContent = line.text;
  setShown($('shadow-text'), false);
  setShown($('shadow-said'), false);
  setShown($('shadow-peeked'), false);
  items.forEach((el, i) => el.parentNode.classList.toggle('current', i === index));
  play(line.audio_key, line.text);
}

/* The card's own copy of the line, with Japanese reading aids fetched once per
   line however many times it is shown (글자 보기, then the reveal). */
function showText() {
  setShown($('shadow-text'), true);
  if (state.language === 'ja' && !annotated) {
    annotated = true;
    annotate([{ el: $('shadow-text'), text: lines[index].text }]);
  }
}

export function replay() {
  const line = lines[index];
  if (line) play(line.audio_key, line.text);
}

export function replaySlow() {
  const line = lines[index];
  if (line) play(line.audio_key, line.text, null, { rate: SLOW });
}

export function peek() {
  peeked = true;
  showText();
}

/* The final transcript of one attempt, or null when nothing was heard.
   session.js has already raised HEARD, so the turn sits in `sending` -- the
   mic stays shut until this answers, one way or the other. */
export async function heard(transcript) {
  if (!transcript) {
    $('shadow-status').textContent = '못 알아들었어요. 다시 해보세요';
    return;
  }
  saving = true;
  $('shadow-mine').textContent = `내 말: "${transcript}"`;
  try {
    let data;
    try {
      data = await postJSON(`/sessions/${state.sessionId}/shadow-line`, { index, text: transcript, peeked });
    } catch {
      state.chunks = [];   // no row to attach this recording to
      setTurnState('SEND_FAILED');
      notify('저장하지 못했어요');
      // What was said stays on the card; a verdict it never got does not.
      const verdict = $('shadow-verdict');
      verdict.textContent = '';
      verdict.classList.remove('good', 'bad');
      setShown($('shadow-peeked'), false);
      setShown($('shadow-said'), true);
      setStage('listen');
      return;
    }
    // Nothing plays after a saved line, so the turn goes straight back to
    // idle: the mic is open again for 다시 하기.
    setTurnState('REPLY');
    setTurnState('AUDIO_DONE');
    lastMessageId = data.message_id;
    recorded = await uploadRecordingFor(data.message_id);
    reveal(data.matched);
  } finally {
    saving = false;
  }
}

function reveal(matched) {
  const line = lines[index];
  setStage('reveal');
  const verdict = $('shadow-verdict');
  verdict.textContent = matched ? '✓ 대본과 같아요' : '✗ 조금 달라요';
  verdict.classList.toggle('good', Boolean(matched));
  verdict.classList.toggle('bad', !matched);
  showText();
  setShown($('shadow-said'), true);
  setShown($('shadow-peeked'), peeked);
  $('shadow-play-mine').disabled = !recorded;
  $('shadow-next').textContent = index === lines.length - 1 ? '끝! 리포트 보기' : '다음 줄 →';
  // The panel keeps every line the learner has been shown. Once only: a
  // retried line is revealed again, and its aids are already there.
  const el = items[index];
  if (el && el.classList.contains('shadow-hidden')) {
    el.classList.remove('shadow-hidden');
    el.textContent = line.text;
    if (state.language === 'ja') annotate([{ el, text: line.text }]);
    else attachMeaning(el, state.language, line.text);
  }
}

/* Back to the same line. The text stays up -- it has been seen, hiding it again
   would pretend otherwise -- and the mic is the learner's to press. Gated on
   the turn state like 다음 →: a listen still running belongs to this attempt. */
export function retry() {
  if (!canDo('next')) return;
  setStage('listen');
  $('shadow-status').textContent = '';
  setShown($('shadow-said'), false);
  showText();
}

/* The last line's 다음 is the end of the session (its report is endSession's).
   Ending is never gated -- the same rule as 세션 끝내기. */
export function nextLine() {
  if (index >= lines.length - 1) return endSession();
  if (!canDo('next')) return undefined;
  index += 1;
  showLine();
  return undefined;
}

export function mine() {
  if (!recorded || lastMessageId === null) {
    $('shadow-play-mine').disabled = true;
    return;
  }
  new Audio(`/api/messages/${lastMessageId}/audio`).play()
    .catch(() => notify('녹음을 재생할 수 없습니다.'));
}

/* The card's status line follows the mic. While a line saves it keeps what it
   has -- REPLY and AUDIO_DONE land mid-save and must not blank it. */
export function onTurn(t) {
  const status = $('shadow-status');
  if (t === 'listening') status.textContent = '듣는 중...';
  else if (t === 'transcribing') status.textContent = '받아쓰는 중...';
  else if (!saving) status.textContent = '';
}

setShadowHooks({ start: startShadow, heard, turn: onTurn });
