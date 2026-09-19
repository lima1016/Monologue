import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './dom-shim.js';
import { resetDom } from './dom-shim.js';
import { renderSummary, renderDetails, heatLevels, summarySkeleton, layout } from './growth.js';

beforeEach(() => resetDom());

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* 16 weeks from Monday 2026-06-01; today is Wednesday 2026-09-16 (index 107),
   the last column running on to Sunday 2026-09-20 (index 111). */
function growthBody(over = {}) {
  const calendar = Array.from({ length: 112 }, (_, i) => ({ day: iso(new Date(2026, 5, 1 + i)), turns: 0 }));
  calendar[100].turns = 14;   // 9월 9일
  calendar[105].turns = 2;
  calendar[106].turns = 5;
  calendar[107].turns = 9;    // today
  const accuracy = Array.from({ length: 12 }, (_, i) => ({ week: iso(new Date(2026, 5, 29 + 7 * i)), correct: 0, graded: 0 }));
  accuracy[8] = { ...accuracy[8], correct: 10, graded: 20 };   // 8/24
  accuracy[10] = { ...accuracy[10], correct: 18, graded: 25 }; // 9/7; 8/31 between them has none
  accuracy[11] = { ...accuracy[11], correct: 4, graded: 5 };   // 9/14
  return {
    today: '2026-09-16', calendar, streak: 3, longest: 7, minutes: 125, accuracy,
    timed: [
      { session_id: 1, day: '2026-09-01', wpm: 80, long_pauses: 4, words: 80 },
      { session_id: 2, day: '2026-09-08', wpm: 95, long_pauses: 2, words: 95 },
      { session_id: 3, day: '2026-09-12', wpm: 112, long_pauses: 1, words: 112 },
    ],
    level_tests: [
      { finished_at: '2026-09-10T03:00:00+00:00', cefr: 'B1', step: '상위', ielts: '4.5–5.0', toefl: { band: '3.5', old: '18–19' }, jf: null },
      { finished_at: '2026-08-01T03:00:00+00:00', cefr: 'B1', step: '하위', ielts: '4.0–4.5', toefl: { band: '3.0', old: '16–17' }, jf: null },
      { finished_at: '2026-07-01T03:00:00+00:00', cefr: 'B2', step: '하위', ielts: '5.5–6.0', toefl: { band: '4.0', old: '20–22' }, jf: null },
    ],
    ...over,
  };
}

function all(node, cls, out = []) {
  if (node.classList && node.classList.contains(cls)) out.push(node);
  for (const c of node.children || []) all(c, cls, out);
  return out;
}
const one = (node, cls) => all(node, cls)[0] || null;
const text = (n) => (n.textContent || '') + (n.childNodes || []).map(text).join(' ');
const blocks = (g) => renderDetails(g, 560);
// The card above the tabs: the calendar, its key and the lines under it.
const card = (g) => renderSummary(g, 560)[0];
const byLabel = (bs, label) => bs.find((b) => one(b, 'label').textContent === label);
// details > [summary, table > [thead, tbody > tr > td]]
const rowsOf = (details) => details.children[1].children[1].children.map((tr) => tr.children.map((td) => td.textContent));
const hover = (node) => node.listeners.pointerenter[0]();
const tipOf = (node) => { let n = node; while (n && !n.classList.contains('growth-chart')) n = n.parentNode; return one(n, 'growth-tip'); };

test('the details are four blocks in order, each named', () => {
  assert.deepEqual(blocks(growthBody()).map((b) => one(b, 'label').textContent),
    ['연습한 날', '정확도 변화', '1분 말하기', '레벨 테스트 기록']);
});

/* The card's skeleton holds what a practised learner's card carries: the
 * calendar's own box at its real height, the heat key row, and the three
 * lines -- so the card does not grow when the answer replaces it. */
