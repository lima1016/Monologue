/* 마이페이지 성장 tab: "am I getting better?" drawn from GET /stats/growth --
   no model call behind any of it. mypage.js owns when it loads (the first
   time the tab is shown per load and language); this module only turns one
   answer into nodes.

   Charts are inline SVG built here, one axis each, no library. The viewBox
   is the container's own width in pixels (`width`), so a label set at 11
   units is 11px on screen. Colour is the theme's: marks wear var(--accent)
   through classes in components.css, text wears text tokens, and the
   calendar's four steps are color-mix of --accent into --surface -- nothing
   here names a colour.

   Every chart has a tooltip on each point or cell (hover, and keyboard focus
   with the arrow keys), and a 표로 보기 under it with the same numbers: the
   tooltip never gates a value.

   Classes on SVG nodes go through setAttribute('class'): an SVG element's
   className is not a string in a browser. Text goes in by textContent. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const NBSP = String.fromCharCode(0xa0);
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export const GROWTH_TEXT = {
  wait: '기록을 모으는 중이에요',
  table: '표로 보기',
  calendarEmpty: '연습하면 여기에 날마다 한 칸씩 채워져요',
  accuracyEmpty: '채점된 문장이 쌓이면 주별 정확도가 보여요',
  timedEmpty: '1분 말하기를 하면 여기에 변화가 보여요',
  testsEmpty: '레벨 테스트를 보면 기록이 쌓여요',
};

/* ---------- layout (shared by the skeleton, so loading and loaded agree) ---------- */

const CAL = { left: 24, top: 18, weeks: 16, maxStep: 26, minStep: 12, gap: 3 };
const LINE = { left: 38, right: 14, top: 20, bottom: 24 };
const ACC_H = 170;
const SMALL_H = 130;
// Below this the two 1분 말하기 charts stack instead of sitting side by side.
const SPLIT_MIN = 480;
const PAIR_GAP = 16;

function calStep(width) {
  return Math.max(CAL.minStep, Math.min(CAL.maxStep, Math.floor((width - CAL.left) / CAL.weeks)));
}

export function layout(width) {
  const w = Math.max(280, Math.round(width));
  const step = calStep(w);
  const split = w >= SPLIT_MIN;
  return {
    width: w,
    cal: { step, width: CAL.left + CAL.weeks * step, height: CAL.top + 7 * step },
    acc: { width: w, height: ACC_H },
    small: { width: split ? Math.floor((w - PAIR_GAP) / 2) : w, height: SMALL_H, split },
  };
}

/* The loading state: each block's label and a placeholder the height of the
   chart that replaces it. */
export function growthSkeleton(width) {
  const L = layout(width);
  const chart = (w, h, cls = '') => {
    const box = el('div', `growth-chart skeleton ${cls}`.trim());
    box.style.height = `${h}px`;
    box.style.maxWidth = `${w}px`;
    return box;
  };
  const pair = el('div', `growth-pair${L.small.split ? ' is-split' : ''}`);
  pair.append(chart(L.small.width, L.small.height + 22), chart(L.small.width, L.small.height + 22));
  return [
    block('연습 잔디', chart(L.cal.width, L.cal.height), skelLine('growth-summary')),
    block('정확도 변화', chart(L.acc.width, L.acc.height)),
    block('1분 말하기', pair),
    block('레벨 테스트 기록', skelLine('growth-test'), skelLine('growth-test')),
  ].map((b) => { b.classList.add('is-skeleton'); return b; });
}

/* ---------- the whole tab ---------- */

export function renderGrowth(g, width) {
  const L = layout(width);
  return [
    block('연습 잔디', ...calendarSection(g, L)),
    block('정확도 변화', ...accuracySection(g.accuracy || [], L)),
    block('1분 말하기', ...timedSection(g.timed || [], L)),
    block('레벨 테스트 기록', testsSection(g.level_tests || [])),
  ];
}

/* ---------- 연습 잔디 ---------- */

/* Four steps by the quartiles of the days with any turns, so the colours
   spread over this learner's own range: a heavy day is heavy for them. */
export function heatLevels(counts) {
  const nz = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))];
  const q1 = q(0.25);
  const q2 = q(0.5);
  const q3 = q(0.75);
  return (n) => {
    if (n <= 0) return 0;
    if (n <= q1) return 1;
    if (n <= q2) return 2;
    if (n <= q3) return 3;
    return 4;
  };
}

