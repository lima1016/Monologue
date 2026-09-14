# 화면 안정화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 화면 전환·다시 불러오기·알림·상태 줄·버튼 글자 변경 때 레이아웃이 튀지 않게 한다.

**Architecture:** 공용 부품(토스트 알림, 라우터 진입 애니메이션, `.is-invisible`/`.skeleton`/`.btn-stable`/`.is-refreshing` 유틸리티)을 먼저 만들고, 홈·테마 화면과 세션·리포트 화면이 그것을 쓴다.

**Tech Stack:** 브라우저 ES 모듈, CSS, `node --test`(dom-shim), pytest(CSS 규칙 검사).

**Spec:** `docs/superpowers/specs/2026-09-14-monologue-ui-stability-design.md`

## Global Constraints

- 작업 위치: 워크트리 `C:/git/Monologue-wt/ui-stability`, 브랜치 `ui-stability`. `C:/git/Monologue` 건드리지 않음(사용자 서버 + 생성 작업).
- node `node --test --test-force-exit static/js/*.test.js`(기준선 164). pytest `C:/git/Monologue/venv/Scripts/python.exe -m pytest -m "not engine" -q`(기준선 564 + 알려진 `test_kokoro_model_files_are_present` 1). engine 금지.
- 시간: 전환·페이드 **150ms**, 진입 이동 **6px**, 흐림 투명도 **0.55**. `prefers-reduced-motion: reduce`면 애니메이션 없음.
- CSS는 정의된 토큰만(`tests/test_css_tokens.py`). 새 시간 값은 토큰으로 추가해도 된다(`--dur-fast: 150ms`) -- 추가하면 라이트·다크 둘 다 정의 규칙을 지킨다(토큰 테스트가 요구하는 대로).
- 기존 사용자 문구는 바꾸지 않는다.
- 테스트에서 `hidden`을 확인하던 요소가 `.is-invisible`로 바뀌면 그 테스트를 새 방식으로 바꾼다(삭제하지 않는다). 바꾼 테스트 목록을 보고서에 적는다.
- 커밋 메시지 끝:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9
  ```

---

### Task 1: 공용 부품 — 토스트, 라우터 진입, 유틸리티

**Files:**
- Modify: `static/index.html`(`#notice`), `static/js/api.js`(`notify`, `setShown`), `static/js/router.js`(`show`), `static/css/base.css`, `static/css/components.css`, `static/css/tokens.css`(선택)
- Test: `static/js/router.test.js`(새 또는 기존 파일), `static/js/api.test.js`(새), `tests/test_ui_stability_css.py`(새)

**Interfaces:**
- `notify(message)` -- 비어 있지 않으면 토스트 텍스트를 바꾸고 보인다(`#notice.hidden = false`, `.is-leaving` 제거). 빈 문자열이면 숨긴다. 토스트 안 `#notice-close` 버튼이 누르면 `notify('')`. **텍스트는 `#notice-text`에 쓴다** -- 기존 테스트가 `$('notice').textContent`를 읽으므로 dom-shim에서 `#notice.textContent`도 메시지를 돌려주도록 `notify`가 `#notice-text.textContent`와 `#notice`의 데이터를 둘 다 맞춘다(아래 참고).
- `setShown(el, on)` -- 자리를 지키는 표시/숨김: `el.classList.toggle('is-invisible', !on)`, `el.setAttribute('aria-hidden', String(!on))`, `el.hidden = false`로 둔다.
- `router.show(name)` -- 기존대로 다른 화면 `hidden = true`, 들어오는 화면 `hidden = false`, 그리고 들어오는 화면에 `classList.add('screen-enter')`, 150ms 뒤 제거(`setTimeout`; 테스트는 즉시 클래스가 붙은 것만 확인). 같은 화면으로 다시 `show`하면 애니메이션을 다시 걸지 않는다(`active === name`).

**마크업:** `<p id="notice" class="notice" hidden>` → 

```html
<div id="notice" class="notice toast" role="status" aria-live="polite" hidden>
  <span id="notice-text"></span>
  <button id="notice-close" class="ghost" type="button" aria-label="알림 닫기">×</button>
</div>
```

`#notice`는 `<main>` 안에 두어도 되지만 `position: fixed`라 흐름에 영향이 없어야 한다.

**`notify` 구현:**

