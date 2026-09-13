# Monologue 시각 아이덴티티 재설계 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈·리포트를 2단 배치로 바꾸고, 따뜻한 팔레트와 Pretendard를 앱 전체에 적용한다.

**Architecture:** 배치는 전부 `static/css/tokens.css`의 토큰 위에 얹혀 있다. 그래서 토큰을 먼저 갈아끼우고(2~3), 새 배치가 필요로 하는 데이터를 서버에 만든 뒤(4~5), 화면을 고친다(6~8). 첫 번째 태스크는 코드가 아니라 **가드**다 — 정의되지 않은 `var()`는 에러가 아니라 조용히 무효라서, 토큰 이름을 하나 놓치면 CSS가 무너져도 스위트는 초록으로 남는다.

**Tech Stack:** FastAPI + SQLite (ORM 없음), 바닐라 ES 모듈 프론트엔드, pytest, `node --test`

**Spec:** `docs/superpowers/specs/2026-09-06-monologue-visual-identity-design.md`

## Global Constraints

- **테스트 기준선:** `pytest -m "not engine" -q` → 293 passed / 8 deselected. `node --test 'static/js/*.test.js'` → 61. 태스크마다 이 둘을 돌리고, 늘어난 개수만 늘어야 한다
- **모든 새 테스트는 일부러 부숴서 빨개지는지 확인한다.** 이 프로젝트에서 벙어리 하네스가 실제로 잡힌 적이 있다. 각 태스크의 "역방향 확인" 단계를 건너뛰지 않는다
- **토큰 소스는 `static/css/tokens.css` 하나뿐이다.** `assets/design-tokens.*`를 만들지 않는다
- **LLM 프롬프트(`app/prompts.py`)와 응답 스키마를 건드리지 않는다.** 리포트 품질 회귀를 이 작업에서 만들지 않는다
- **`dom-shim.js`는 CSS 선택자를 지원하지 않는다** (`querySelector`가 항상 `null`). 프론트엔드 코드는 `$('id')`와 `classList`만 쓴다. `querySelector`를 쓰면 테스트에서 조용히 `null`을 받는다
- **서버 포트:** 사용자가 8000을 쓴다. 확인용으로 서버를 띄워야 하면 **8010**을 쓰고, DB는 항상 복사본을 쓴다
- **세션별 등급(`B+` 등)을 만들지 않는다.** `db.py`의 `stable_level()`이 "한 세션의 추정치는 노이즈"라고 이미 결론냈다
- **3회 미만 태그를 약점으로 보여주지 않는다.** `home_stats()`의 기존 규칙이다

---

### Task 1: 토큰 가드 — 이름 대조 + 다크/라이트 대칭

먼저 만드는 이유: 태스크 2가 토큰 이름을 대거 바꾼다. 이 테스트가 없으면 오타 하나가
조용히 통과한다.

**Files:**
- Create: `tests/test_css_tokens.py`

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (순수 가드). 태스크 2~8이 이 테스트에 의존한다

**스펙에서 고친 것:** 스펙 E-2는 "라이트가 정의한 색이 다크에서 재정의됐는지"로 썼지만,
현재 코드가 그걸 통과하지 못한다 — `--correct`와 `--suggest`는 라이트에만 있고 두 스킴에서
같은 색으로 쓰인다. `tokens.css`의 실제 규칙은 반대 방향이다: *"색을 다크 블록 안에서만
정의하지 말 것."* 그래서 **다크 ⊆ 라이트**를 검사한다.

- [ ] **Step 1: 테스트를 쓴다**

```python
"""tokens.css가 정의하는 이름과 나머지 CSS가 참조하는 이름을 대조한다.

이 작업의 실패 방식을 정확히 겨냥한 계기다. 정의되지 않은 var()는 CSS 에러가
아니라 무효 선언이라, 토큰 이름 오타 하나로 화면이 무너져도 파이썬 스위트도
노드 스위트도 초록으로 남는다. 어느 쪽도 CSS를 읽지 않기 때문이다.
"""
import re
from pathlib import Path

CSS_DIR = Path(__file__).resolve().parent.parent / "static" / "css"

DEFINE_RE = re.compile(r"^\s*(--[\w-]+)\s*:", re.M)
# var(--x) 와 var(--x, fallback) 을 모두 잡는다.
REFERENCE_RE = re.compile(r"var\(\s*(--[\w-]+)")


def _css_files():
    files = sorted(CSS_DIR.glob("*.css"))
    assert files, f"CSS 파일을 하나도 못 찾았다: {CSS_DIR}"
    return files


def test_every_referenced_token_is_defined():
    defined, referenced = set(), {}
    for path in _css_files():
        text = path.read_text(encoding="utf-8")
        defined |= set(DEFINE_RE.findall(text))
        for name in REFERENCE_RE.findall(text):
            referenced.setdefault(name, path.name)

    missing = {n: f for n, f in referenced.items() if n not in defined}
    assert not missing, f"정의되지 않은 토큰을 참조한다: {missing}"


def _root_block(text, marker):
    """marker 로 시작하는 선언 블록의 본문."""
    start = text.index(marker) + len(marker)
    depth, i = 1, start
    while depth:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return text[start:i - 1]


def test_dark_defines_nothing_light_does_not():
    """다크 블록에만 있는 토큰이 없어야 한다.

    tokens.css의 규칙: "라이트 먼저, 다크는 같은 이름을 다시 정의하는 것으로
    처리 -- 색을 다크 블록 안에서만 정의하지 말 것." 다크에만 있는 이름은 라이트
    스킴에서 그냥 무효가 된다.
    """
    text = (CSS_DIR / "tokens.css").read_text(encoding="utf-8")
    light = set(DEFINE_RE.findall(_root_block(text, ":root {")))
    dark_media = text[text.index("@media (prefers-color-scheme: dark)"):]
    dark = set(DEFINE_RE.findall(dark_media))

    dark_only = dark - light
    assert not dark_only, f"다크 블록에만 정의된 토큰: {dark_only}"
```

- [ ] **Step 2: 현재 코드에서 통과하는지 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v`
Expected: 2 passed. (현재 코드는 두 규칙을 이미 지키고 있다)

- [ ] **Step 3: 역방향 확인 — 일부러 부숴서 빨개지는지 본다**

이 단계를 건너뛰면 벙어리 하네스를 만든 것이다. 두 번 부순다:

```bash
# (a) 참조는 하는데 정의는 없는 이름을 만든다
sed -i 's/var(--accent-soft)/var(--accent-sofa)/' static/css/components.css
venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v
# Expected: test_every_referenced_token_is_defined FAILED, 메시지에 --accent-sofa
git checkout static/css/components.css

# (b) 다크에만 있는 토큰을 만든다
#     tokens.css 의 @media 블록 안에 --only-dark: #000; 한 줄을 손으로 넣는다
venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v
# Expected: test_dark_defines_nothing_light_does_not FAILED, 메시지에 --only-dark
git checkout static/css/tokens.css
```

두 번 다 빨개지지 않으면 테스트가 아무것도 안 보고 있는 것이다. 멈추고 고친다.

- [ ] **Step 4: 전체 스위트**

Run: `venv/Scripts/python.exe -m pytest -m "not engine" -q`
Expected: 295 passed / 8 deselected (293 + 새로 2개)

- [ ] **Step 5: 커밋**

```bash
git add tests/test_css_tokens.py
git commit -m "test: catch token names that are referenced but never defined

An undefined var() is not a CSS error, it is an invalid declaration.
A typo in a token name takes the screen apart while both suites stay
green, because neither of them reads CSS. This is the only instrument
that looks."
```

---

### Task 2: 새 팔레트 · 타입 스케일 · 반경

**Files:**
- Modify: `static/css/tokens.css` (전면 교체)

**Interfaces:**
- Consumes: Task 1의 테스트
- Produces: `--font-sans`, `--text-3xl`, `--shadow-lift`, `--aside-w` (태스크 3·6·7이 쓴다).
  기존 이름은 **하나도 지우지 않는다** — 값만 바뀐다

- [ ] **Step 1: `static/css/tokens.css`를 아래로 교체**

```css
/* Design tokens. Light first, with dark handled by redefining the same names --
   never define a colour only inside the dark block. tests/test_css_tokens.py
   holds both halves of that rule. */
