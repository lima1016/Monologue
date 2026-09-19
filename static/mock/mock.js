/* 시안 전용 스크립트. 앱 로직이 아니다:
   1) 시안 도구의 테마·밝기 버튼 (앱 설정과 섞이지 않게 mock-* 키에 저장)
   2) 예시 데이터로 16주 달력과 선 그래프를 그린다 -- 앱의 growth.js 와 같은
      모양(칸 크기, 여백, 클래스)을 흉내 내되, 칸 크기는 넓은 화면에 맞게 키운다.
   <head>에서 defer 없이 불러서 테마가 첫 페인트 전에 붙는다. */
(function () {
  var THEMES = ['default', 'forest', 'sea', 'lavender', 'ink', 'white'];
  var MODES = ['auto', 'light', 'dark'];
  var root = document.documentElement;
  var theme = 'default', mode = 'auto';
  try {
    theme = localStorage.getItem('mock-theme') || theme;
    mode = localStorage.getItem('mock-mode') || mode;
  } catch (e) { /* 저장소를 못 쓰면 기본값 */ }
  if (THEMES.indexOf(theme) < 0) theme = 'default';
  if (MODES.indexOf(mode) < 0) mode = 'auto';
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-mode', mode);

  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 무시 */ }
  }
  function sync() {
    var t = root.getAttribute('data-theme'), m = root.getAttribute('data-mode');
    each('[data-mock-theme]', function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mock-theme') === t)); });
    each('[data-mock-mode]', function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mock-mode') === m)); });
  }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }

  /* ---------- SVG ---------- */
  var NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function frame(w, h) {
    return svg('svg', { viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, role: 'img' });
  }

  /* 16주 달력. 오늘은 2026-09-19(토). 마지막 열이 이번 주(9/14 월 ~ 9/20 일). */
  var TODAY = new Date(2026, 8, 19);
  function calendarTurns() {
    var start = new Date(2026, 8, 14 - 15 * 7);
    var seed = 7;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    var days = [];
    for (var i = 0; i < 16 * 7; i += 1) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var dow = i % 7;                     // 0 = 월
      var week = Math.floor(i / 7);
      var p = 0.35 + week * 0.03;          // 갈수록 자주
      if (dow >= 5) p -= 0.2;              // 주말은 덜
      if (week === 9 || (week === 10 && dow < 3)) p = 0.04;  // 8월 초 휴가
      var turns = rnd() < p ? Math.round(3 + rnd() * (8 + week * 1.6)) : 0;
      var ymd = d.getMonth() * 100 + d.getDate();
      if (ymd === 817 || ymd === 818 || ymd === 819) turns = [14, 22, 9][ymd - 817]; // 최근 3일 연속
      if (ymd === 816) turns = 0;
      days.push({ date: d, turns: turns, future: d > TODAY, today: d.getTime() === TODAY.getTime() });
    }
    return days;
  }
  function heat(n) { return n <= 0 ? 0 : n <= 5 ? 1 : n <= 12 ? 2 : n <= 20 ? 3 : 4; }

  function drawCalendar(el) {
    var left = 24, top = 18, gap = 3;
    var maxStep = Number(el.getAttribute('data-maxstep')) || 40;
    var width = el.clientWidth || 600;
    var step = Math.max(12, Math.min(maxStep, Math.floor((width - left) / 16)));
    var size = step - gap;
    var w = left + 16 * step, h = top + 7 * step;
    var s = frame(w, h);
    s.setAttribute('aria-label', '연습 잔디: 16주 동안 날마다 말한 문장 수');
    ['월', '수', '금'].forEach(function (name, k) {
      s.appendChild(svg('text', { class: 'axis', x: left - 6, y: top + 2 * k * step + size / 2 + 4, 'text-anchor': 'end' }, name));
    });
    var days = calendarTurns();
    var lastMonth = -1, lastLabel = -3;
    days.forEach(function (d, i) {
      var col = Math.floor(i / 7), row = i % 7;
      if (row === 0 && d.date.getMonth() !== lastMonth && col - lastLabel >= 3) {
        s.appendChild(svg('text', { class: 'axis', x: left + col * step, y: top - 6 }, (d.date.getMonth() + 1) + '월'));
        lastLabel = col;
      }
      if (row === 0) lastMonth = d.date.getMonth();
      var cls = 'cal-cell ' + (d.future ? 'is-future' : 'lv' + heat(d.turns)) + (d.today ? ' is-today' : '');
      var r = svg('rect', { class: cls, x: left + col * step, y: top + row * step, width: size, height: size, rx: 3 });
      r.appendChild(svg('title', {}, (d.date.getMonth() + 1) + '/' + d.date.getDate() + ' · ' + (d.turns ? d.turns + '문장' : '연습 안 함')));
      s.appendChild(r);
    });
    el.replaceChildren(s);
  }

  /* 선 그래프: 축 하나, 값 하나. 빈 값은 끊긴다(빈 주는 0이 아니다). */
  function drawLine(el) {
    var L = { left: 38, right: 14, top: 20, bottom: 24 };
    var values = el.getAttribute('data-line').split(',').map(function (v) { return v === '' ? null : Number(v); });
    var labels = (el.getAttribute('data-labels') || '').split(',');
    var ticks = (el.getAttribute('data-ticks') || '0').split(',').map(Number);
    var yMax = Number(el.getAttribute('data-ymax')) || 100;
    var suffix = el.getAttribute('data-suffix') || '';
    var height = Number(el.getAttribute('data-h')) || 150;
    var width = Math.max(200, el.clientWidth || 300);
    var plotW = width - L.left - L.right, plotH = height - L.top - L.bottom;
    var band = plotW / values.length;
    function x(i) { return L.left + (i + 0.5) * band; }
    function y(v) { return L.top + plotH - (Math.min(v, yMax) / yMax) * plotH; }
    var s = frame(width, height);
    ticks.forEach(function (t) {
      s.appendChild(svg('line', { class: 'grid', x1: L.left, x2: width - L.right, y1: y(t), y2: y(t) }));
      s.appendChild(svg('text', { class: 'axis', x: L.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, t + suffix));
    });
    labels.forEach(function (lab, i) {
      if (lab) s.appendChild(svg('text', { class: 'axis', x: x(i), y: height - 6, 'text-anchor': 'middle' }, lab));
    });
    var d = '', pen = false, last = -1;
    values.forEach(function (v, i) {
      if (v === null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
      pen = true; last = i;
    });
    s.appendChild(svg('path', { class: 'series-line', d: d.trim() }));
    values.forEach(function (v, i) {
      if (v !== null) s.appendChild(svg('circle', { class: 'series-dot', cx: x(i), cy: y(v), r: 4 }));
    });
    if (last >= 0) s.appendChild(svg('text', { class: 'end-label', x: x(last), y: y(values[last]) - 9, 'text-anchor': 'middle' }, values[last] + suffix));
    el.replaceChildren(s);
  }

  function drawAll() {
    each('[data-cal]', drawCalendar);
    each('[data-line]', drawLine);
  }

  document.addEventListener('DOMContentLoaded', function () {
    each('[data-mock-theme]', function (b) {
      b.addEventListener('click', function () {
        root.setAttribute('data-theme', b.getAttribute('data-mock-theme'));
        save('mock-theme', b.getAttribute('data-mock-theme'));
        sync();
      });
    });
    each('[data-mock-mode]', function (b) {
      b.addEventListener('click', function () {
        root.setAttribute('data-mode', b.getAttribute('data-mock-mode'));
        save('mock-mode', b.getAttribute('data-mock-mode'));
        sync();
      });
    });
    sync();
    drawAll();
    var t = null;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(drawAll, 120); });
    // 시안에서는 버튼·탭이 눌린 것처럼만 보이면 된다: 링크가 아닌 # 는 이동하지 않게.
    each('a[href="#"]', function (a) { a.addEventListener('click', function (e) { e.preventDefault(); }); });
  });
})();
