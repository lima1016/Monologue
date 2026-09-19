import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './dom-shim.js';
import { resetDom } from './dom-shim.js';
import { renderGrowth, heatLevels, growthSkeleton, layout, WIDE_MIN } from './growth.js';

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
// The whole panel under one node, so a search reaches every part of it.
function panel(g, width = 560) {
  const root = document.createElement('div');
  root.append(...renderGrowth(g, width));
  return root;
}
const blocks = (g, width) => all(panel(g, width), 'growth-block');
const card = (g) => byLabel(blocks(g), '연습한 날');
const flat = (n) => (n.textContent || '') + (n.childNodes || []).map(flat).join('');
const tileOf = (g, cls) => one(panel(g), cls);
const byLabel = (bs, label) => bs.find((b) => one(b, 'label').textContent === label);
// details > [summary, table > [thead, tbody > tr > td]]
const rowsOf = (details) => details.children[1].children[1].children.map((tr) => tr.children.map((td) => td.textContent));
const hover = (node) => node.listeners.pointerenter[0]();
const tipOf = (node) => { let n = node; while (n && !n.classList.contains('growth-chart')) n = n.parentNode; return one(n, 'growth-tip'); };

test('the details are four blocks in order, each named', () => {
  assert.deepEqual(blocks(growthBody()).map((b) => one(b, 'label').textContent),
    ['연습한 날', '정확도 변화', '1분 말하기', '레벨 테스트 기록']);
});

/* The panel's skeleton is the panel's own shape: four tiles, the
 * calendar's box at its real height with its key, and the chart blocks at
 * their charts' heights -- so the panel does not grow when the answer lands. */
test("the panel's loading skeleton holds the tiles, the calendar's box and key, and each chart's height", () => {
  for (const width of [560, 900]) {
    const root = document.createElement('div');
    root.append(...growthSkeleton(width));
    const L = layout(width);
    assert.equal(all(root, 'growth-tile').length, 4);
    assert.ok(all(root, 'growth-tile').every((t) => all(t, 'skeleton').length === 3), 'key, value and line');
    const charts = all(root, 'growth-chart');
    assert.ok(charts.every((c) => c.classList.contains('skeleton')));
    assert.deepEqual(charts.map((c) => c.style.height),
      [`${L.cal.height}px`, `${L.acc.height}px`, `${L.small.height}px`, `${L.small.height}px`]);
    assert.equal(charts[0].style.maxWidth, `${L.cal.width}px`);
    assert.equal(all(root, 'heat-key').length, 1);
    assert.deepEqual(all(root, 'growth-block').map((b) => one(b, 'label').textContent),
      ['연습한 날', '정확도 변화', '1분 말하기', '레벨 테스트 기록']);
    assert.equal(one(root, 'growth-grid').classList.contains('is-wide'), L.wide);
    assert.equal(one(root, 'growth-cal-body').classList.contains('is-wide'), L.wide);
  }
});