:root {
  /* Lets native widgets -- select popups, radios, scrollbars -- follow the OS
     scheme. Our own tokens only cover what we paint ourselves. */
  color-scheme: light dark;

  /* Pretendard is served from static/fonts (see fonts.css). The stack behind it
     is a real fallback, not decoration: on the one machine this app runs on,
     system-ui resolves Hangul to Malgun Gothic, which is the look this palette
     was chosen to get away from. */
  --font-sans: Pretendard, system-ui, -apple-system, "Segoe UI", sans-serif;

  --bg: #faf5ef;
  --surface: #fffdfa;
  /* Must stay visibly distinct from --bg, not merely different from it. The
     old cool palette sat at 1.04:1 here and .msg.bot rendered as bare text on
     the page; 1.12:1 was the value that fixed it. This warm pair is 1.13:1 --
     the same argument, recomputed for the new hues. */
  --surface-sunken: #f0e7da;
  --line: #e8ded0;
  --text: #2b2520;          /* 14.0:1 on --bg */
  /* 4.89:1 on --bg. This one carries body-sized text (hints, mode
     descriptions), so it clears 4.5:1 rather than sitting just under it. */
  --text-dim: #756a5e;
  /* Placeholders and small labels only -- under 4.5:1, the same call the
     previous palette made for the same role. */
  --text-faint: #a2968a;

  --accent: #a85a3c;
  --accent-soft: #f6e9e0;
  --accent-ink: #8e4830;    /* 5.66:1 on --accent-soft */
  /* Ink for anything painted on an --accent fill: the primary button, the
     resume card, the mic glyph, and the focus ring on a control that sits on
     the card (an --accent ring on an --accent background is invisible).
     5.01:1 on --accent. Restated in the dark block on purpose -- see there. */
  --on-accent: #fffaf5;

  /* Correction and suggestion stay toned down: a learner sees these every
     single turn, and red/green reads as being told off.

     The correction hue moved from coral (#e8896b) to a dusty rose when the
     accent became terracotta. Coral and terracotta are the same family -- with
     both on screen, "here is what to fix" and "here is what to press" stopped
     being distinguishable. Rose pulls the correction away from the accent
     without going back to red. */
  --correct: #b5615f;
  --correct-bg: #fbeeed;
  --correct-ink: #6d3230;   /* 8.6:1 on --correct-bg */
  --suggest: #6f9469;
  --suggest-bg: #eff4ec;
  --suggest-ink: #3a5235;   /* 7.63:1 on --suggest-bg */

  /* System notices (Ollama/VOICEVOX down, etc.), kept separate from the
     correction palette above -- a warning is not a grammar correction. */
  --warn-bg: rgba(180, 120, 20, .16);
  --warn-ink: #7a4f12;

  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px;

  /* --text-3xl is new, for the home greeting and the report headline. The old
     scale topped out at 25px, which left too little distance between "the
     largest thing on the screen" and body text -- half of why the screen read
     as having no hierarchy. */
  --text-xs: 11.5px; --text-sm: 13px;  --text-base: 15px;
  --text-lg: 17px;   --text-xl: 21px;  --text-2xl: 27px; --text-3xl: 34px;

  --radius-sm: 10px; --radius: 14px; --radius-lg: 18px; --radius-pill: 999px;
  --shadow: 0 1px 3px rgba(90, 60, 30, .10);
  /* The start button only. It is the one thing on the home screen that should
     look liftable. */
  --shadow-lift: 0 4px 14px rgba(168, 90, 60, .26);

  /* Layout dimensions -- these don't vary with the colour scheme, so they live
     only in the light block. --aside-w is the right-hand column on the home and
     report screens; --panel-w is the session screen's goal panel, which is a
     different column on a different screen and keeps its own value. */
  --aside-w: 330px;
  --panel-w: 300px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1613;
    --surface: #241f1a;
    --surface-sunken: #201b17;
    --line: #372f28;
    --text: #f0e8df;
    --text-dim: #a99c8e;
    --text-faint: #8b7f72;
    --accent: #d98b64;
    --accent-soft: #33261e;
    --accent-ink: #e8a582;
    /* Dark ink, not white. --accent inverts between schemes: a deep terracotta
       in light, a light apricot here. White on this fill washes out the 시작
       button, the resume card and the mic glyph. Every use of this token is
       something drawn on top of --accent, so it flips as one. */
    --on-accent: #1a1613;
    --correct-bg: #2e1f1e;
    --correct-ink: #eaa9a5;
    --suggest-bg: #1c2620;
    --suggest-ink: #a9cfa2;
    --warn-bg: rgba(200, 140, 0, .18);
    --warn-ink: #e0b34d;
    --shadow: 0 2px 8px rgba(0, 0, 0, .45);
    --shadow-lift: 0 4px 14px rgba(0, 0, 0, .5);
  }
}
```

- [ ] **Step 2: 가드 테스트가 여전히 통과하는지**

Run: `venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v`
Expected: 2 passed. 실패하면 이름을 지웠거나 다크에만 넣은 것이다 — 되돌린다.

- [ ] **Step 3: 전체 스위트**

Run: `venv/Scripts/python.exe -m pytest -m "not engine" -q`
Expected: 295 passed / 8 deselected

- [ ] **Step 4: 커밋**

```bash
git add static/css/tokens.css
git commit -m "feat: warm palette, taller type scale, softer radii

Every contrast figure in the old file was recomputed for the new hues
rather than carried over: --surface-sunken lands at 1.13:1 against --bg
on the same argument that set 1.12:1 before, and --on-accent still flips
to near-black in dark because --accent inverts between the two schemes.

The correction colour moved from coral to a dusty rose. Coral and the
new terracotta accent are the same family, and with both on screen
'what to fix' and 'what to press' stopped being distinguishable."
```

---

### Task 3: Pretendard 자체 호스팅

**Files:**
- Create: `static/fonts/PretendardVariable.woff2`
- Create: `static/css/fonts.css`
- Modify: `static/index.html` (스타일시트 링크 추가)
- Modify: `static/css/base.css` (`body` 의 `font-family`)
- Create: `tests/test_fonts.py`

**Interfaces:**
- Consumes: Task 2의 `--font-sans`
- Produces: 없음

- [ ] **Step 1: 폰트 파일을 받는다**

```bash
mkdir -p static/fonts
curl -L -o static/fonts/PretendardVariable.woff2 \
  https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/woff2/PretendardVariable.woff2