```js
export function notify(message) {
  const box = $('notice');
  const text = $('notice-text');
  if (text) text.textContent = message || '';
  // 기존 테스트와 호출자는 #notice.textContent로 메시지를 읽는다. 실제 DOM에서는
  // 자식 span의 글자가 그대로 textContent가 되고(× 버튼 글자는 aria로만 읽히게
  // CSS content로 그린다), dom-shim에서는 자식 글자를 모으지 않으므로 여기서도 맞춘다.
  if (!text) box.textContent = message || '';
  box.hidden = !message;
}
```

→ 실제 DOM에서 `#notice.textContent`가 메시지만 되려면 닫기 버튼의 글자 `×`가 텍스트 노드면 안 된다. 버튼은 비워 두고 `#notice-close::before { content: '×'; }`로 그린다(`aria-label` 유지). dom-shim에서 `$('notice').textContent`를 읽는 기존 테스트가 계속 통과하도록, dom-shim이 `textContent`를 자식에서 모으지 않는다면 `notify`가 `box.dataset.message = message`도 쓰고, **기존 테스트의 단언을 `$('notice-text').textContent`로 바꾼다**(바꾼 목록을 보고서에). 어느 쪽이 덜 침습적인지 구현자가 고르고 설명한다.

**CSS:**

```css
:root { --dur-fast: 150ms; }   /* tokens.css, 다크 블록 규칙이 요구하면 거기에도 */

html { scrollbar-gutter: stable; }

.toast {
  position: fixed; top: var(--space-4); left: 50%; transform: translateX(-50%);
  z-index: 30; display: flex; align-items: center; gap: var(--space-2);
  max-width: min(560px, calc(100vw - 2 * var(--space-4)));
  box-shadow: var(--shadow-lift);
  animation: fade-down var(--dur-fast) ease-out;
}
#notice-close { padding: 0 var(--space-2); line-height: 1; }
#notice-close::before { content: '×'; }

.screen-enter { animation: fade-down var(--dur-fast) ease-out; }
@keyframes fade-down { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.toast.screen-enter, .toast { /* toast keeps its translateX */ }
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.toast { animation-name: toast-in; }

.is-invisible { visibility: hidden; opacity: 0; }
.fade { transition: opacity var(--dur-fast) ease, visibility var(--dur-fast); }
.is-refreshing { opacity: .55; transition: opacity var(--dur-fast) ease; }

.skeleton {
  background: var(--surface-sunken); border-radius: var(--radius-sm);
  animation: skeleton-pulse 1.2s ease-in-out infinite;
}
@keyframes skeleton-pulse { 0%, 100% { opacity: .6; } 50% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .screen-enter, .toast, .skeleton { animation: none; }
  .fade, .is-refreshing { transition: none; }
}
```

(`.notice`의 기존 배경·색은 유지.)

- [ ] **Step 1: 실패하는 테스트**

`static/js/router.test.js`(없으면 새로 -- 기존 router 테스트가 다른 파일에 있으면 그 파일에):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $ } from './api.js';
import { resetDom } from './dom-shim.js';
import * as router from './router.js';

test('the entering screen gets the enter animation class; the others are hidden at once', () => {
  resetDom();
  router.register('home', 'home');
  router.register('pick', 'pick');
  router.show('home');
  router.show('pick');
  assert.equal($('home').hidden, true);
  assert.equal($('pick').hidden, false);
  assert.ok($('pick').classList.contains('screen-enter'));
});

test('showing the screen that is already active does not replay the animation', () => {
  resetDom();
  router.register('home', 'home');
  router.show('home');
  $('home').classList.remove('screen-enter');
  router.show('home');
  assert.equal($('home').classList.contains('screen-enter'), false);
});
```

(`router.js`의 `active`가 모듈 전역이라 테스트 순서에 영향이 있으면 `resetDom` 뒤 첫 `show`에서 다른 화면을 먼저 보여 준다.)

`static/js/api.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, notify, setShown } from './api.js';
import { resetDom } from './dom-shim.js';

test('notify shows a floating toast with the message and clears on empty', () => {
  resetDom();
  notify('서버에 연결하지 못했어요');
  assert.equal($('notice').hidden, false);
  assert.equal($('notice-text').textContent, '서버에 연결하지 못했어요');
  notify('');
  assert.equal($('notice').hidden, true);
});

test('setShown keeps the element in the layout', () => {
  resetDom();
  const el = $('start-status');
  setShown(el, false);
  assert.equal(el.hidden, false);
  assert.ok(el.classList.contains('is-invisible'));
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  setShown(el, true);
  assert.equal(el.classList.contains('is-invisible'), false);
});
```

`tests/test_ui_stability_css.py`:

```python
from pathlib import Path

CSS = (Path(__file__).resolve().parents[1] / "static" / "css")