function calendarSection(g, L) {
  const cal = g.calendar || [];
  const summary = el('p', 'growth-summary', summaryText(g));
  if (!cal.some((c) => c.turns > 0)) {
    return [el('p', 'hint growth-empty', GROWTH_TEXT.calendarEmpty), summary];
  }
  const { step, width, height } = L.cal;
  const size = step - CAL.gap;
  const level = heatLevels(cal.map((c) => c.turns));
  const today = g.today || cal[cal.length - 1].day;
  const root = chartSvg(width, height, '연습 잔디: 16주 동안 날마다 말한 문장 수');

  ['월', '수', '금'].forEach((name, k) => {
    root.append(svg('text', { class: 'axis', x: CAL.left - 6, y: CAL.top + (2 * k) * step + size / 2 + 4,
                              'text-anchor': 'end' }, name));
  });
  let lastLabel = -3;
  for (let c = 0; c < CAL.weeks; c += 1) {
    const monday = cal[c * 7];
    if (!monday) continue;
    const [, m] = parts(monday.day);
    const prev = c > 0 ? parts(cal[(c - 1) * 7].day)[1] : null;
    // A month is named over its first column; two names never crowd.
    if ((c === 0 || m !== prev) && c - lastLabel >= 3) {
      root.append(svg('text', { class: 'axis', x: CAL.left + c * step, y: CAL.top - 6 }, `${m}월`));
      lastLabel = c;
    }
  }

  const targets = [];
  cal.forEach((d, i) => {
    const x = CAL.left + Math.floor(i / 7) * step;
    const y = CAL.top + (i % 7) * step;
    const future = d.day > today;
    const cls = ['cal-cell', future ? 'is-future' : `lv${level(d.turns)}`];
    if (d.day === today) cls.push('is-today');
    root.append(svg('rect', { class: cls.join(' '), x, y, width: size, height: size, rx: 3 }));
    if (future) return;
    // The hit area is the whole slot, gap included -- bigger than the square.
    const hit = svg('rect', { class: 'hit', x: x - CAL.gap / 2, y: y - CAL.gap / 2, width: step, height: step });
    root.append(hit);
    targets.push({ node: hit, x: x + size / 2, y, text: dayTip(d) });
  });

  const wrap = chartWrap(root, width, height, targets, {
    ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1,
  });
  wrap.classList.add('growth-cal');

  const key = el('div', 'heat-key');
  key.append(el('span', '', '적음'));
  for (let n = 1; n <= 4; n += 1) key.append(el('span', `heat-swatch lv${n}`));
  key.append(el('span', '', '많음'));

  const rows = cal.filter((d) => d.turns > 0).slice().reverse()
    .map((d) => [dayName(d.day), `${d.turns}문장`]);
  return [wrap, key, summary, table(['날짜', '말한 문장'], rows)];
}

function summaryText(g) {
  const minutes = g.minutes || 0;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const total = h ? `${h}시간 ${m}분` : `${m}분`;
  return `연속 ${g.streak || 0}일 · 최장 ${g.longest || 0}일 · 총 ${total}`;
}

function dayTip(d) {
  return d.turns > 0 ? `${dayName(d.day)} · ${d.turns}문장` : `${dayName(d.day)} · 연습 안 함`;
}

/* ---------- 정확도 변화 ---------- */

function accuracySection(weeks, L) {
  if (!weeks.some((w) => w.graded > 0)) return [el('p', 'hint growth-empty', GROWTH_TEXT.accuracyEmpty)];
  const values = weeks.map((w) => (w.graded > 0 ? Math.round((w.correct / w.graded) * 100) : null));
  const last = weeks.length - 1;
  const chart = lineChart({
    width: L.acc.width, height: L.acc.height, values, yMax: 100, ticks: [0, 50, 100],
    fmt: (v) => `${v}%`, title: '주별 문장 정확도',
    xLabel: (i) => ((last - i) % 3 === 0 ? weekShort(weeks[i].week) : ''),
    tip: (i) => (weeks[i].graded > 0
      ? `${weekShort(weeks[i].week)} 주 · 정확도 ${values[i]}% (${weeks[i].correct}/${weeks[i].graded})`
      : `${weekShort(weeks[i].week)} 주 · 채점된 문장 없음`),
  });
  const rows = weeks.map((w, i) => [`${weekShort(w.week)} 주`,
    w.graded > 0 ? `${values[i]}%` : '—', w.graded > 0 ? `${w.correct}/${w.graded}` : '0']);
  return [chart, table(['주', '정확도', '맞은 문장/채점'], rows)];
}

/* ---------- 1분 말하기 ---------- */