ls -l static/fonts/PretendardVariable.woff2
```

받은 크기를 확인한다. **1.5MB를 넘으면** 여기서 멈추고 한글 서브셋(`pretendard-subset`
빌드)으로 바꾼 뒤 진행한다. `.gitignore`의 `engines/` 규칙은 수백 MB 모델 가중치를 겨냥한
것이라 이 파일에는 적용하지 않는다 — 커밋한다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

```python
"""폰트를 자체 호스팅한다는 결정을 지키는 계기.

CDN 링크로 되돌아가면 이 앱은 인터넷이 끊긴 날 멀쩡히 돌면서 글꼴만 맑은 고딕으로
떨어진다 -- 고치려던 문제가 조용히 되살아나는 실패 방식이고, 화면을 열어보지
않으면 아무도 모른다.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONTS_CSS = ROOT / "static" / "css" / "fonts.css"
FONT_FILE = ROOT / "static" / "fonts" / "PretendardVariable.woff2"


def test_font_file_is_committed_and_real():
    assert FONT_FILE.exists(), "Pretendard woff2 가 static/fonts 에 없다"
    size = FONT_FILE.stat().st_size
    assert size > 100_000, f"폰트 파일이 너무 작다({size}B) -- 받다 만 것 아닌가"
    assert size < 1_500_000, f"폰트 파일이 {size}B -- 한글 서브셋을 떠야 한다"


def test_fonts_css_is_self_hosted():
    text = FONTS_CSS.read_text(encoding="utf-8")
    assert "@font-face" in text
    assert "/fonts/PretendardVariable.woff2" in text
    assert "font-display: swap" in text
    for host in ("http://", "https://", "//cdn."):
        assert host not in text, f"폰트를 원격에서 받고 있다: {host}"
```

- [ ] **Step 3: 실패를 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_fonts.py -v`
Expected: `test_fonts_css_is_self_hosted` FAILED — `fonts.css` 가 없다.
(`test_font_file_is_committed_and_real` 은 Step 1을 했으면 통과한다)

- [ ] **Step 4: `static/css/fonts.css`를 만든다**

```css
/* Pretendard, served from this app. Deliberately not a CDN: Ollama and
   VOICEVOX both run locally, so this app works with no internet -- and a
   remote font would mean that on an offline day everything keeps working
   except the typeface, which silently falls back to Malgun Gothic. That is
   the exact look the visual rebuild was for.

   One variable file covers every weight the app uses (450 body, 650 headings,
   750 the greeting), so there is one request rather than four. */
@font-face {
  font-family: Pretendard;
  src: url("/fonts/PretendardVariable.woff2") format("woff2-variations");
  font-weight: 45 920;
  font-style: normal;
  /* The fallback stack renders immediately and is swapped when the file
     lands. A blocking load would leave the first paint blank on a cold
     cache, and this screen is opened every day. */
  font-display: swap;
}
```

- [ ] **Step 5: `static/index.html`에서 tokens.css보다 먼저 링크**

`<link rel="stylesheet" href="/css/tokens.css">` 바로 위에 넣는다:

```html
<link rel="stylesheet" href="/css/fonts.css">
```

- [ ] **Step 6: `static/css/base.css`의 `body`에서 토큰을 쓴다**

```css
  font-family: var(--font-sans);
```

(`system-ui, -apple-system, "Segoe UI", sans-serif` 를 지운 자리다. 폴백 스택은
`--font-sans` 안에 이미 들어 있다.)

- [ ] **Step 7: 정적 파일이 실제로 서빙되는지 확인한다**

`app/main.py`가 `static/`을 마운트하는 방식에 따라 `/fonts/*` 가 404일 수 있다.
확인한다:

```bash
grep -n "StaticFiles\|mount" app/main.py
```

`/css`, `/js` 처럼 디렉터리별로 마운트하고 있으면 `/fonts` 마운트를 같은 방식으로 추가한다.
`static/` 전체를 루트에 마운트하고 있으면 할 일이 없다.

- [ ] **Step 8: 테스트 통과 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_fonts.py -v`
Expected: 2 passed

- [ ] **Step 9: 역방향 확인**

```bash
# fonts.css 의 url 을 CDN 으로 바꿔본다
sed -i 's|url("/fonts/|url("https://cdn.jsdelivr.net/fonts/|' static/css/fonts.css
venv/Scripts/python.exe -m pytest tests/test_fonts.py -v
# Expected: test_fonts_css_is_self_hosted FAILED
git checkout static/css/fonts.css
```

- [ ] **Step 10: 눈으로 확인**

서버를 8010에 띄우고 브라우저에서 홈을 연다. 글자가 맑은 고딕이 아니어야 한다.
개발자 도구 Network 탭에서 `PretendardVariable.woff2`가 **200**으로 받아졌는지 본다
(404면 Step 7을 안 한 것이다).

- [ ] **Step 11: 커밋**

```bash
git add static/fonts/PretendardVariable.woff2 static/css/fonts.css \
        static/index.html static/css/base.css tests/test_fonts.py app/main.py
git commit -m "feat: self-host Pretendard instead of falling back to Malgun Gothic

system-ui resolves Hangul to Malgun Gothic on this machine, which was
the largest single contributor to the screen looking dated.

Not a CDN. Ollama and VOICEVOX both run locally, so the app works with
no internet -- a remote font would mean that on an offline day
everything keeps working except the typeface, and it would fall back to
exactly the face this change exists to replace."
```

---

### Task 4: `home_stats` — `top_tag` → `top_tags`

**Files:**
- Modify: `app/db.py` (`home_stats`)
- Modify: `static/js/home.js` (`loadHome`의 `stats.top_tag` 소비처)
- Modify: `tests/test_db.py`

**Interfaces:**
- Consumes: 없음
- Produces: `home_stats()` 반환값의 `top_tags` — `[{"tag": str, "n": int}, ...]`,
  길이 0~3, `n >= 3`인 것만, `n` 내림차순. `top_tag` 키는 **사라진다**.
  태스크 6(홈 오른쪽 패널)과 태스크 7(리포트 오른쪽 패널)이 이걸 읽는다

- [ ] **Step 1: 실패하는 테스트를 쓴다 (`tests/test_db.py`에 추가)**

기존 파일의 헬퍼(세션·메시지를 넣는 함수)를 그대로 쓴다. 이름이 다르면 파일 상단에서
확인하고 맞춘다.

```python
def test_top_tags_ranks_by_count_and_caps_at_three(tmp_db):
    sid = db.create_session(language="en", mode="free", scenario_id=None, topic=None)
    # 과거 시제 5, 관사 4, 전치사 3, 어순 3, 철자 2
    for tag, times in [("과거 시제", 5), ("관사", 4), ("전치사", 3),
                       ("어순", 3), ("철자", 2)]:
        for _ in range(times):
            _add_wrong_user_message(sid, tag=tag)

    tags = db.home_stats("en")["top_tags"]

    assert [t["tag"] for t in tags] == ["과거 시제", "관사", "전치사"]
    assert [t["n"] for t in tags] == [5, 4, 3]


def test_top_tags_withholds_anything_under_three(tmp_db):
    """3회 미만은 약점이 아니라 추측이다 -- home_stats 가 원래부터 지키던 규칙."""
    sid = db.create_session(language="en", mode="free", scenario_id=None, topic=None)
    _add_wrong_user_message(sid, tag="관사")
    _add_wrong_user_message(sid, tag="관사")   # 2회뿐

    assert db.home_stats("en")["top_tags"] == []


def test_top_tags_excludes_the_no_mistake_tag(tmp_db):
    sid = db.create_session(language="en", mode="free", scenario_id=None, topic=None)
    for _ in range(5):
        _add_wrong_user_message(sid, tag="없음")

    assert db.home_stats("en")["top_tags"] == []
```

`_add_wrong_user_message`가 아직 없으면 같은 파일에 만든다 — `speaker='user'`,
`ok=0`, 주어진 `tag`로 메시지를 한 줄 넣는 얇은 헬퍼다.

- [ ] **Step 2: 실패를 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_db.py -k top_tags -v`
Expected: 3 FAILED — `KeyError: 'top_tags'`

- [ ] **Step 3: `db.home_stats`를 고친다**

`tag_row` 쿼리를 바꾼다:

```python
        tag_rows = conn.execute(
            "SELECT m.tag, COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user' AND m.ok = 0"
            "   AND m.tag IS NOT NULL AND m.tag <> '없음'"
            " GROUP BY m.tag HAVING n >= 3 ORDER BY n DESC, m.tag LIMIT 3",
            (language,),
        ).fetchall()
```

`top_tag = ...` 줄을 지우고:

```python
    top_tags = [{"tag": r["tag"], "n": r["n"]} for r in tag_rows]
```

반환문:

```python
    return {"streak": streak, "week_turns": week_turns,
            "fixed_total": fixed_total, "top_tags": top_tags}
```

독스트링의 `top_tag` 문단을 갱신한다 — 3회 하한의 근거는 그대로 두고, 하나가 아니라
최대 셋을 돌려준다는 것과 `ORDER BY n DESC, m.tag`의 `m.tag`가 동점일 때 순서를
고정하기 위한 것임을 적는다(동점에서 순서가 흔들리면 테스트가 간헐적으로 깨진다).

- [ ] **Step 4: 통과 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_db.py -k top_tags -v`
Expected: 3 passed

- [ ] **Step 5: `top_tag`를 읽던 곳을 전부 옮긴다**

```bash
grep -rn "top_tag" app/ static/ tests/
```

`static/js/home.js`의 `loadHome`에서:

```js
    const worst = stats.top_tags && stats.top_tags[0];
    $('recommend').hidden = !worst;
    if (worst) {
      $('recommend').textContent =
        `요즘 ${worst.tag}에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`;
    }
```

`grep`이 남은 `top_tag`를 하나도 못 찾을 때까지 반복한다.

- [ ] **Step 6: 전체 스위트**

Run: `venv/Scripts/python.exe -m pytest -m "not engine" -q`
Expected: 298 passed / 8 deselected (295 + 3)

Run: `node --test 'static/js/*.test.js'`
Expected: 61 pass

- [ ] **Step 7: 역방향 확인**

`HAVING n >= 3`을 `HAVING n >= 1`로 바꾸고 `test_top_tags_withholds_anything_under_three`가
빨개지는지 본다. 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add app/db.py static/js/home.js tests/test_db.py
git commit -m "feat: return the top three weak tags, not just the worst one

The aggregate was already here -- it was a GROUP BY with LIMIT 1. Only
the limit moves, and the count travels with each tag now.

The three-occurrence floor stays exactly where it was. A weakness ranked
off one mistake is a guess wearing the costume of a fact, and the panel
this feeds is where the learner decides what to practise."
```

---

### Task 5: `recent_sessions` — 최근 연습 목록

**Files:**
- Modify: `app/db.py` (신규 함수)
- Modify: `app/api.py` (`GET /stats/home` 응답에 합류)
- Modify: `tests/test_db.py`

**Interfaces:**
- Consumes: 없음
- Produces: `db.recent_sessions(language, limit=3)` →
  `[{"id": int, "title": str, "ended_at": str, "fixed": int}, ...]`.
  `title`은 **절대 비지 않는다** (아래 규칙). `GET /stats/home` 응답에
  `recent` 키로 실린다. 태스크 6이 읽는다

**등급은 없다.** `stable_level()`이 "한 세션의 추정치는 노이즈"라고 이미 결론냈고,
그 결론은 화면을 채우기 위해 되돌리지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
def test_recent_sessions_returns_finished_sessions_newest_first(tmp_db):
    a = db.create_session(language="en", mode="free", scenario_id="clinic", topic=None)
    b = db.create_session(language="en", mode="free", scenario_id="cafe", topic=None)
    db.end_session(a, "{}", "beginner")
    db.end_session(b, "{}", "beginner")

    rows = db.recent_sessions("en")

    assert [r["id"] for r in rows] == [b, a]


def test_recent_sessions_skips_unfinished_and_other_languages(tmp_db):
    live = db.create_session(language="en", mode="free", scenario_id="clinic", topic=None)
    ja = db.create_session(language="ja", mode="free", scenario_id="office", topic=None)
    db.end_session(ja, "{}", "beginner")

    assert [r["id"] for r in db.recent_sessions("en")] == []
    assert live not in [r["id"] for r in db.recent_sessions("ja")]


def test_recent_sessions_counts_this_sessions_fixes(tmp_db):
    sid = db.create_session(language="en", mode="free", scenario_id="clinic", topic=None)
    other = db.create_session(language="en", mode="free", scenario_id="cafe", topic=None)
    _add_wrong_user_message(sid, tag="관사")
    _add_wrong_user_message(sid, tag="관사")
    _add_wrong_user_message(other, tag="어순")
    db.end_session(sid, "{}", "beginner")
    db.end_session(other, "{}", "beginner")

    by_id = {r["id"]: r for r in db.recent_sessions("en")}
    assert by_id[sid]["fixed"] == 2
    assert by_id[other]["fixed"] == 1


def test_recent_sessions_always_has_a_title(tmp_db):
    """제목이 비는 경우가 실제로 있다 -- 자유 입력 시나리오.

    빈 문자열을 클라이언트로 내보내면 화면마다 다르게 메워진다. 서버가 정한다.
    """
    free = db.create_session(language="en", mode="free", scenario_id=None, topic=None)
    topical = db.create_session(language="en", mode="lesson", scenario_id=None,
                                topic="과거형 연습")
    db.end_session(free, "{}", "beginner")
    db.end_session(topical, "{}", "beginner")

    by_id = {r["id"]: r for r in db.recent_sessions("en")}
    assert by_id[topical]["title"] == "과거형 연습"
    assert by_id[free]["title"] == "자유 대화"
```

- [ ] **Step 2: 실패 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_db.py -k recent_sessions -v`
Expected: 4 FAILED — `AttributeError: module 'app.db' has no attribute 'recent_sessions'`

- [ ] **Step 3: `db.recent_sessions`를 만든다**

`list_sessions` 아래에 넣는다.

```python
def recent_sessions(language, limit=3) -> list[dict]:
    """홈 화면 오른쪽의 "최근 연습". 끝난 세션만, 최신순.

    list_sessions()는 언어로 거르지도, 세션별로 집계하지도 않는다. 그 함수에
    두 기능을 더하면 호출자마다 다른 절반만 쓰는 함수가 되므로 따로 쓴다.

    등급은 싣지 않는다. stable_level()이 이미 결론낸 대로 한 세션의 레벨 추정은
    노이즈이고 -- 같은 전사를 세 번 돌리면 세 번 다르게 나온다 -- 화면 한 칸을
    채우려고 그 결론을 되돌리지 않는다.

    title이 비는 경우가 실제로 있다(시나리오 없이 시작한 자유 세션). 빈 값을
    클라이언트로 내보내면 그 빈칸이 화면마다 다르게 메워지므로, 여기서 정한다.
    scenario_id는 카탈로그 조회가 필요해 여기서 풀지 않고 그대로 실어 보낸다 --
    제목 해석은 scenarios 를 아는 api.py 의 몫이다.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT s.id, s.scenario_id, s.topic, s.ended_at,"
            "       (SELECT COUNT(*) FROM messages m"
            "         WHERE m.session_id = s.id AND m.speaker = 'user' AND m.ok = 0)"
            "       AS fixed"
            " FROM sessions s"
            " WHERE s.language = ? AND s.ended_at IS NOT NULL"
            " ORDER BY s.ended_at DESC, s.id DESC LIMIT ?",
            (language, limit),
        ).fetchall()
    return [dict(r) for r in rows]
