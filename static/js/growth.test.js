import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { resetDom } from './dom-shim.js';
import { renderGrowth, heatLevels, GROWTH_TEXT } from './growth.js';

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
const blocks = (g) => renderGrowth(g, 560);
const byLabel = (bs, label) => bs.find((b) => one(b, 'label').textContent === label);
// details > [summary, table > [thead, tbody > tr > td]]
const rowsOf = (details) => details.children[1].children[1].children.map((tr) => tr.children.map((td) => td.textContent));
const hover = (node) => node.listeners.pointerenter[0]();
const tipOf = (node) => { let n = node; while (n && !n.classList.contains('growth-chart')) n = n.parentNode; return one(n, 'growth-tip'); };

test('the four blocks come in order, each named', () => {
  assert.deepEqual(blocks(growthBody()).map((b) => one(b, 'label').textContent),
    ['연습 잔디', '정확도 변화', '1분 말하기', '레벨 테스트 기록']);
});

test('the calendar has 112 cells, coloured by the quartiles of the days with turns', () => {
  const cal = byLabel(blocks(growthBody()), '연습 잔디');
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
  const cal = byLabel(blocks(growthBody()), '연습 잔디');
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

test('under the calendar: streak, longest and total time, and the days as a table', () => {
  const cal = byLabel(blocks(growthBody()), '연습 잔디');
  assert.equal(one(cal, 'growth-summary').textContent, '연속 3일 · 최장 7일 · 총 2시간 5분');
  const table = one(cal, 'growth-table');
  assert.equal(table.children[0].textContent, '표로 보기');
  assert.deepEqual(rowsOf(table), [['9월 16일', '9문장'], ['9월 15일', '5문장'], ['9월 14일', '2문장'], ['9월 9일', '14문장']]);
  assert.equal(one(byLabel(blocks(growthBody({ minutes: 42 })), '연습 잔디'), 'growth-summary').textContent,
    '연속 3일 · 최장 7일 · 총 42분');
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
  assert.equal(say('연습 잔디'), GROWTH_TEXT.calendarEmpty);
  assert.equal(say('정확도 변화'), '채점된 문장이 쌓이면 주별 정확도가 보여요');
  assert.equal(say('1분 말하기'), '1분 말하기를 하면 여기에 변화가 보여요');
  assert.equal(say('레벨 테스트 기록'), '레벨 테스트를 보면 기록이 쌓여요');
  for (const b of bs) assert.equal(all(b, 'growth-chart').length, 0, 'an empty chart was drawn');
});

test('charts are SVG in the SVG namespace, sized by viewBox to the width given', () => {
  const [cal, acc] = renderGrowth(growthBody(), 600);
  const svg = one(acc, 'growth-chart').children[0];
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 600 170');
  assert.equal(one(cal, 'growth-chart').children[0].getAttribute('tabindex'), '0');
});