def _all_css():
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(CSS.glob("*.css")))


def test_notice_floats_instead_of_pushing_the_page():
    css = _all_css()
    assert ".toast" in css and "position: fixed" in css.split(".toast", 1)[1].split("}", 1)[0]


def test_stability_utilities_exist():
    css = _all_css()
    for rule in (".is-invisible", ".skeleton", ".is-refreshing", ".screen-enter", "scrollbar-gutter: stable"):
        assert rule in css, rule


def test_motion_is_switched_off_for_reduced_motion():
    css = _all_css()
    block = css.split("prefers-reduced-motion: reduce", )
    assert any(".screen-enter" in b.split("}", 3)[0] + b for b in block[1:]), "screen-enter must be disabled"
```

(마지막 테스트의 파싱은 느슨하다 -- 구현자가 reduced-motion 블록 안에 `.screen-enter`와 `.skeleton`이 있는지 정확히 검사하도록 다듬어도 된다.)

- [ ] **Step 2: RED.** **Step 3: 구현.** `main.js`에 `#notice-close` 클릭 → `notify('')`.
- [ ] **Step 4: GREEN** — node 전체, pytest 전체. `main.test.js`의 id 검사.
- [ ] **Step 5: 부수기** — `screen-enter` 추가 줄 삭제 → 라우터 테스트 FAIL; `.toast`의 `position: fixed` 삭제 → CSS 테스트 FAIL; `setShown`이 `hidden=true`로 → setShown 테스트 FAIL. 되돌리고 GREEN.
- [ ] **Step 6: 커밋** — `feat: a floating notice, screens that ease in, and utilities that keep their place`

---

### Task 2: 홈과 테마 화면이 튀지 않게

**Files:**
- Modify: `static/js/home.js`, `static/js/pick.js`, `static/index.html`, `static/css/components.css`, `static/js/home.test.js`, `static/js/pick.test.js`

**Interfaces:**
- Consumes: Task 1 `setShown`, `.is-invisible`, `.skeleton`, `.is-refreshing`, `.btn-stable`(이 태스크에서 CSS 추가).

**규칙:**
- `loadHome()`:
  - 홈에 이미 그린 적이 있으면(`#home.dataset.painted === '1'`) 카드를 숨기지 않는다. 대신 `.home-main`과 `.home-aside`에 `.is-refreshing`을 붙인다. 응답이 오면 제자리에서 다시 그리고 `.is-refreshing`을 뗀다. 늦게 온 다른 언어 응답은 지금처럼 버리되 `.is-refreshing`은 최신 요청이 끝날 때 뗀다.
  - 처음(`painted` 없음): 추천 카드 자리에 스켈레톤(제목 줄·설명 두 줄·버튼 줄 크기의 `.skeleton` 블록) + 기존 `오늘의 추천 불러오는 중...` 문구. 이번 주 카드는 스켈레톤으로 **보이게** 둔다(7칸 점 줄·진행 줄 크기). 이어서 하기는 그대로 숨김(있을지 모름 -- 흐름 오른쪽 위라 뒤늦게 나타나도 왼쪽을 밀지 않는다; 아래 곁칸 카드가 밀리는 것은 허용하되 **곁칸 맨 아래로 이어서 하기 자리를 옮기지 않는다** -- 스펙 순서 유지).
  - 성공 뒤 `dataset.painted = '1'`.
  - 실패: 처음이면 기존처럼 추천 카드 숨김. 이미 그렸으면 이전 내용을 유지하고 `.is-refreshing`만 뗀다(+ 기존 문구 없음).
  - 기록이 없는 사용자(`has_history` false)로 바뀌는 경우는 그때 숨긴다(내용이 바뀌는 것이므로).
- `#today-alt`, `#library-progress`: `setShown`으로 자리 유지. 단, 준비 상태 줄이 **완성되어 영영 필요 없을 때**(`scripts >= target`)는 `hidden = true`(자리를 계속 차지할 이유가 없음).
- 추천 카드 교체(`swapToday`): 본문에 `.fade`를 두고, 교체 전에 150ms 동안 `.is-invisible`→ 새 내용 → 보이기. (테스트에서는 타이머 없이 즉시 바뀌어도 되도록 `swapToday`가 동기 교체 후 클래스만 붙였다 떼는 방식이어도 된다 -- 기존 테스트 유지가 우선.)
- 테마 화면 `loadThemes`: 로딩 중 `#theme-grid`에 **카드 크기 스켈레톤 5개**(`.theme-card.skeleton`, 비활성) + 기존 `테마 불러오는 중...` 문구(스켈레톤 위 한 줄). 기존 테스트가 이 문구를 찾는 방식은 유지.
- `#start-status`: `setShown`으로 자리 유지(`setStatus(null)`은 글자를 비우고 `is-invisible`). 최소 높이는 한 줄.
- `.btn-stable`: `min-width`를 가장 긴 문구에 맞춘다 -- 추천 카드 시작 버튼(`스크립트로 시작`), `#btn-start`. CSS에 `.today-actions .primary, .today-actions .ghost, #btn-start { min-width: ... }`처럼 구체 선택자로 둬도 된다.
- 언어 전환(`main.js` 핸들러): 홈이면 `loadHome()`(위 규칙으로 흐림), 테마 화면이면 `loadThemes()`(스켈레톤).