/* Two charts, never one with two axes: words a minute and long pauses are
   different units, and a shared frame would invent a relation between them. */
function timedSection(rounds, L) {
  if (!rounds.length) return [el('p', 'hint growth-empty', GROWTH_TEXT.timedEmpty)];
  const last = rounds.length - 1;
  const xLabel = (i) => (i === 0 || i === last ? shortDay(rounds[i].day) : '');
  const small = (key, title, unit, tipText, head) => {
    const values = rounds.map((r) => r[key]);
    const max = niceCeil(Math.max(...values), true);
    const box = el('div', 'growth-small');
    box.append(el('p', 'growth-sub', title), lineChart({
      width: L.small.width, height: L.small.height, values, yMax: max, ticks: [0, max / 2, max],
      fmt: (v) => String(v), title, xLabel, tip: (i) => `${dayName(rounds[i].day)} · ${tipText(values[i])}`,
    }), table(['날짜', head], rounds.map((r, i) => [dayName(r.day), `${values[i]}${unit}`]).reverse()));
    return box;
  };
  const pair = el('div', `growth-pair${L.small.split ? ' is-split' : ''}`);
  pair.append(
    small('wpm', '분당 단어', '', (v) => `분당 ${v}단어`, '분당 단어'),
    small('long_pauses', '긴 멈춤', '번', (v) => `긴 멈춤 ${v}번`, '긴 멈춤'),
  );
  return [pair];
}

/* ---------- 레벨 테스트 기록 ---------- */

function rank(t) {
  return CEFR.indexOf(t.cefr) * 2 + (t.step === '상위' ? 1 : 0);
}

function testsSection(tests) {
  if (!tests.length) return el('p', 'hint growth-empty', GROWTH_TEXT.testsEmpty);
  const list = el('ol', 'growth-tests');
  tests.forEach((t, i) => {
    const li = el('li', 'growth-test');
    const when = new Date(t.finished_at);
    const date = Number.isNaN(when.getTime()) ? '' : `${when.getMonth() + 1}월 ${when.getDate()}일`;
    li.append(el('span', 'growth-test-date', date), el('b', 'growth-test-level', `${t.cefr} ${t.step}`),
              el('span', 'growth-test-scale', scaleText(t)));
    const older = tests[i + 1];
    if (older) {
      const diff = rank(t) - rank(older);
      const mark = el('span', `growth-delta${diff > 0 ? ' up' : diff < 0 ? ' down' : ''}`,
        diff > 0 ? '▲' : diff < 0 ? '▼' : '–');
      mark.setAttribute('aria-label', diff > 0 ? '지난번보다 올랐어요' : diff < 0 ? '지난번보다 내려갔어요' : '지난번과 같아요');
      li.append(mark);
    }
    list.append(li);
  });
  return list;
}

function scaleText(t) {
  if (t.jf) return t.jf;
  const out = [];
  if (t.ielts) out.push(`IELTS ${t.ielts}`);
  if (t.toefl && t.toefl.band) out.push(`TOEFL ${t.toefl.band}`);
  return out.join(' / ');
}

/* ---------- a line chart ---------- */

/* One series, one axis. `values[i]` null is a gap: no point there, and the
   line stops on one side and starts again on the other -- an empty week is
   not a zero. Each x gets a column-wide hit area, so the pointer finds the
   x rather than having to land on a 2px line. */
function lineChart({ width, height, values, yMax, ticks, fmt, title, xLabel, tip }) {
  const n = values.length;
  const plotW = width - LINE.left - LINE.right;
  const plotH = height - LINE.top - LINE.bottom;
  const band = plotW / n;
  const x = (i) => LINE.left + (i + 0.5) * band;
  const y = (v) => LINE.top + plotH - (Math.min(v, yMax) / (yMax || 1)) * plotH;
  const root = chartSvg(width, height, title);

  for (const t of ticks) {
    root.append(svg('line', { class: 'grid', x1: LINE.left, x2: width - LINE.right, y1: y(t), y2: y(t) }));
    root.append(svg('text', { class: 'axis', x: LINE.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t)));
  }
  values.forEach((_, i) => {
    const label = xLabel(i);
    if (label) root.append(svg('text', { class: 'axis', x: x(i), y: height - 6, 'text-anchor': 'middle' }, label));
  });

  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  root.append(svg('path', { class: 'series-line', d: d.trim() }));

  const targets = [];
  values.forEach((v, i) => {
    const has = v !== null && v !== undefined;
    if (has) root.append(svg('circle', { class: 'series-dot', cx: x(i), cy: y(v), r: 4 }));
    const hit = svg('rect', { class: 'hit', x: x(i) - band / 2, y: LINE.top - 8, width: band, height: plotH + 16 });
    root.append(hit);
    targets.push({ node: hit, x: x(i), y: has ? y(v) : LINE.top + plotH, text: tip(i) });
  });
  // The newest value, said once at its point; the rest live in the tooltip
  // and the table.
  const lastI = values.map((v) => v !== null && v !== undefined).lastIndexOf(true);
  if (lastI >= 0) {
    root.append(svg('text', { class: 'end-label', x: x(lastI), y: y(values[lastI]) - 9, 'text-anchor': 'middle' },
      fmt(values[lastI])));
  }
  return chartWrap(root, width, height, targets, { ArrowLeft: -1, ArrowRight: 1 });
}