```

**주의:** 테스트는 `title`을 기대하는데 이 함수는 `scenario_id`/`topic`을 돌려준다.
제목 해석은 `api.py`에서 한다(`scenarios`를 아는 쪽이다). 그러니 `db` 테스트는
`title`이 아니라 `topic`/`scenario_id`를 확인하도록 **Step 1의 마지막 테스트를 옮긴다** —
제목 규칙 테스트는 Step 5에서 API 레벨로 다시 쓴다.

- [ ] **Step 4: db 테스트 통과 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_db.py -k recent_sessions -v`
Expected: 3 passed (제목 테스트는 Step 5로 옮겼다)

- [ ] **Step 5: `api.py`에서 제목을 풀어 `/stats/home`에 합류시킨다**

```python
@router.get("/stats/home")
def home_stats(language: Language):
    stats = db.home_stats(language)
    stats["recent"] = [_recent_row(r) for r in db.recent_sessions(language)]
    return stats


def _recent_row(row: dict) -> dict:
    """최근 연습 한 줄. title 은 절대 비지 않는다.

    /sessions/resumable 이 쓰는 것과 같은 규칙이다: 시나리오가 있으면 그 제목,
    없으면 topic, 둘 다 없으면 고정 문자열. 그 규칙이 두 군데에 있는 것은
    의도적이다 -- resumable 은 살아 있는 세션을, 이쪽은 끝난 세션을 다루고,
    한쪽이 바뀌어야 할 때 다른 쪽이 따라가야 할 이유가 없다.
    """
    scenario = scenarios.get_scenario(row["scenario_id"]) if row["scenario_id"] else None
    return {
        "id": row["id"],
        "title": (scenario["title"] if scenario else row["topic"]) or "자유 대화",
        "ended_at": row["ended_at"],
        "fixed": row["fixed"],
    }
```

`tests/test_api_config.py`(또는 `/stats/home`을 이미 다루는 테스트 파일)에 제목 규칙
테스트를 넣는다:

```python
def test_home_stats_recent_always_has_a_title(client, tmp_db):
    free = db.create_session(language="en", mode="free", scenario_id=None, topic=None)
    topical = db.create_session(language="en", mode="lesson", scenario_id=None,
                                topic="과거형 연습")
    db.end_session(free, "{}", "beginner")
    db.end_session(topical, "{}", "beginner")

    recent = client.get("/api/stats/home?language=en").json()["recent"]
    by_id = {r["id"]: r for r in recent}

    assert by_id[topical]["title"] == "과거형 연습"
    assert by_id[free]["title"] == "자유 대화"
```

- [ ] **Step 6: 전체 스위트**

Run: `venv/Scripts/python.exe -m pytest -m "not engine" -q`
Expected: 302 passed / 8 deselected (298 + 3 + 1)

- [ ] **Step 7: 역방향 확인**

`_recent_row`의 `or "자유 대화"`를 지우고 제목 테스트가 빨개지는지 본다. 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add app/db.py app/api.py tests/test_db.py tests/test_api_config.py
git commit -m "feat: list the last three finished sessions on /stats/home

Deliberately without a grade. Phase 2C deleted per-session level
estimates because a single session's estimate is noise -- the same
transcript run three times comes back three different ways. Filling a
panel is not a reason to bring that back.

The title is resolved server-side and can never come back empty: a blank
that reaches the client gets filled differently on every screen that
renders it."
```

---

### Task 6: 홈 2단 배치

**Files:**
- Modify: `static/index.html` (`#home` 구조)
- Modify: `static/css/components.css` (홈 섹션)
- Modify: `static/js/home.js` (`loadHome`)
- Modify: `static/js/home.test.js`

**Interfaces:**
- Consumes: `stats.top_tags` (Task 4), `stats.recent` (Task 5)
- Produces: 없음