- [ ] **Step 1: 실패하는 테스트** (`home.test.js`)

```js
test('reloading home keeps the painted cards in place and dims them while it waits', async () => {
  let release;
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD()); } });
  const reloading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('week-card').hidden, false, 'the week card must not collapse during a reload');
  assert.equal($('today-card').hidden, false);
  assert.ok(document.querySelector ? true : true);
  assert.ok($('home').children.some((c) => c.classList.contains('is-refreshing')) || $('home').classList.contains('is-refreshing'));
  release();
  await reloading;
  assert.equal($('home').children.some((c) => c.classList.contains('is-refreshing')) || $('home').classList.contains('is-refreshing'), false);
});

test('the first load shows skeletons where the cards will be', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD()); } });
  const loading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(hasClass($('today-body'), 'skeleton'));
  assert.equal($('week-card').hidden, false);
  assert.ok(hasClass($('week-card'), 'skeleton'));
  release();
  await loading;
  assert.equal(hasClass($('today-body'), 'skeleton'), false);
});

test('the alternative line keeps its place when there is no alternative', async () => {
  homeRoutes(PAYLOAD({ recommend: [PAYLOAD().recommend[0]] }));
  await home.loadHome();
  assert.equal($('today-alt').hidden, false);
  assert.ok($('today-alt').classList.contains('is-invisible'));
});
```

(`hasClass(el, cls)`는 자식까지 훑는 헬퍼 -- 기존 파일에 비슷한 헬퍼가 있으면 그것. `#home`의 어느 요소에 `.is-refreshing`을 붙일지는 구현에 맞춰 단언을 좁힌다.)

`pick.test.js`:

```js
test('while themes load the grid holds theme-sized skeleton cards', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  stubFetch(async (url) => {
    if (url.startsWith('/api/themes')) { await held; return jsonResponse({ themes: THEMES }); }
    return jsonResponse({ scenarios: [] });
  });
  const opening = pick.openPick('script');
  await new Promise((r) => setTimeout(r, 0));
  const skeletons = $('theme-grid').children.filter((c) => c.classList.contains('skeleton'));
  assert.equal(skeletons.length, 5);
  release();
  await opening;
  assert.equal($('theme-grid').children.filter((c) => c.classList.contains('skeleton')).length, 0);
});

test('the step line keeps its place when idle', async () => {
  routes();
  await pick.openPick('script');
  assert.equal($('start-status').hidden, false);
  assert.ok($('start-status').classList.contains('is-invisible'));
});
```

기존 테스트 중 `$('start-status').hidden`, `$('today-alt').hidden`, `$('library-progress').hidden`을 단언하던 것은 `.is-invisible` 기준으로 바꾼다.

- [ ] **Step 2: RED.** **Step 3: 구현.** **Step 4: GREEN**(node 전체, CSS pytest).
- [ ] **Step 5: 부수기** — `loadHome`의 painted 분기를 없애 항상 숨기게 → reload 테스트 FAIL; `loadThemes` 스켈레톤 삭제 → pick 스켈레톤 FAIL; `setStatus(null)`이 `hidden=true` → 자리 유지 FAIL. 되돌리고 GREEN.
- [ ] **Step 6: 커밋** — `fix: home and the theme screen reload in place, with skeletons and steady lines`

---

### Task 3: 세션·리포트 화면이 출렁이지 않게

**Files:**
- Modify: `static/js/session.js`, `static/index.html`, `static/css/components.css`, `static/js/session.test.js`, `static/js/suggest.js`(카드 제거 페이드가 필요하면), `static/js/reading.js`(뜻 펼침 페이드는 선택)