test("the card's loading skeleton holds the calendar's box, its key and three lines", () => {
  const [box] = summarySkeleton(560);
  const charts = all(box, 'growth-chart');
  assert.equal(charts.length, 1);
  assert.ok(charts[0].classList.contains('skeleton'));
  assert.equal(charts[0].style.height, `${layout(560).cal.height}px`);
  assert.equal(all(box, 'heat-key').length, 1);
  const lines = all(box, 'growth-line');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.classList.contains('skeleton')));
});

test('the calendar has 112 cells, coloured by the quartiles of the days with turns', () => {
  const cal = card(growthBody());
  const cells = all(cal, 'cal-cell');
  assert.equal(cells.length, 112);
  const lv = (i) => [0, 1, 2, 3, 4].find((n) => cells[i].classList.contains(`lv${n}`));
  assert.equal(lv(0), 0);
  assert.equal(lv(105), 1);   // 2 turns: the lowest quartile
  assert.equal(lv(106), 2);   // 5
  assert.equal(lv(107), 3);   // 9
  assert.equal(lv(100), 4);   // 14: the busiest
  assert.ok(cells[107].classList.contains('is-today'));
  // The rest of this week is still to come: drawn as nothing, not as a day off.
  for (const i of [108, 109, 110, 111]) {
    assert.ok(cells[i].classList.contains('is-future'), `cell ${i}`);
    assert.equal(lv(i), undefined);
  }
  // Seven rows (Mon..Sun) by sixteen columns, the last column holding today.
  assert.equal(cells[7].getAttribute('y'), cells[0].getAttribute('y'));
  assert.notEqual(cells[7].getAttribute('x'), cells[0].getAttribute('x'));
  assert.equal(cells[107].getAttribute('x'), cells[111].getAttribute('x'));
  assert.equal(all(cal, 'heat-swatch').length, 4);
  assert.match(text(one(cal, 'heat-key')), /적음[\s\S]*많음/);
});

test('heat levels split the non-zero days at their quartiles; zero is its own step', () => {
  const level = heatLevels([0, 1, 1, 2, 3, 4, 8, 20, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, 8, 20].map(level), [0, 1, 2, 2, 3, 4, 4]);
  assert.equal(heatLevels([0, 0])(0), 0);
});

test('a calendar cell says its day and its count on hover, and on the keys', () => {
  const cal = card(growthBody());
  const hits = all(cal, 'hit');
  assert.equal(hits.length, 108, 'every day up to today has a hit area; the future has none');
  const tip = tipOf(hits[0]);
  hover(hits[100]);
  assert.equal(tip.textContent, '9월 9일 · 14문장');
  assert.ok(tip.classList.contains('is-shown'));
  hover(hits[1]);
  assert.equal(tip.textContent, '6월 2일 · 연습 안 함');
  // The hit area is the whole slot, bigger than the square it covers.
  assert.ok(Number(hits[0].getAttribute('width')) > Number(all(cal, 'cal-cell')[0].getAttribute('width')));
  const root = tip.parentNode.children[0];
  root.listeners.blur[0]();
  assert.equal(tip.classList.contains('is-shown'), false);
  root.listeners.focus[0]();
  assert.equal(tip.textContent, '6월 2일 · 연습 안 함', 'focus comes back to the cell last looked at');
  const press = (key) => root.listeners.keydown[0]({ key, preventDefault() {} });
  press('End');
  assert.equal(tip.textContent, '9월 16일 · 9문장');
  press('ArrowLeft');          // a column back is a week back
  assert.equal(tip.textContent, '9월 9일 · 14문장');
  press('ArrowDown');
  assert.equal(tip.textContent, '9월 10일 · 연습 안 함');
});