test('the panel is two by two from WIDE_MIN, and every chart is as wide as the inside of its block', () => {
  const narrow = layout(WIDE_MIN - 1);
  const wide = layout(WIDE_MIN);
  assert.equal(narrow.wide, false);
  assert.equal(wide.wide, true);
  // A block is a card: 16px padding and a 1px border each side.
  assert.equal(layout(400).acc.width, 400 - 34);
  // Two columns with a 16px gap between them.
  assert.equal(layout(900).acc.width, Math.floor((900 - 16) / 2) - 34);
  // The calendar leaves room for its 200px side column when wide, and grows
  // to fill a wide panel (up to 40px a day).
  assert.equal(layout(900).cal.step, Math.floor((900 - 200 - 16 - 34 - 24) / 16));
  assert.equal(layout(2000).cal.step, 40);
  assert.ok(layout(900).cal.width > layout(560).cal.width);
  // 1분 말하기's pair splits only in a column wide enough for both.
  assert.equal(layout(900).small.split, false);
  assert.equal(layout(1200).small.split, true);
  assert.equal(layout(1200).small.width, Math.floor((layout(1200).acc.width - 16) / 2));
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

test('the tiles: 연속 with the longest run, and 총 연습 with the days spoken on', () => {
  assert.equal(flat(tileOf(growthBody(), 'growth-streak')), '연속3일최장 7일');
  assert.equal(flat(tileOf(growthBody(), 'growth-time')), '총 연습2시간5분16주 동안 4일');
  assert.equal(flat(tileOf(growthBody({ minutes: 42 }), 'growth-time')), '총 연습42분16주 동안 4일');
  assert.equal(flat(tileOf(growthBody({ minutes: 120 }), 'growth-time')), '총 연습2시간16주 동안 4일');
  // The units are small type of their own; the numbers are the value.
  const v = one(tileOf(growthBody(), 'growth-time'), 'v');
  assert.deepEqual(v.children.map((c) => c.textContent), ['시간', '분']);
});

test('beside the calendar: its key, this week so far, and the days as a table', () => {
  const days = byLabel(blocks(growthBody()), '연습한 날');
  assert.equal(all(days, 'cal-cell').length, 112);
  assert.equal(one(days, 'growth-week').textContent, '이번 주 16문장', '9/14 to today: 2 + 5 + 9');
  const table = one(days, 'growth-table');
  assert.equal(table.children[0].textContent, '표로 보기');
  assert.deepEqual(rowsOf(table), [['9월 16일', '9문장'], ['9월 15일', '5문장'], ['9월 14일', '2문장'], ['9월 9일', '14문장']]);
  // A day still to come this week counts nothing.
  const later = growthBody();
  later.calendar[110].turns = 50;
  assert.equal(one(byLabel(blocks(later), '연습한 날'), 'growth-week').textContent, '이번 주 16문장');
});

const mark = (line) => one(line, 'growth-delta');

test("this week's accuracy tile: ▲ ▼ or – and the change against the week before that had any", () => {
  const up = tileOf(growthBody(), 'growth-acc');
  assert.equal(flat(up), '이번 주 정확도80%▲ 8%p');       // 4/5 against 9/7's 18/25 (72%)
  assert.ok(mark(up).classList.contains('up'));
  assert.equal(mark(up).getAttribute('aria-label'), '그 전 주보다 올랐어요');
  const acc = growthBody().accuracy;
  acc[11] = { ...acc[11], correct: 3, graded: 5 };        // 60%
  const down = tileOf(growthBody({ accuracy: acc }), 'growth-acc');
  assert.equal(flat(down), '이번 주 정확도60%▼ 12%p');
  assert.ok(mark(down).classList.contains('down'));
  acc[11] = { ...acc[11], correct: 36, graded: 50 };      // 72%, as 9/7
  const same = tileOf(growthBody({ accuracy: acc }), 'growth-acc');
  assert.equal(flat(same), '이번 주 정확도72%– 그대로');
  assert.equal(mark(same).getAttribute('aria-label'), '그 전 주와 같아요');
});

test('a week with nothing graded yet gives way to the latest week that has; none at all, a dash', () => {
  const acc = growthBody().accuracy;
  acc[11] = { ...acc[11], correct: 0, graded: 0 };
  const last = tileOf(growthBody({ accuracy: acc }), 'growth-acc');
  assert.equal(flat(last), '지난 주 정확도72%▲ 22%p');     // 9/7, against 8/24's 50%
  acc[10] = { ...acc[10], correct: 0, graded: 0 };
  const older = tileOf(growthBody({ accuracy: acc }), 'growth-acc');
  assert.equal(flat(older), '8/24 주 정확도50%10/20문장', 'nothing before it to compare with: its count');
  assert.equal(mark(older), null);
  const none = acc.map((w) => ({ ...w, correct: 0, graded: 0 }));
  assert.equal(flat(tileOf(growthBody({ accuracy: none }), 'growth-acc')), '정확도—채점된 문장이 아직 없어요');
});

test('the 1분 말하기 tile: the newest words a minute against the round before, and its long pauses', () => {
  const up = tileOf(growthBody(), 'growth-timed');
  assert.equal(flat(up), '1분 말하기112단어/분▲ 17 · 긴 멈춤 1번');
  assert.equal(mark(up).getAttribute('aria-label'), '지난번보다 올랐어요');
  const rounds = growthBody().timed;
  const down = tileOf(growthBody({ timed: [rounds[2], rounds[0]] }), 'growth-timed');
  assert.equal(flat(down), '1분 말하기80단어/분▼ 32 · 긴 멈춤 4번');
  const same = tileOf(growthBody({ timed: [rounds[0], { ...rounds[1], wpm: 80 }] }), 'growth-timed');
  assert.equal(mark(same).textContent, '–');
  assert.equal(flat(tileOf(growthBody({ timed: [rounds[0]] }), 'growth-timed')), '1분 말하기80단어/분긴 멈춤 4번');
  assert.equal(flat(tileOf(growthBody({ timed: [] }), 'growth-timed')), '1분 말하기—아직 해 보지 않았어요');
});

test('every tile keeps its line under the value, so the four are one height', () => {
  const tiles = all(panel(growthBody()), 'growth-tile');
  assert.equal(tiles.length, 4);
  for (const t of tiles) {
    assert.deepEqual(t.children.map((c) => c.className), ['k', 'v', 'd']);
    assert.ok(flat(one(t, 'd')).length > 0);
  }
});

test('with no practice at all the panel is one line saying what will fill it', () => {
  const g = growthBody({
    calendar: growthBody().calendar.map((c) => ({ ...c, turns: 0 })), streak: 0, longest: 0, minutes: 0,
    accuracy: growthBody().accuracy.map((a) => ({ ...a, correct: 0, graded: 0 })), timed: [], level_tests: [],
  });
  const nodes = renderGrowth(g, 560);
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
  // Some time on the clock, so there is a panel -- and nothing else in it.
  const empty = growthBody({
    calendar: growthBody().calendar.map((c) => ({ ...c, turns: 0 })), streak: 0, longest: 0, minutes: 5,
    accuracy: growthBody().accuracy.map((a) => ({ ...a, correct: 0, graded: 0 })), timed: [], level_tests: [],
  });
  const bs = blocks(empty);
  const say = (label) => one(byLabel(bs, label), 'growth-empty').textContent;
  assert.equal(one(byLabel(bs, '연습한 날'), 'growth-table'), null, 'no days to list');
  assert.equal(say('연습한 날'), '연습하면 여기에 날마다 한 칸씩 채워져요');
  assert.equal(say('정확도 변화'), '채점된 문장이 쌓이면 주별 정확도가 보여요');
  assert.equal(say('1분 말하기'), '1분 말하기를 하면 여기에 변화가 보여요');
  assert.equal(say('레벨 테스트 기록'), '레벨 테스트를 보면 기록이 쌓여요');
  for (const b of bs) assert.equal(all(b, 'growth-chart').length, 0, 'an empty chart was drawn');
});

test('charts are SVG in the SVG namespace, sized by viewBox to the inside of their blocks', () => {
  for (const width of [600, 900]) {
    const L = layout(width);
    const acc = byLabel(blocks(growthBody(), width), '정확도 변화');
    const svg = one(acc, 'growth-chart').children[0];
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('viewBox'), `0 0 ${L.acc.width} 170`);
    const cal = one(byLabel(blocks(growthBody(), width), '연습한 날'), 'growth-chart');
    assert.equal(cal.children[0].getAttribute('viewBox'), `0 0 ${L.cal.width} ${L.cal.height}`);
    assert.equal(cal.children[0].getAttribute('tabindex'), '0');
    assert.equal(one(panel(growthBody(), width), 'growth-grid').classList.contains('is-wide'), L.wide);
  }
});

test('accuracy, 1분 말하기 and the tests are one grid, in that order, each block named for its place', () => {
  const grid = one(panel(growthBody(), 900), 'growth-grid');
  assert.deepEqual(grid.children.map((b) => one(b, 'label').textContent), ['정확도 변화', '1분 말하기', '레벨 테스트 기록']);
  assert.ok(grid.children[0].classList.contains('growth-acc-block'));
  assert.ok(grid.children[1].classList.contains('growth-timed-block'));
  assert.ok(grid.children[2].classList.contains('growth-tests-block'));
  // The tiles first, then the calendar's block, then the grid.
  const top = renderGrowth(growthBody(), 900);
  assert.deepEqual(top.map((n) => n.className.split(' ')[0]), ['growth-tiles', 'growth-block', 'growth-grid']);
});

/* A block's own edge (and the next block beside it) would cut into a tip
   that spills past its chart's wrapper -- a tooltip nobody can read. Both hits below sit near an
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

/* Every tile's value and line hold one line each (nowrap), and a long line
   ends in an ellipsis instead of wrapping -- so the four tiles are one
   height whatever the numbers say, loading or loaded. */
test('a tile holds its lines to one each, so the tiles stay one height', () => {
  for (const sel of ['.growth-tile .v', '.growth-tile .d']) {
    const body = ruleBody(sel);
    assert.match(body, /white-space:\s*nowrap/, sel);
    assert.match(body, /min-height:\s*calc\(/, sel);
  }
  assert.match(ruleBody('.growth-tile .d'), /text-overflow:\s*ellipsis/);
});