- [ ] **Step 1: 실패하는 노드 테스트를 쓴다 (`home.test.js`에 추가)**

**`dom-shim.js`는 `querySelector`가 항상 `null`이다.** 그래서 구현은 `$('id')`와
`classList`만 쓴다.

```js
test('첫 실행 — 오른쪽에 보일 것이 하나도 없으면 한 칸으로 접는다', async () => {
  stubFetch({
    '/api/sessions/resumable': jsonResponse({ session: null }),
    '/api/stats/home': jsonResponse({
      streak: 0, week_turns: 0, fixed_total: 0, top_tags: [], recent: [],
    }),
  });

  await home.loadHome();

  assert.ok($('home').classList.contains('no-aside'),
    '이어하기·통계·최근 기록이 모두 없으면 오른쪽 330px 트랙이 빈 채로 남는다');
});

test('볼 것이 하나라도 생기면 두 칸으로 되돌린다', async () => {
  $('home').classList.add('no-aside');   // 앞선 첫 실행 상태
  stubFetch({
    '/api/sessions/resumable': jsonResponse({ session: null }),
    '/api/stats/home': jsonResponse({
      streak: 3, week_turns: 12, fixed_total: 4, top_tags: [], recent: [],
    }),
  });

  await home.loadHome();

  assert.ok(!$('home').classList.contains('no-aside'));
});

test('요청이 실패해도 한 칸으로 접는다', async () => {
  stubFetch({
    '/api/sessions/resumable': () => { throw new Error('down'); },
    '/api/stats/home': () => { throw new Error('down'); },
  });

  await home.loadHome();

  assert.ok($('home').classList.contains('no-aside'),
    'catch 경로도 오른쪽 칸을 다 숨긴다 -- 숨긴 채로 트랙만 남기면 안 된다');
});
```

`stubFetch`의 실제 시그니처를 파일 상단에서 확인하고 맞춘다.

- [ ] **Step 2: 실패 확인**

Run: `node --test 'static/js/*.test.js'`
Expected: 새 테스트 3개 FAIL

- [ ] **Step 3: `static/index.html`의 `#home`을 2단으로 바꾼다**

```html
  <section id="home">
    <div class="home-main">
      <p class="home-date" id="home-date"></p>
      <div class="home-head">
        <h2 id="home-greeting">오늘은 뭘 연습할까요?</h2>
        <span class="seg" id="language-seg">
          <button type="button" data-language="en" class="on">English</button>
          <button type="button" data-language="ja">日本語</button>
        </span>
      </div>

      <p id="recommend" class="recommend" hidden></p>

      <div class="home-ask">
        <input id="wish" type="text" placeholder="예: 구직 면접, 병원 접수, 길 묻기" aria-label="연습하고 싶은 내용">
        <p class="hint">비워두고 시작하면 봇이 골라줍니다</p>
        <div id="chips" class="chips"></div>
      </div>

      <div class="modes" id="modes">
        <button type="button" data-mode="free" class="mode on">
          <span class="n">자유 상황극</span><span class="d">상황을 정하고 자유롭게 대화</span>
        </button>
        <button type="button" data-mode="script" class="mode">
          <span class="n">스크립트</span><span class="d">대본을 따라 읽으며 연습</span>
        </button>
        <button type="button" data-mode="lesson" class="mode">
          <span class="n">수업</span><span class="d">선생님과 주제를 잡고</span>
        </button>
      </div>

      <button id="btn-start" class="primary">시작</button>
    </div>

    <aside class="home-aside">
      <div id="resume-card" hidden>
        <div>
          <p id="resume-title"></p>
          <p id="resume-sub" class="hint"></p>
        </div>
        <button id="btn-resume">계속 →</button>
      </div>

      <div class="stats" id="home-stats" hidden>
        <p class="label">이번 주</p>
        <div class="stat-row">
          <div class="stat"><span class="v" id="stat-streak">0</span><span class="k">연속</span></div>
          <div class="stat"><span class="v" id="stat-week">0</span><span class="k">발화</span></div>
          <div class="stat"><span class="v" id="stat-fixed">0</span><span class="k">고침</span></div>
        </div>
      </div>

      <div class="recent" id="home-recent" hidden>
        <p class="label">최근 연습</p>
        <ul id="recent-list"></ul>
      </div>
    </aside>
  </section>
```

`.modes`가 그대로인 것은 의도적이다 — 세그먼트 모양은 CSS에서 만든다. 마크업과
`home.js`의 이벤트 위임을 함께 바꾸면 실패 원인이 두 배로 늘어난다.

- [ ] **Step 4: `components.css`의 홈 섹션을 고친다**

기존 `#home { max-width: 620px; ... }` 규칙을 대체한다:

```css
/* 왼쪽은 할 일(무엇을 연습할지 → 시작), 오른쪽은 맥락(이어하기·이번 주·최근).
   맥락이 할 일보다 먼저 읽히면 안 되므로, 좁은 화면에서 오른쪽은 시작 버튼
   아래로 내려간다. */
#home {
  max-width: 1100px; margin: 0 auto;
  display: grid; grid-template-columns: 1fr var(--aside-w);
  gap: var(--space-8); align-items: start;
}
/* 설치 첫날: 이어하기도 통계도 최근 기록도 없다. grid 트랙은 자식이 전부
   [hidden] 이어도 330px 를 그대로 차지하므로, 접지 않으면 화면이 왼쪽으로 쏠린
   채 오른쪽이 텅 빈다. flex 였던 예전 #home 에는 없던 문제다 -- gap 까지 함께
   사라졌기 때문이다. loadHome() 이 이 클래스를 붙이고 뗀다. */
#home.no-aside { grid-template-columns: 1fr; max-width: 640px; }
#home.no-aside .home-aside { display: none; }

.home-main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.home-aside { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }

.home-date { font-size: var(--text-sm); font-weight: 650; color: var(--accent);
             letter-spacing: .04em; margin: 0; }
#home-greeting { font-size: var(--text-3xl); font-weight: 750; color: var(--text);
                 margin: 0; letter-spacing: -.045em; line-height: 1.25; }

/* 모드 3개는 상자 셋이 아니라 세그먼트 하나다. 상자 셋일 때는 시작 버튼과
   무게를 다퉜다. */
.modes {
  display: flex; gap: 2px; background: var(--surface-sunken);
  padding: var(--space-1); border-radius: var(--radius); margin-top: var(--space-2);
}
.mode { flex: 1; border: 0; background: transparent; text-align: center;
        padding: var(--space-3) var(--space-2); border-radius: var(--radius-sm); }
.mode .n { font-size: var(--text-base); font-weight: 650; }
.mode .d { font-size: var(--text-xs); color: var(--text-faint); line-height: 1.4; }
.mode.on { background: var(--surface); box-shadow: var(--shadow); }
.mode.on .d { color: var(--text-dim); }

/* 칩: 테두리 상자에서 조용한 텍스트로. 상자가 하나 줄어든다. */
.chips button { border-color: transparent; background: transparent;
                color: var(--text-dim); }
.chips button:hover { background: var(--accent-soft); color: var(--accent-ink); }

#btn-start { box-shadow: var(--shadow-lift); }

/* 이어하기: 통짜 액센트 판이 아니라 왼쪽 3px 막대. 통짜였을 때는 시작 버튼보다
   먼저 눈에 들어와서, "오늘 뭘 누르지"가 한 번에 읽히지 않았다. */
#resume-card {
  display: flex; align-items: center; gap: var(--space-3);
  background: var(--surface); color: var(--text);
  border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: var(--radius); padding: var(--space-3) var(--space-4);
  box-shadow: none;
}
#resume-sub { color: var(--text-faint); opacity: 1; }
#btn-resume { background: transparent; border-color: transparent;
              color: var(--accent); font-weight: 650; }
#btn-resume:hover { background: var(--accent-soft); }
#btn-resume:focus-visible { outline-color: var(--accent); }

.stats, .recent {
  display: block; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: var(--space-4); margin: 0;
}
.stat-row { display: flex; gap: var(--space-5); }
.stat { flex: 0 0 auto; text-align: left; }
.stat .v { font-size: var(--text-2xl); }

.recent ul { list-style: none; margin: 0; padding: 0; }
.recent li { display: flex; align-items: baseline; gap: var(--space-2);
             padding: var(--space-2) 0; border-bottom: 1px solid var(--line);
             font-size: var(--text-sm); }
.recent li:last-child { border-bottom: 0; }
.recent .when { color: var(--text-faint); font-size: var(--text-xs);
                flex: 0 0 46px; }
.recent .what { flex: 1; min-width: 0; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
.recent .fixed { color: var(--text-dim); font-size: var(--text-xs); }

@media (max-width: 880px) {
  #home { grid-template-columns: 1fr; max-width: 640px; }
}
```