test('under the calendar: streak and total time; the longest run and the days sit in the details', () => {
  assert.equal(one(card(growthBody()), 'growth-streak').textContent, '연속 3일 · 총 2시간 5분');
  assert.equal(one(card(growthBody({ minutes: 42 })), 'growth-streak').textContent, '연속 3일 · 총 42분');
  assert.equal(one(card(growthBody({ minutes: 120 })), 'growth-streak').textContent, '연속 3일 · 총 2시간');
  const days = byLabel(blocks(growthBody()), '연습한 날');
  assert.equal(one(days, 'growth-summary').textContent, '최장 연속 7일');
  const table = one(days, 'growth-table');
  assert.equal(table.children[0].textContent, '표로 보기');
  assert.deepEqual(rowsOf(table), [['9월 16일', '9문장'], ['9월 15일', '5문장'], ['9월 14일', '2문장'], ['9월 9일', '14문장']]);
});

const mark = (line) => one(line, 'growth-delta');

test("this week's accuracy on the card, ▲ ▼ or – against the week before that had any", () => {
  const up = one(card(growthBody()), 'growth-acc');
  assert.match(text(up), /^이번 주 정확도 80%/);        // 4/5 against 9/7's 18/25 (72%)
  assert.equal(mark(up).textContent, '▲');
  assert.ok(mark(up).classList.contains('up'));
  assert.equal(mark(up).getAttribute('aria-label'), '그 전 주보다 올랐어요');
  const acc = growthBody().accuracy;
  acc[11] = { ...acc[11], correct: 3, graded: 5 };        // 60%
  const down = one(card(growthBody({ accuracy: acc })), 'growth-acc');
  assert.equal(mark(down).textContent, '▼');
  assert.ok(mark(down).classList.contains('down'));
  acc[11] = { ...acc[11], correct: 36, graded: 50 };      // 72%, as 9/7
  const same = one(card(growthBody({ accuracy: acc })), 'growth-acc');
  assert.equal(mark(same).textContent, '–');
  assert.equal(mark(same).getAttribute('aria-label'), '그 전 주와 같아요');
});

test('a week with nothing graded yet gives way to the latest week that has; none at all, no line', () => {
  const acc = growthBody().accuracy;
  acc[11] = { ...acc[11], correct: 0, graded: 0 };
  const last = one(card(growthBody({ accuracy: acc })), 'growth-acc');
  assert.match(text(last), /^지난 주 정확도 72%/);        // 9/7, against 8/24's 50%
  assert.equal(mark(last).textContent, '▲');
  acc[10] = { ...acc[10], correct: 0, graded: 0 };
  const older = one(card(growthBody({ accuracy: acc })), 'growth-acc');
  assert.match(text(older), /^8\/24 주 정확도 50%/);
  assert.equal(mark(older), null, 'nothing before it to compare with');
  const none = acc.map((w) => ({ ...w, correct: 0, graded: 0 }));
  assert.equal(one(card(growthBody({ accuracy: none })), 'growth-acc'), null);
});

test('the newest 1분 말하기 on the card: words a minute against the round before, and its long pauses', () => {
  const up = one(card(growthBody()), 'growth-timed');
  assert.match(text(up), /^1분 말하기 분당 112단어/);
  assert.match(text(up), /· 긴 멈춤 1번$/);
  assert.equal(mark(up).textContent, '▲');
  assert.equal(mark(up).getAttribute('aria-label'), '지난번보다 올랐어요');
  const rounds = growthBody().timed;
  const down = one(card(growthBody({ timed: [rounds[2], rounds[0]] })), 'growth-timed');
  assert.match(text(down), /^1분 말하기 분당 80단어/);
  assert.equal(mark(down).textContent, '▼');
  const same = one(card(growthBody({ timed: [rounds[0], { ...rounds[1], wpm: 80 }] })), 'growth-timed');
  assert.equal(mark(same).textContent, '–');
  assert.equal(mark(one(card(growthBody({ timed: [rounds[0]] })), 'growth-timed')), null);
  assert.equal(one(card(growthBody({ timed: [] })), 'growth-timed'), null);
});