**규칙:**
- `#mic-dock`: `#btn-cancel`은 `setShown`(자리 유지). `#mic-hint`는 두 줄 고정 높이(`min-height: calc(2 * 1.55em)`, `-webkit-line-clamp: 2`, `display: -webkit-box`, `overflow: hidden`); 긴 실시간 인식 문구는 **뒤쪽이 보이게** -- JS에서 80자 넘으면 앞을 `…`로 줄여 넣는다(`clampHint(text)`). `#thinking`은 `setShown`(자리 유지) -- 대화창 맨 아래 한 줄 높이를 늘 차지.
- `syncControls`에서 `hidden`으로 쓰던 위 셋을 `setShown`으로.
- 교정 칩 상세(`addChip`): `.chip-detail`을 `hidden` 토글 대신 `.chip-detail.is-collapsed` 토글 + CSS `display: grid; grid-template-rows: 1fr; transition: grid-template-rows var(--dur-fast)`, `.is-collapsed { grid-template-rows: 0fr; }`, 안쪽 래퍼 `overflow: hidden`. `aria-expanded` 유지.
- 새 말풍선·칩: `.msg`, `.chip-row`, `.suggest-card`에 `animation: fade-down var(--dur-fast)`(reduced-motion 해제).
- 리포트 대기 카드(`.report-wait`): 150ms 페이드 인.
- `#btn-end`(글자가 `리포트 만드는 중...`으로 바뀜): `min-width` 고정.
- 대본 패널 현재 줄 강조 전환: `background-color` transition.

- [ ] **Step 1: 실패하는 테스트** (`session.test.js`)

```js
test('the mic dock keeps its layout: cancel keeps its place while idle', () => {
  resetDom();
  session.setTurnState('CANCEL');   // back to idle from anywhere the existing tests use
  assert.equal($('btn-cancel').hidden, false);
  assert.ok($('btn-cancel').classList.contains('is-invisible'));
  session.setTurnState('MIC');
  assert.equal($('btn-cancel').classList.contains('is-invisible'), false);
});

test('the thinking dots keep their place when the bot is not thinking', () => {
  resetDom();
  session.setTurnState('CANCEL');
  assert.equal($('thinking').hidden, false);
  assert.ok($('thinking').classList.contains('is-invisible'));
});

test('a long live transcript is clamped from the front so the newest words stay visible', () => {
  const long = 'word '.repeat(40).trim();
  const out = session.clampHint(long);
  assert.ok(out.length <= 81);
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('word'));
  assert.equal(session.clampHint('short'), 'short');
});

test('a correction chip expands by class, not by hiding', () => {
  resetDom();
  state.language = 'en';
  const bubble = session.addMessage('user', 'I go there');
  const wrap = session.addChip(bubble, { ok: false, fixed: 'I went there.', tag: '시제', correction: 'c', suggestion: null });
  const [summary, detail] = wrap.children;
  assert.equal(detail.hidden, false);
  assert.ok(detail.classList.contains('is-collapsed'));
  summary.listeners.click[0]();
  assert.equal(detail.classList.contains('is-collapsed'), false);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
});
```

기존 테스트 중 `$('btn-cancel').hidden`/`$('thinking').hidden`/`detail.hidden`을 단언하던 것은 새 방식으로 바꾼다(목록을 보고서에). 이 파일의 idle로 되돌리는 이벤트 이름이 `CANCEL`이 아니면 기존 테스트가 쓰는 것을 따른다.

- [ ] **Step 2: RED.** **Step 3: 구현.** **Step 4: GREEN**(node 전체, CSS pytest).
- [ ] **Step 5: 부수기** — `syncControls`의 cancel을 `hidden`으로 되돌림 → dock 테스트 FAIL; `clampHint` 앞 자르기를 뒤 자르기로 → clamp FAIL; 칩을 `hidden` 토글로 → 칩 FAIL. 되돌리고 GREEN.
- [ ] **Step 6: 커밋** — `fix: the session screen holds still -- steady mic dock, gentle chips and bubbles`

---

## 운영 (컨트롤러)

1. 8010(DB 스냅샷)에서 `layout_probe`로 변경 전 기준과 비교(홈 언어 전환 85px → 0 목표), 세션 화면은 텍스트 입력으로 한 턴 보내며 `#mic-dock` 높이가 변하지 않는지 측정, 알림을 강제로 띄워 레이아웃 이동 0 확인. 데스크톱·400px 스크린샷.
2. main 머지 → 8000 재시작(정적 파일만이면 새로고침으로 충분).
3. 이어서 마이페이지 Task 3·4 브리프에 "이 규칙(`setShown`, `.skeleton`, `.is-refreshing`, `.btn-stable`, 토스트)을 따른다"를 넣는다.