기존 `@media (max-width: 560px) { .modes { grid-template-columns: 1fr; } }`는
`.modes`가 더 이상 grid가 아니므로 지운다.

- [ ] **Step 5: `home.js`의 `loadHome`을 고친다**

세 개를 숨기던 자리에 최근 목록을 더하고, 끝에서 `.no-aside`를 정한다.

```js
export async function loadHome() {
  $('resume-card').hidden = true;
  $('home-stats').hidden = true;
  $('home-recent').hidden = true;
  $('recommend').hidden = true;

  $('home-date').textContent = new Intl.DateTimeFormat('ko-KR', {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());

  const lang = state.language;
  try {
    const [{ session }, stats] = await Promise.all([
      getJSON(`/sessions/resumable?language=${lang}`),
      getJSON(`/stats/home?language=${lang}`),
    ]);

    if (state.language !== lang) return;

    $('resume-card').hidden = !session;
    if (session) {
      resumeTarget = session;
      $('resume-title').textContent = `이어서 하기 — ${session.title}`;
      $('resume-sub').textContent = `대화 ${session.turns}턴에서 멈췄습니다`;
    }

    $('stat-streak').textContent = stats.streak;
    $('stat-week').textContent = stats.week_turns;
    $('stat-fixed').textContent = stats.fixed_total;
    $('home-stats').hidden = !(stats.streak || stats.week_turns || stats.fixed_total);

    renderRecent(stats.recent || []);

    const worst = stats.top_tags && stats.top_tags[0];
    $('recommend').hidden = !worst;
    if (worst) {
      $('recommend').textContent =
        `요즘 ${worst.tag}에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`;
    }
  } catch {
    $('resume-card').hidden = true;
    $('home-stats').hidden = true;
    $('home-recent').hidden = true;
    $('recommend').hidden = true;
  } finally {
    // 성공·실패 두 경로 모두에서 마지막에 한 번. 오른쪽에 보이는 것이 하나도
    // 없는데 트랙만 남으면 화면이 왼쪽으로 쏠린 채 330px 가 빈다.
    syncAside();
  }
}

/* 오른쪽 칸에 보이는 패널이 하나도 없으면 한 칸으로 접는다.
   querySelector 를 쓰지 않는 것은 취향이 아니다 -- dom-shim.js 는 CSS 선택자를
   구현하지 않고 항상 null 을 돌려주므로, 선택자로 쓰면 이 함수는 테스트에서
   조용히 아무것도 안 하게 된다. */
function syncAside() {
  const empty = $('resume-card').hidden && $('home-stats').hidden
             && $('home-recent').hidden;
  $('home').classList.toggle('no-aside', empty);
}

function renderRecent(rows) {
  const list = $('recent-list');
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = relativeDay(row.ended_at);
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = row.title;
    const fixed = document.createElement('span');
    fixed.className = 'fixed';
    fixed.textContent = row.fixed ? `${row.fixed}개 고침` : '';
    li.append(when, what, fixed);
    list.append(li);
  }
  $('home-recent').hidden = rows.length === 0;
}

/* ended_at 은 UTC ISO 문자열이다(db._now 의 형식). 날짜 경계는 로컬 기준으로
   잡는다 -- home_stats 의 streak 가 같은 이유로 로컬 시간을 쓴다. */
function relativeDay(iso) {
  const then = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0))
    / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  return `${days}일 전`;
}
```

- [ ] **Step 6: 노드 테스트 통과 확인**

Run: `node --test 'static/js/*.test.js'`
Expected: 64 pass (61 + 3)

- [ ] **Step 7: 역방향 확인**

`syncAside()` 호출을 `finally`에서 빼고 세 테스트가 전부 빨개지는지 본다.
그 다음 `catch` 경로에서만 빼고 세 번째 테스트만 빨개지는지 본다. 되돌린다.

- [ ] **Step 8: 전체 스위트**

Run: `venv/Scripts/python.exe -m pytest -m "not engine" -q` → 302 passed
Run: `node --test 'static/js/*.test.js'` → 64 pass
Run: `venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v` → 2 passed

- [ ] **Step 9: 커밋**

```bash
git add static/index.html static/css/components.css static/js/home.js static/js/home.test.js
git commit -m "feat: two-column home, with the empty-aside case handled

Left is the task, right is the context. The previous single 620px column
left the rest of a 1200px viewport as dead space, which is what 'it looks
empty' was pointing at.

The grid brings back a bug flex did not have. A [hidden] child collapses
its gap in a flex column, so the first-run screen had no holes in it; a
grid track keeps its 330px whether or not anything is in it. On the day
the app is installed there is no resume card, no counters and no history,
and without .no-aside the whole screen sits shoved to the left. Three
tests cover it, including the failed-request path."
```

---

### Task 7: 리포트 2단 배치

**Files:**
- Modify: `static/index.html` (`#report` 구조)
- Modify: `static/css/components.css` (리포트 섹션)
- Modify: `static/js/session.js` (`renderReport`)
- Modify: `static/js/session.test.js`
- Modify: `app/api.py` (`finish_session` — 세션 길이)

**Interfaces:**
- Consumes: `stats.top_tags` (Task 4)
- Produces: 없음

- [ ] **Step 1: 세션 길이(분)를 응답에 싣는다 — 실패 테스트 먼저**

목업의 "9분" 자리다. `sessions.started_at`은 이미 있고 `session_stats`는 그걸 안 본다.

`tests/test_api_report.py`에 추가:

```python
def test_finish_session_reports_elapsed_minutes(client, tmp_db, stub_llm):
    sid = db.create_session(language="en", mode="free", scenario_id="clinic", topic=None)
    # started_at 을 12분 전으로 되돌린다
    with db.connect() as conn:
        conn.execute("UPDATE sessions SET started_at = ? WHERE id = ?",
                     ((datetime.now(timezone.utc) - timedelta(minutes=12))
                      .isoformat(timespec="seconds"), sid))

    stats = client.post(f"/api/sessions/{sid}/end").json()["stats"]

    assert stats["minutes"] == 12
```

- [ ] **Step 2: 실패 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_api_report.py -k elapsed -v`
Expected: FAILED — `KeyError: 'minutes'`

- [ ] **Step 3: `finish_session`에서 계산한다**

`stats = db.session_stats(session_id)` 다음 줄에:

```python
    # 리포트 오른쪽 패널의 "말한 시간". db.session_stats 는 메시지만 세므로
    # 세션 행을 이미 손에 쥔 여기서 잰다. 0분이 나올 수 있고(짧은 세션) 그것은
    # 정상이다 -- 화면은 "0분"을 그대로 보여준다.
    stats["minutes"] = _elapsed_minutes(session["started_at"])
```

파일 아래쪽에:

```python
def _elapsed_minutes(started_at: str) -> int:
    """세션이 열려 있던 시간, 분. 못 재면 0.

    started_at 은 db._now() 가 쓴 UTC ISO 문자열이다. 그 형식이 아니면 예외
    대신 0을 돌려준다 -- 리포트는 이미 만들어졌고, 시간 한 줄 때문에 학습자가
    받을 리포트를 에러로 바꾸지 않는다.
    """
    try:
        started = datetime.fromisoformat(started_at)
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - started).total_seconds() // 60))
    except (TypeError, ValueError):
        return 0
```

- [ ] **Step 4: 통과 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_api_report.py -k elapsed -v` → passed

- [ ] **Step 5: `static/index.html`의 `#report`를 2단으로**

```html
  <section id="report" hidden>
    <div class="report-main">
      <p class="report-kicker" id="report-kicker"></p>
      <h2 id="report-headline"></h2>
      <p id="report-counts" class="hint"></p>
      <div id="report-body"></div>
      <button id="btn-restart" class="primary">새 세션</button>
    </div>
    <aside class="report-aside">
      <div class="panel" id="report-numbers">
        <p class="label">이번 세션</p>
        <div class="stat-row">
          <div class="stat"><span class="v" id="rep-turns">0</span><span class="k">턴</span></div>
          <div class="stat"><span class="v" id="rep-wrong">0</span><span class="k">고침</span></div>
          <div class="stat"><span class="v" id="rep-minutes">0</span><span class="k">분</span></div>
        </div>
      </div>
      <div class="panel" id="report-weak" hidden>
        <p class="label">자주 놓치는 것</p>
        <ul id="weak-list"></ul>
      </div>
    </aside>
  </section>
```