/* ---------- tooltip and keys ---------- */

/* One tooltip per chart, placed by the point's own viewBox position as a
   percentage of the wrapper -- no measuring, no transform. Hover or focus
   shows it; the arrow keys walk the points while the chart has focus. */
function chartWrap(root, width, height, targets, keys) {
  const wrap = el('div', 'growth-chart');
  wrap.style.maxWidth = `${width}px`;
  const tip = el('div', 'growth-tip', NBSP);
  tip.setAttribute('aria-live', 'polite');
  let active = -1;

  const show = (i) => {
    const t = targets[i];
    if (!t) return;
    if (active >= 0 && targets[active]) targets[active].node.classList.remove('is-active');
    active = i;
    t.node.classList.add('is-active');
    tip.textContent = t.text;
    const left = (t.x / width) * 100;
    if (left <= 50) { tip.style.left = `${left.toFixed(2)}%`; tip.style.right = ''; }
    else { tip.style.right = `${(100 - left).toFixed(2)}%`; tip.style.left = ''; }
    tip.style.bottom = `calc(${(100 - (t.y / height) * 100).toFixed(2)}% + 10px)`;
    tip.classList.add('is-shown');
  };
  const hide = () => {
    tip.classList.remove('is-shown');
    if (active >= 0 && targets[active]) targets[active].node.classList.remove('is-active');
  };

  targets.forEach((t, i) => t.node.addEventListener('pointerenter', () => show(i)));
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focus', () => show(active >= 0 ? active : targets.length - 1));
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', (e) => {
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = targets.length - 1;
    else if (keys[e.key] !== undefined) next = (active < 0 ? targets.length - 1 : active) + keys[e.key];
    else return;
    e.preventDefault();
    show(Math.max(0, Math.min(targets.length - 1, next)));
  });
  wrap.append(root, tip);
  return wrap;
}

function chartSvg(width, height, label) {
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'group',
                            'aria-label': `${label} · 방향키로 하나씩 들어요`, tabindex: '0',
                            preserveAspectRatio: 'xMinYMin meet' });
  return root;
}

/* ---------- 표로 보기 ---------- */

function table(head, rows) {
  const box = el('details', 'growth-table');
  box.append(el('summary', '', GROWTH_TEXT.table));
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  head.forEach((h) => hr.append(el('th', '', h)));
  thead.append(hr);
  const tbody = el('tbody');
  rows.forEach((r) => {
    const tr = el('tr');
    r.forEach((c) => tr.append(el('td', '', String(c))));
    tbody.append(tr);
  });
  t.append(thead, tbody);
  box.append(t);
  return box;
}

/* ---------- helpers ---------- */

export function niceCeil(v, even = false) {
  if (!(v > 0)) return 2;
  const p = 10 ** Math.floor(Math.log10(v));
  let out = [1, 2, 2.5, 5, 10].map((m) => m * p).find((c) => c >= v);
  if (even) {
    out = Math.max(2, Math.ceil(out));
    if (out % 2) out += 1;
  }
  return out;
}

function parts(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return [y, m, d];
}

function dayName(day) {
  const [, m, d] = parts(day);
  return `${m}월 ${d}일`;
}

function shortDay(day) {
  const [, m, d] = parts(day);
  return `${m}/${d}`;
}

const weekShort = shortDay;

function block(label, ...children) {
  const box = el('section', 'growth-block');
  box.append(el('p', 'label', label), ...children);
  return box;
}

function skelLine(cls) {
  return el('p', `${cls} skeleton`, NBSP);
}

function svg(tag, attrs = {}, text = '') {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text) node.textContent = text;
  return node;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