test('with no practice at all the card is one line saying what will fill it', () => {
  const g = growthBody({
    calendar: growthBody().calendar.map((c) => ({ ...c, turns: 0 })), streak: 0, longest: 0, minutes: 0,
    accuracy: growthBody().accuracy.map((a) => ({ ...a, correct: 0, graded: 0 })), timed: [], level_tests: [],
  });
  const nodes = renderSummary(g, 560);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].textContent, '연습하면 여기에 쌓여요');
  assert.ok(nodes[0].classList.contains('growth-guide'));
  assert.equal(all(nodes[0], 'growth-chart').length, 0);
});

test('a week with nothing graded is a gap in the accuracy line, not a zero', () => {
  const acc = byLabel(blocks(growthBody()), '정확도 변화');
  assert.equal(all(acc, 'series-dot').length, 3, 'a point only where sentences were graded');
  const d = one(acc, 'series-line').getAttribute('d');
  assert.equal((d.match(/M/g) || []).length, 2, 'the line lifts over the empty week');
  assert.equal((d.match(/L/g) || []).length, 1);
  assert.equal(all(acc, 'grid').length, 3, 'one axis: 0, 50, 100');
  const hits = all(acc, 'hit');
  assert.equal(hits.length, 12);
  const tip = tipOf(hits[0]);
  hover(hits[10]);
  assert.equal(tip.textContent, '9/7 주 · 정확도 72% (18/25)');
  hover(hits[9]);
  assert.equal(tip.textContent, '8/31 주 · 채점된 문장 없음');
  const rows = rowsOf(one(acc, 'growth-table'));
  assert.deepEqual(rows[9], ['8/31 주', '—', '0']);
  assert.deepEqual(rows[10], ['9/7 주', '72%', '18/25']);
  assert.equal(rows.length, 12);
});

test('1분 말하기 is two charts, words a minute and long pauses, each on its own axis', () => {
  const timed = byLabel(blocks(growthBody()), '1분 말하기');
  const charts = all(timed, 'growth-small');
  assert.equal(charts.length, 2);
  assert.deepEqual(charts.map((c) => one(c, 'growth-sub').textContent), ['분당 단어', '긴 멈춤']);
  for (const c of charts) {
    assert.equal(all(c, 'series-line').length, 1, 'one series per chart');
    assert.equal(all(c, 'series-dot').length, 3);
    assert.equal(all(c, 'growth-chart').length, 1);
  }
  hover(all(charts[0], 'hit')[2]);
  assert.equal(one(charts[0], 'growth-tip').textContent, '9월 12일 · 분당 112단어');
  hover(all(charts[1], 'hit')[0]);
  assert.equal(one(charts[1], 'growth-tip').textContent, '9월 1일 · 긴 멈춤 4번');
  assert.deepEqual(rowsOf(one(charts[0], 'growth-table')), [['9월 12일', '112'], ['9월 8일', '95'], ['9월 1일', '80']]);
  assert.deepEqual(rowsOf(one(charts[1], 'growth-table')), [['9월 12일', '1번'], ['9월 8일', '2번'], ['9월 1일', '4번']]);
});

test('level tests, newest first, with ▲ or ▼ against the one before', () => {
  const list = byLabel(blocks(growthBody()), '레벨 테스트 기록');
  const rows = all(list, 'growth-test');
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /9월 10일[\s\S]*B1 상위[\s\S]*IELTS 4\.5–5\.0 \/ TOEFL 3\.5/);
  assert.equal(one(rows[0], 'growth-delta').textContent, '▲');
  assert.ok(one(rows[0], 'growth-delta').classList.contains('up'));
  assert.equal(one(rows[1], 'growth-delta').textContent, '▼');
  assert.equal(one(rows[1], 'growth-delta').getAttribute('aria-label'), '지난번보다 내려갔어요');
  assert.equal(one(rows[2], 'growth-delta'), null, 'the first test has nothing to compare with');
});