기존 `<div id="report-head">`는 사라지고 `#report-counts`가 `.report-main`으로 옮겨간다.

- [ ] **Step 6: `renderReport`를 고친다**

`$('report-counts').textContent = counts;` 위에 헤드라인을, 아래에 패널을 더한다.
**`counts` 계산과 스크립트 모드 분기는 손대지 않는다** — 대본 세션은 문법 교정을 하지
않아서 `wrong`이 항상 0이고, 그 문구는 그래서 따로 있다.

```js
  // 헤드라인. LLM 에 새 필드를 요구하지 않는다 -- 리포트 프롬프트는 여러 라운드에
  // 걸쳐 다듬어졌고, 필드를 하나 더 넣는 것만으로 그 품질이 회귀할 수 있다.
  // 이미 손에 있는 숫자로 조립한다.
  $('report-kicker').textContent = state.scenarioTitle || '';
  $('report-headline').textContent = state.mode === 'script'
    ? `대본 ${s.turns ?? 0}줄을 읽었어요.`
    : `오늘 ${s.turns ?? 0}턴을 주고받았어요.`;
```

`state.scenarioTitle`이 없으면 `session.js`에서 세션을 열 때 무엇을 담고 있는지 확인해
그 값을 쓴다. 없으면 kicker를 비운다 — 없는 상태를 만들어 채우지 않는다.

`renderReport` 끝에:

```js
  $('rep-turns').textContent = s.turns ?? 0;
  $('rep-wrong').textContent = s.wrong ?? 0;
  $('rep-minutes').textContent = s.minutes ?? 0;

  // 누적 약점. 이 세션이 아니라 앱 전체 기록이라, 리포트가 매번 똑같아 보이지
  // 않게 하는 것이 이 패널의 목적이다. /stats/home 이 이미 3회 하한을 걸어
  // 돌려주므로 여기서 다시 거르지 않는다.
  loadWeakPoints().catch(() => {});   // 리포트를 막지 않는다
}

async function loadWeakPoints() {
  const list = $('weak-list');
  list.replaceChildren();
  const { top_tags: tags = [] } = await getJSON(`/stats/home?language=${state.language}`);
  for (const t of tags) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = t.tag;
    const n = document.createElement('span');
    n.className = 'weak-n';
    n.textContent = `${t.n}회`;
    li.append(name, n);
    list.append(li);
  }
  $('report-weak').hidden = tags.length === 0;
}
```

`getJSON`이 `session.js`에 이미 import돼 있는지 확인하고, 없으면 더한다.

- [ ] **Step 7: `components.css`의 리포트 섹션**

```css
#report {
  max-width: 1060px; margin: 0 auto;
  display: grid; grid-template-columns: 1fr var(--aside-w);
  gap: var(--space-8); align-items: start;
}
.report-main { min-width: 0; }
.report-aside { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.panel { background: var(--surface); border: 1px solid var(--line);
         border-radius: var(--radius); padding: var(--space-4); }

.report-kicker { font-size: var(--text-sm); font-weight: 650; color: var(--accent);
                 letter-spacing: .04em; margin: 0 0 var(--space-2); }
#report-headline { font-size: var(--text-2xl); font-weight: 750; color: var(--text);
                   letter-spacing: -.04em; line-height: 1.3; margin: 0 0 var(--space-2); }

/* 고친 표현의 위아래를 뒤집는다. 취소선 친 원문과 고친 문장이 비슷한 무게였는데,
   읽어야 할 것은 고친 쪽이다. */
.fix-row .said { font-size: var(--text-sm); color: var(--text-faint); }
.fix-row .fixed { font-size: var(--text-lg); font-weight: 600; color: var(--suggest-ink); }

#weak-list { list-style: none; margin: 0; padding: 0; }
#weak-list li { display: flex; align-items: center; justify-content: space-between;
                padding: var(--space-2) 0; border-bottom: 1px solid var(--line);
                font-size: var(--text-sm); }
#weak-list li:last-child { border-bottom: 0; }
.weak-n { font-size: var(--text-xs); font-weight: 700; color: var(--correct-ink);
          background: var(--correct-bg); padding: 2px var(--space-2);
          border-radius: var(--radius-pill); }

@media (max-width: 880px) {
  #report { grid-template-columns: 1fr; max-width: 640px; }
}
```

- [ ] **Step 8: 스크립트 모드 헤드라인 테스트를 쓴다**

`static/js/session.test.js`에 추가:

```js
test('대본 세션의 헤드라인은 턴이 아니라 줄을 센다', () => {
  state.mode = 'script';
  session.renderReport({ summary: 'x', stats: { turns: 8, wrong: 0, minutes: 3 } });
  assert.equal($('report-headline').textContent, '대본 8줄을 읽었어요.');
});

test('자유 세션의 헤드라인', () => {
  state.mode = 'free';
  session.renderReport({ summary: 'x', stats: { turns: 12, wrong: 5, minutes: 9 } });
  assert.equal($('report-headline').textContent, '오늘 12턴을 주고받았어요.');
});
```

`renderReport`가 export돼 있지 않으면 export한다.

- [ ] **Step 9: 전체 스위트**

Run: `venv/Scripts/python.exe -m pytest -m "not engine" -q` → 303 passed
Run: `node --test 'static/js/*.test.js'` → 66 pass
Run: `venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v` → 2 passed

- [ ] **Step 10: 역방향 확인**

헤드라인의 스크립트 분기를 지우고 첫 번째 테스트가 빨개지는지 본다. 되돌린다.

- [ ] **Step 11: 커밋**

```bash
git add static/index.html static/css/components.css static/js/session.js \
        static/js/session.test.js app/api.py tests/test_api_report.py
git commit -m "feat: two-column report, with the fix line as the loud half

'수업 리포트' told the learner nothing; the headline now says what they
did. It is assembled from counts the app already has -- no new field is
asked of the model, because the report prompt took several rounds to get
right in Korean and a visual change is not worth risking that.

Script sessions get their own headline. They store ok=None on every turn
by design, so a turn-and-correction phrasing would misdescribe every
script report, the same reason the counts line already forks."
```

---

### Task 8: 마이크 아이콘

**Files:**
- Modify: `static/css/components.css` (`.mic::after`)

**Interfaces:**
- Consumes: 없음
- Produces: 없음

지금 `.mic::after`는 둥근 사각형이다. 아이콘이 아니라 자리표시자로 보인다.

- [ ] **Step 1: `.mic::after`를 마이크 글리프로 바꾼다**

```css
/* 마이크. 예전에는 inset 으로 자른 둥근 사각형이었는데, 아이콘이 아니라 미완성
   자리표시자로 읽혔다. mask 를 쓰는 것은 색 때문이다 -- 글리프는 --on-accent 를
   따라가야 하고, 그 토큰은 두 스킴에서 뒤집힌다(다크에서 근접 검정). 배경
   이미지로 넣으면 색이 파일에 박혀서 다크에서 틀린다. */
.mic::after {
  content: ""; position: absolute; inset: 0;
  background: var(--on-accent);
  -webkit-mask: var(--mic-glyph) center / 22px 22px no-repeat;
  mask: var(--mic-glyph) center / 22px 22px no-repeat;
  border-radius: 0;
}
```

`tokens.css`의 `:root`에 글리프를 더한다 (라이트 블록에만 — 색이 아니라 모양이라
스킴에 따라 달라지지 않는다):

```css
  /* 마이크 글리프. 색은 mask 로 --on-accent 가 칠하므로 여기서는 모양만 정한다. */
  --mic-glyph: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>');
```

- [ ] **Step 2: `.play-mine`의 높이를 24px 위로 올린다**

`ui-ux-pro-max` 조회에서 나온 것이다. WCAG 2.2 Target Size (Minimum)은 웹에서
**24×24 CSS px**을 요구하는데, `▶ 내 발음` 버튼이 그 아래에 있다:
`font-size: var(--text-xs)` × line-height 1.55 ≈ 17.8px + 세로 패딩 4px + 테두리 2px
≈ **23.8px**. 태스크 2가 `--text-xs`를 11→11.5px로 올려 조금 나아졌지만 여전히 경계선이다.

같은 줄의 `.respeak`는 세로 패딩이 `var(--space-1)`(4px)이라 ≈27.8px로 통과한다.
`.play-mine`만 그 패딩을 안 쓰고 있다.

```css
.play-mine {
  display: block; margin-top: var(--space-2);
  /* 2px 였다. WCAG 2.2 Target Size (Minimum)의 24×24 아래로 떨어져서 --space-1 로
     맞춘다 -- 바로 옆 .respeak 가 이미 쓰는 값이고, 두 버튼이 같은 줄에서 다른
     크기일 이유가 없었다. */
  font-size: var(--text-xs); padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-pill); color: var(--text-dim);
}
```

- [ ] **Step 3: 토큰 가드가 통과하는지**

Run: `venv/Scripts/python.exe -m pytest tests/test_css_tokens.py -v`
Expected: 2 passed (`--mic-glyph`가 정의·참조 양쪽에 있다)

- [ ] **Step 4: 눈으로 확인**

서버를 8010에 띄우고 세션 화면을 연다. **라이트와 다크 모두에서** 마이크 모양이
보여야 한다. 다크에서 안 보이면 `--on-accent` 뒤집기가 안 먹은 것이다.

- [ ] **Step 5: 커밋**

```bash
git add static/css/components.css static/css/tokens.css
git commit -m "feat: give the mic button an actual mic

It was a rounded square cut out of the circle, which read as an
unfinished placeholder rather than an icon.

Painted through a mask rather than as a background image: the glyph has
to take --on-accent, and that token inverts between schemes. Baking the
colour into the SVG would leave it wrong in dark."
```

---

### Task 9: 종단 점검 (수동)

**Files:** 없음 — 발견한 것만 고친다

테스트가 볼 수 없는 것들이다. 앱을 실제로 띄워서 본다. **DB는 복사본을 쓰고, 포트는
8010을 쓴다.**

- [ ] **Step 1: 서버를 띄운다**

```bash
cp monologue.db /tmp/check.db
MONOLOGUE_DB=/tmp/check.db venv/Scripts/python.exe -m uvicorn app.main:app --port 8010
```

(환경변수 이름은 `app/config.py`에서 확인한다. 없으면 복사본을 제자리에 두고 원본을
백업한 뒤 되돌린다.)

- [ ] **Step 2: 6가지 조합을 돌아본다**

2언어(en/ja) × 3모드(free/script/lesson). 각각 홈 → 세션 한두 턴 → 리포트.

- [ ] **Step 3: 다크 모드**

OS를 다크로 바꾸고 같은 경로를 다시 본다. 특히:
- 시작 버튼 글자가 씻겨 보이지 않는지 (`--on-accent` 뒤집기)
- 이어하기 카드의 액센트 막대가 보이는지
- 마이크 글리프가 보이는지

- [ ] **Step 4: 일본어 읽기 보조**

일본어 세션에서 후리가나와 로마자가 붙은 줄을 본다. `line-height: 2.1` 규칙이
새 타입 스케일(base 14→15px)에서도 윗줄 후리가나와 아랫줄 본문을 안 닿게 하는지.
닿으면 `components.css`의 그 값을 올린다.

- [ ] **Step 5: 첫 실행**

```bash
rm /tmp/empty.db
MONOLOGUE_DB=/tmp/empty.db venv/Scripts/python.exe -m uvicorn app.main:app --port 8010
```

홈이 **한 칸으로** 나와야 한다. 오른쪽에 빈 330px가 남아 있으면 `.no-aside`가 안 붙은
것이다.

- [ ] **Step 6: 좁은 화면**

브라우저 창을 880px 아래로 줄인다. 홈과 리포트 모두 1단이 되고, 오른쪽 패널이
**시작 버튼 아래로** 내려가야 한다 (위가 아니라).

- [ ] **Step 7: 발견한 것을 고치고 커밋**

각 수정은 그 자체로 커밋한다. 고칠 게 없으면 이 태스크는 커밋 없이 끝난다.

- [ ] **Step 8: 최종 스위트**

```bash
venv/Scripts/python.exe -m pytest -m "not engine" -q     # 303 passed / 8 deselected
node --test 'static/js/*.test.js'                        # 66 pass
```

---

## 자체 검토 결과

**스펙 대조.** A(토큰·글꼴) → 태스크 2·3. B(홈) → 태스크 6, 첫 실행 규칙 포함.
C(리포트) → 태스크 7, 헤드라인을 LLM 없이 조립하는 결정 포함. D(서버) → 태스크 4·5.
E(회귀 방지) → 태스크 1이 1·2번을, 태스크 6이 3번을, 태스크 4·5가 4·5번을,
태스크 9가 "눈으로 확인" 목록을 맡는다.

**스펙에서 고친 것.** E-2의 방향이 반대였다. 스펙은 "라이트의 색이 다크에서
재정의됐는지"로 썼지만 현재 코드가 그걸 통과하지 못한다 — `--correct`와 `--suggest`는
두 스킴에서 같은 색이라 라이트에만 있다. `tokens.css`가 실제로 세운 규칙은
"색을 다크 블록 안에서만 정의하지 말 것"이고, 태스크 1은 그쪽(다크 ⊆ 라이트)을 검사한다.

**스펙에 없던 것 하나.** 리포트 오른쪽 "이번 세션" 패널에 분 단위 시간이 필요한데
`session_stats`가 그걸 안 잰다. 태스크 7 Step 1~4에서 `sessions.started_at`으로
계산해 더한다. 못 재면 0을 돌려주고 리포트를 막지 않는다.

**타입 일관성.** `top_tags`는 태스크 4에서 `[{tag, n}]`로 정해져 태스크 6(`worst.tag`)과
태스크 7(`t.tag`, `t.n`)에서 같은 모양으로 읽힌다. `recent`는 태스크 5에서
`[{id, title, ended_at, fixed}]`로 정해져 태스크 6의 `renderRecent`가 네 필드를 다 쓴다.
`stats.minutes`는 태스크 7에서 만들어 같은 태스크에서 소비한다.

**주의해서 볼 곳.** 태스크 5 Step 3에 함정이 하나 있다 — `db.recent_sessions`는
`title`이 아니라 `scenario_id`/`topic`을 돌려주고, 제목 해석은 `api.py`가 한다.
Step 1에 쓴 제목 테스트는 그래서 API 레벨로 옮겨야 하며, Step 3·4·5가 그렇게 하라고
적어두었다.


---

## 부록: `ui-ux-pro-max` 조회 결과 (2026-09-06)

이 계획을 쓴 뒤 스킬로 설계를 교차 검증했다. 결과를 그대로 적어둔다 —
**대부분 이 프로젝트에 맞지 않았고**, 맞지 않았다는 사실 자체가 기록할 값어치가 있다.

**`--design-system`은 두 번 다 못 썼다.**

1차(`language learning practice warm minimal`)는 랜딩 페이지 패턴
(Hero + Testimonials + CTA), Claymorphism("장난감 같은, 아이들 앱"), 인디고+초록 팔레트,
그리고 **한글을 지원하지 않는** Baloo 2 / Comic Neue를 돌려줬다. 한국어 UI에 쓸 수 없고,
초록/빨강은 이 프로젝트가 명시적으로 배제한 조합이다.

2차(`personal focused daily practice tool calm`)는 Minimalism & Swiss Style로 방향은
맞았지만 색은 또 차가운 파랑/초록이었다.

**`design-system/` 디렉터리를 만들지 않았다** (`--persist` 미사용). 스펙이 "토큰 소스를
둘로 만들지 않는다"고 정했고, MASTER.md는 그 두 번째 소스가 된다.

**세그먼트 컨트롤 질의는 빗나갔다.** `segmented control single choice`가 드래그·캐러셀
항목을 돌려줬다. DB에 해당 항목이 없는 것으로 보인다. `.modes`를 세그먼트로 바꾸는 결정은
데이터베이스 근거 없이 내린 판단이다 — 그렇게 기록해 둔다.

**실제로 쓸모 있었던 것 두 가지:**

- **WCAG 2.2 Target Size (Minimum) 24×24px** → `.play-mine`이 ≈23.8px로 그 아래였다.
  태스크 8 Step 2에 넣었다. 이 계획이 놓쳤던 진짜 결함이다
- **인접 터치 타겟 사이 8px** → `.modes` 세그먼트의 `gap: 2px`가 이 권고 아래다.
  **의식적으로 유지한다**: 세그먼트 컨트롤은 칸이 붙어 있는 것이 그 컨트롤의 형태이고
  (iOS 세그먼트도 간격이 없다), 각 칸이 flex로 화면 1/3 너비에 세로 패딩 12px이라
  타겟 자체는 크다. 권고가 겨냥하는 것은 작고 촘촘한 버튼이지 이 모양이 아니다.
  칩(`gap: var(--space-2)`)과 컨트롤 줄은 8px을 지킨다