test('a Japanese level test reads JF Standard', () => {
  const g = growthBody({ level_tests: [{ finished_at: '2026-09-10T03:00:00+00:00', cefr: 'B1', step: '하위', ielts: null, toefl: null, jf: 'JF 스탠다드 B1' }] });
  assert.equal(one(byLabel(blocks(g), '레벨 테스트 기록'), 'growth-test-scale').textContent, 'JF 스탠다드 B1');
});

test('each block with nothing to show says what will fill it, instead of an empty chart', () => {
  const empty = growthBody({
    calendar: growthBody().calendar.map((c) => ({ ...c, turns: 0 })), streak: 0, longest: 0, minutes: 0,
    accuracy: growthBody().accuracy.map((a) => ({ ...a, correct: 0, graded: 0 })), timed: [], level_tests: [],
  });
  const bs = blocks(empty);
  const say = (label) => one(byLabel(bs, label), 'growth-empty').textContent;
  assert.equal(one(byLabel(bs, '연습한 날'), 'growth-table'), null, 'no days to list');
  assert.equal(say('정확도 변화'), '채점된 문장이 쌓이면 주별 정확도가 보여요');
  assert.equal(say('1분 말하기'), '1분 말하기를 하면 여기에 변화가 보여요');
  assert.equal(say('레벨 테스트 기록'), '레벨 테스트를 보면 기록이 쌓여요');
  for (const b of bs) assert.equal(all(b, 'growth-chart').length, 0, 'an empty chart was drawn');
});

test('charts are SVG in the SVG namespace, sized by viewBox to the width given', () => {
  const [, acc] = renderDetails(growthBody(), 600);
  const cal = renderSummary(growthBody(), 600)[0];
  const svg = one(acc, 'growth-chart').children[0];
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 600 170');
  assert.equal(one(cal, 'growth-chart').children[0].getAttribute('tabindex'), '0');
});

/* .fold-inner (the 자세히 보기 fold) clips anything outside it -- needed for
   its 0fr->1fr height animation -- so a tooltip that spills past its own
   chart's wrapper is a tooltip nobody can read. Both hits below sit near an
   edge of the chart's own coordinate space; the wrapper and the tip are
   sized (via the dom-shim's settable offset/client properties) so that the
   flip-only placement would spill past the wrapper's far side, forcing the
   pixel clamp to pull it back in. */
test('a tip near either edge of the chart is clamped fully inside its wrapper', () => {
  const acc = byLabel(blocks(growthBody()), '정확도 변화');
  const wrap = one(acc, 'growth-chart');
  const tip = one(acc, 'growth-tip');
  wrap.clientWidth = 240;
  wrap.clientHeight = 130;
  tip.offsetWidth = 230;
  tip.offsetHeight = 30;
  const hits = all(acc, 'hit');

  hover(hits[0]); // near the left edge: flip alone would run the tip past the right side
  assert.equal(tip.style.left, '10px');
  assert.equal(tip.style.right, '');

  hover(hits[hits.length - 1]); // near the right edge and near the top: flip alone would run past the left and the top
  assert.equal(tip.style.left, '0px');
  assert.equal(tip.style.right, '');
  assert.equal(tip.style.bottom, '100px');
});

/* ---------- CSS ---------- */

// Line endings normalised: a Windows checkout with core.autocrlf turns the
// file CRLF, and the block search below looks for the matching '}'.
const css = readFileSync(new URL('../css/components.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function ruleBody(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf('}', start));
}

/* The skeleton always reserves three lines under the calendar, but a fresh
   card may draw only the streak line -- the container needs its own floor
   (three lines plus the gaps between them), not just a floor on each line,
   or the card shrinks the moment the answer replaces the skeleton. */
test('the summary lines sit on a three-line floor, so the card does not shrink when the answer lands', () => {
  assert.match(ruleBody('.growth-lines'), /min-height:\s*calc\(3 \* var\(--text-sm\) \* 1\.55 \+ 2 \* var\(--space-1\)\)/);
});
