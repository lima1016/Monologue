# 테마 라이브러리 · 16줄/16턴 · 로딩 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 테마 20개 × 언어별 30편 × 16줄 대본 라이브러리를 만들고, 홈을 "모드 → 테마" 흐름으로 바꾸고, 긴 대기마다 무엇을 하는 중인지 보여준다.

**Architecture:** 테마 목록은 `data/themes.json`(git), 생성된 대본·자유 대화 설정은 SQLite `library_scenarios`(스키마 v5). 생성은 앱 밖 운영 스크립트 `scripts/build_library.py`가 `app/library.py`의 검사를 거쳐 넣는다. 앱은 `GET /api/themes`, `POST /api/library/pick`(안 해본 대본 먼저 + 뒤에서 음성 합성)만 더한다. 화면은 새 `#pick` 화면과 `static/js/pick.js`.

**Tech Stack:** FastAPI, SQLite, Ollama qwen2.5:14b(`app/llm.py`), VOICEVOX/Kokoro TTS(`app/tts`), pytest, 브라우저 ES 모듈 + `node --test`(dom-shim).

**Spec:** `docs/superpowers/specs/2026-09-14-monologue-theme-library-design.md`

## Global Constraints

- 작업 위치: 워크트리 `C:/git/Monologue-wt/theme-library`, 브랜치 `theme-library`. `C:/git/Monologue`의 파일은 건드리지 않는다(사용자가 8000 서버를 그 작업 트리로 쓰는 중).
- 파이썬: `C:/git/Monologue/venv/Scripts/python.exe`, 워크트리 루트에서. 기본 스위트 `-m "not engine"`.
- 워크트리에서만 실패하는 알려진 테스트: `tests/test_config.py::test_kokoro_model_files_are_present`(engines/ gitignore). 무시.
- 기준선(main `8110277` + 데이터 정리): pytest 452(워크트리에선 451 + 알려진 1), node 118.
- engine 출력은 `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` 필요(cp949). Ollama는 사용자의 8000 서버와 공유. 서버를 띄워야 하면 **8010**만, DB는 복사본.
- 테마 **20개**, 테마당 언어별 **30편**, 대본 **16줄**, 자유 대화 **16턴**(마무리 유도 14턴째부터).
- 검사: 줄 수 정확히 16, 영어 한 줄 20단어 이하, 일본어 한 줄 구두점 제외 45자 이하, 유사도 문턱 **0.8**, 재생성 최대 **3번**, 프롬프트에 넣는 기존 대본 **최근 10개**.
- id: 대본 `lib-<theme_id>-<language>-<nn>`(두 자리), 자유 설정 `lib-<theme_id>-<language>-free`.
- 사용자 문구(그대로): `대본 고르는 중...`, `음성 준비 중...`, `대본 만드는 중...`, `상황 만드는 중...`, `첫 대사 만드는 중...`, `대화 불러오는 중...`, `뜻 가져오는 중...`, `이 테마는 아직 준비되지 않았어요`, 분류 탭 `일상` `여행` `스몰토크` `비즈니스` `내가 만든 것`, `← 홈`.
- 새 가드마다 일부러 부숴서 빨개지는지 확인하고 되돌린다.
- 커밋 메시지 끝:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9
  ```

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `data/themes.json` (새) | 테마 20개 | 1 |
| `app/library.py` (새) | 테마 읽기, 대본 검사, 대본 고르기 | 1, 2 |
| `app/config.py` | `DEFAULT_MAX_TURNS` 16, `LIBRARY_SCRIPT_LINES` 등 상수 | 1 |
| `data/scenarios.json` | 자유 `max_turns` 16 | 1 |
| `app/db.py` | 마이그레이션 v5, 라이브러리 CRUD·조회 | 2 |
| `app/scenarios.py` | `get_scenario`가 라이브러리도 찾음 | 2 |
| `app/prompts.py` | 대본 16줄, 라이브러리 대본 프롬프트 | 3 |
| `scripts/build_library.py` (새) | 일괄 생성 CLI | 3 |
| `app/api.py` | `/scenarios/generate` 16줄 검사+재생성, `GET /themes`, `POST /library/pick`, 뒤에서 합성 | 3, 4 |
| `static/index.html`, `static/js/pick.js` (새), `static/js/home.js`, `static/js/main.js`, `static/js/reading.js`, `static/css/components.css` | 모드 → 테마 화면, 로딩 표시 | 5 |
| tests: `test_library.py`(새), `test_build_library.py`(새), `test_api_library.py`(새), `test_library_quality.py`(새, engine), `pick.test.js`(새), 기존 파일 수정 | | 전부 |

---

### Task 1: 테마 목록, 길이 16, 대본 검사

**Files:**
- Create: `data/themes.json`, `app/library.py`, `tests/test_library.py`
- Modify: `app/config.py`, `data/scenarios.json`, `tests/test_prompts.py`(마무리 유도 턴 수가 하드코딩돼 있으면)

**Interfaces:**
- Produces:
  - `config.DEFAULT_MAX_TURNS = 16`, `config.LIBRARY_SCRIPT_LINES = 16`, `config.LIBRARY_PER_THEME = 30`, `config.THEME_CATEGORIES = ("daily", "travel", "smalltalk", "business")`
  - `library.load_themes() -> list[dict]` (lru_cache; `{"id","category","title","situations"}`), `library.get_theme(theme_id) -> dict | None`
  - `library.check_script(lines: list[dict], language: str, existing: list[list[dict]] = (), *, expected_lines: int = 16, check_duplicates: bool = True) -> str | None` -- 실패 이유(짧은 영어 슬러그) 또는 None. 슬러그: `line-count`, `structure`, `language`, `too-long`, `same-opening`, `too-similar`.

- [ ] **Step 1: 실패하는 테스트**

`tests/test_library.py`:

```python
import pytest

from app import config, library


def _script(texts, speakers=None):
    speakers = speakers or ["bot" if i % 2 == 0 else "user" for i in range(len(texts))]
    return [{"speaker": s, "text": t} for s, t in zip(speakers, texts)]


EN16 = [f"Line number {i} here." for i in range(16)]
JA16 = [f"これは{i}番目のセリフです。" for i in range(16)]


def test_there_are_twenty_themes_five_per_category():
    themes = library.load_themes()
    assert len(themes) == 20
    for cat in config.THEME_CATEGORIES:
        assert sum(t["category"] == cat for t in themes) == 5
    assert len({t["id"] for t in themes}) == 20
    assert all(t["title"] and len(t["situations"]) >= 3 for t in themes)


def test_get_theme():
    assert library.get_theme("hotel")["title"] == "호텔"
    assert library.get_theme("nope") is None


def test_a_good_sixteen_line_script_passes():
    assert library.check_script(_script(EN16), "en") is None
    assert library.check_script(_script(JA16), "ja") is None


def test_line_count_must_be_exact():
    assert library.check_script(_script(EN16[:15]), "en") == "line-count"
    assert library.check_script(_script(EN16 + ["Extra one."]), "en") == "line-count"
    assert library.check_script(_script(EN16[:8]), "en", expected_lines=8) is None


def test_structure_bot_first_and_alternating():
    assert library.check_script(_script(EN16, ["user", "bot"] * 8), "en") == "structure"
    speakers = ["bot", "user"] * 8
    speakers[3] = "user"
    assert library.check_script(_script(EN16, speakers), "en") == "structure"
    bad = _script(EN16)
    bad[4]["text"] = ""
    assert library.check_script(bad, "en") == "structure"


@pytest.mark.parametrize("language,index,text", [
    ("en", 2, "Sure, 좋아요."),
    ("en", 2, "Sure, 没问题."),
    ("en", 2, "はい、わかりました。"),
    ("en", 2, "1234 !!"),
    ("ja", 2, "はい、좋아요。"),
    ("ja", 2, "OKです。"),
])
def test_language_is_checked_per_line(language, index, text):
    lines = _script(EN16 if language == "en" else JA16)
    lines[index]["text"] = text
    assert library.check_script(lines, language) == "language"


def test_japanese_needs_kana_somewhere_but_not_on_every_line():
    lines = _script(JA16)
    lines[3]["text"] = "了解。"
    assert library.check_script(lines, "ja") is None
    kanji_only = _script(["我想要咖啡。"] * 16)
    assert library.check_script(kanji_only, "ja") == "language"


def test_line_length_limits():
    lines = _script(EN16)
    lines[1]["text"] = " ".join(["word"] * 20)
    assert library.check_script(lines, "en") is None
    lines[1]["text"] = " ".join(["word"] * 21)
    assert library.check_script(lines, "en") == "too-long"
    ja = _script(JA16)
    ja[1]["text"] = "あ" * 45 + "。、"
    assert library.check_script(ja, "ja") is None
    ja[1]["text"] = "あ" * 46
    assert library.check_script(ja, "ja") == "too-long"


def test_same_opening_line_as_an_existing_script_is_a_duplicate():
    existing = [_script(["Hi there, welcome in!"] + [f"Other {i} words." for i in range(15)])]
    new = _script(["hi there welcome in"] + [f"Totally new line {i}." for i in range(15)])
    assert library.check_script(new, "en", existing) == "same-opening"


def test_a_script_too_similar_to_an_existing_one_is_a_duplicate():
    base = [f"The quick brown fox number {i} jumps." for i in range(16)]
    near = list(base)
    near[0] = "A different opening line entirely."
    near[5] = "The quick brown fox number 5 leaps."
    assert library.check_script(_script(near), "en", [_script(base)]) == "too-similar"
    far = [f"Completely unrelated sentence {i * 7} about tea." for i in range(16)]
    assert library.check_script(_script(far), "en", [_script(base)]) is None


def test_duplicate_checks_can_be_switched_off():
    base = _script(EN16)
    assert library.check_script(_script(EN16), "en", [base], check_duplicates=False) is None


def test_default_max_turns_is_sixteen_and_builtin_free_scenarios_follow():
    import json
    assert config.DEFAULT_MAX_TURNS == 16
    items = json.loads((config.DATA_DIR / "scenarios.json").read_text(encoding="utf-8"))
    assert all(i["max_turns"] == 16 for i in items if i["type"] == "free")
```

- [ ] **Step 2: RED 확인** — `C:/git/Monologue/venv/Scripts/python.exe -m pytest -m "not engine" -q tests/test_library.py` → `ModuleNotFoundError: app.library` 등.

- [ ] **Step 3: 구현**

`app/config.py`: `DEFAULT_MAX_TURNS = 8` → `16`. 그 근처에 추가:

```python
# 테마 라이브러리 (docs/superpowers/specs/2026-09-14-monologue-theme-library-design.md)
LIBRARY_SCRIPT_LINES = 16
LIBRARY_PER_THEME = 30
THEME_CATEGORIES = ("daily", "travel", "smalltalk", "business")
```

`data/scenarios.json`: `"type": "free"` 항목의 `"max_turns": 8` → `16`(네 곳). 대본 항목은 건드리지 않는다.

`data/themes.json`: 스펙의 "테마 20개" 표를 그대로 옮긴다 -- 행마다 `{"id", "category", "title", "situations": [...]}`, `situations`는 표의 쉼표로 나뉜 항목들. 순서는 표 순서.

`app/library.py`:

```python
"""테마 라이브러리: 테마 목록, 생성된 대본의 검사, 다음 대본 고르기.

테마는 data/themes.json(사람이 고치는 목록), 대본은 DB library_scenarios
(scripts/build_library.py가 만든다). 검사는 생성 스크립트와 /scenarios/generate가
함께 쓴다 -- 16줄을 달라고 해도 15줄이 온 적이 있다(2026-09-14 실측).
"""
import difflib
import json
import re
from functools import lru_cache

from app import config, scenarios
from app.text_match import normalize

_HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")
_KANA = re.compile(r"[぀-ヿ]")
_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿]")
_LATIN = re.compile(r"[A-Za-z]")
_MAX_WORDS_EN = 20
_MAX_CHARS_JA = 45
_SIMILAR = 0.8


@lru_cache(maxsize=1)
def _themes() -> tuple:
    items = json.loads((config.DATA_DIR / "themes.json").read_text(encoding="utf-8"))
    return tuple(items)


def load_themes() -> list[dict]:
    return list(_themes())


def get_theme(theme_id):
    return next((t for t in _themes() if t["id"] == theme_id), None)


def _line_ok(text: str, language: str) -> bool:
    if _HANGUL.search(text):
        return False
    if language == "en":
        return bool(_LATIN.search(text)) and not _CJK.search(text)
    return not _LATIN.search(text)


def _too_long(text: str, language: str) -> bool:
    if language == "en":
        return len(text.split()) > _MAX_WORDS_EN
    return len(normalize(text).replace(" ", "")) > _MAX_CHARS_JA


def _joined(lines) -> str:
    return " ".join(normalize(l["text"]) for l in lines)


def check_script(lines, language, existing=(), *, expected_lines=config.LIBRARY_SCRIPT_LINES,
                 check_duplicates=True):
    """Why this script cannot be used, or None. Order matters: cheap structural
    failures first, so a malformed generation never reaches the similarity pass."""
    if not isinstance(lines, list) or len(lines) != expected_lines:
        return "line-count"
    try:
        if any(not isinstance(l, dict) or not isinstance(l.get("text"), str) for l in lines):
            return "structure"
        scenarios.validate_item({"id": "check", "language": language, "type": "script",
                                 "title": "check", "lines": lines})
    except scenarios.ScenarioError:
        return "structure"
    texts = [l["text"] for l in lines]
    if not all(_line_ok(t, language) for t in texts):
        return "language"
    if language == "ja" and not any(_KANA.search(t) for t in texts):
        return "language"
    if any(_too_long(t, language) for t in texts):
        return "too-long"
    if check_duplicates:
        opening = normalize(texts[0])
        joined = _joined(lines)
        for other in existing:
            if other and normalize(other[0]["text"]) == opening:
                return "same-opening"
            if difflib.SequenceMatcher(None, joined, _joined(other)).ratio() >= _SIMILAR:
                return "too-similar"
    return None
```

(`scenarios.validate_item`은 빈 text와 speaker 순서를 이미 검사한다.)

- [ ] **Step 4: GREEN** — `tests/test_library.py` 통과. 전체 `-m "not engine"`에서 턴 수 8을 가정한 기존 테스트가 떨어지면(예: 마무리 유도 경계) 그 테스트의 숫자만 `config.DEFAULT_MAX_TURNS` 기준으로 바꾸고 보고서에 적는다. 기존 동작(마무리 유도 = `max_turns - 2`)은 바꾸지 않는다.

- [ ] **Step 5: 부수기** — (1) `len(lines) != expected_lines` → `< expected_lines`: 17줄 케이스 FAIL. (2) `_line_ok`의 `not _CJK.search` 삭제: `没问题`/`はい` 케이스 FAIL. (3) `_SIMILAR = 0.95`: `too_similar` FAIL. (4) 일본어 가나 전체 검사 삭제: `我想要咖啡` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: twenty themes, sixteen turns, and a script check the library can trust`

---

### Task 2: `library_scenarios` 테이블과 대본 고르기

**Files:**
- Modify: `app/db.py`(MIGRATIONS 끝, 파일 끝 함수), `app/scenarios.py`(`get_scenario`), `app/library.py`(고르기)
- Test: `tests/test_db.py`(v5), `tests/test_library.py`(고르기), `tests/test_scenarios.py`(찾기)

**Interfaces:**
- Consumes: Task 1 `library`.
- Produces:
  - `db.add_library_scenario(item: dict) -> None` -- item은 `scenarios.validate_item`을 통과한 모양 + `theme_id`, `situation`.
  - `db.library_scenarios(language: str, theme_id: str, kind: str) -> list[dict]` -- `from_row` 모양 + `theme_id`, `situation`, `id` 순.
  - `db.get_library_scenario(scenario_id) -> dict | None`
  - `db.last_started(scenario_ids: list[str]) -> dict[str, str]` -- id → 그 id로 시작한 세션의 가장 최근 `started_at`(없으면 키 없음).
  - `library.pick_script(language, theme_id, rng=random) -> dict | None`, `library.free_setup(language, theme_id) -> dict | None`

- [ ] **Step 1: 실패하는 테스트**

`tests/test_db.py` 끝:

```python
def test_v5_adds_the_library_table_without_touching_existing_rows(store):
    sid = store.create_session("en", "free", scenario_id="restaurant-seating-en")
    store.init_db()
    with store.connect() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(library_scenarios)")}
    assert {"id", "theme_id", "situation", "language", "type", "title", "lines_json"} <= cols
    assert store.get_session(sid)["scenario_id"] == "restaurant-seating-en"


def test_library_rows_round_trip_in_the_catalogue_shape(store):
    lines = [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hello."}]
    store.add_library_scenario({"id": "lib-hotel-en-01", "theme_id": "hotel", "situation": "체크인",
                                "language": "en", "type": "script", "title": "체크인", "lines": lines})
    store.add_library_scenario({"id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None,
                                "language": "en", "type": "free", "title": "호텔",
                                "goal": "방 열쇠를 받는다", "persona_prompt": "You are a clerk.", "max_turns": 16})
    got = store.library_scenarios("en", "hotel", "script")
    assert [s["id"] for s in got] == ["lib-hotel-en-01"]
    assert got[0]["lines"] == lines and got[0]["theme_id"] == "hotel" and got[0]["situation"] == "체크인"
    assert store.get_library_scenario("lib-hotel-en-free")["persona_prompt"] == "You are a clerk."
    assert store.get_library_scenario("nope") is None


def test_last_started_reports_the_latest_session_per_scenario(store, monkeypatch):
    times = iter(["2026-09-01T00:00:00+00:00", "2026-09-03T00:00:00+00:00", "2026-09-02T00:00:00+00:00"])
    monkeypatch.setattr(store, "_now", lambda: next(times))
    store.create_session("en", "script", scenario_id="a")
    store.create_session("en", "script", scenario_id="a")
    store.create_session("en", "script", scenario_id="b")
    assert store.last_started(["a", "b", "c"]) == {"a": "2026-09-03T00:00:00+00:00",
                                                   "b": "2026-09-02T00:00:00+00:00"}
    assert store.last_started([]) == {}
```

(`store` 픽스처와 `_now` 이름은 기존 파일에서 확인하고 맞춘다.)

`tests/test_scenarios.py` 끝(`_isolated_db` 픽스처 사용 방식을 기존 테스트에서 따른다):

```python
def test_get_scenario_finds_a_library_one(tmp_path, monkeypatch):
    db.add_library_scenario({"id": "lib-hotel-ja-01", "theme_id": "hotel", "situation": "체크인",
                             "language": "ja", "type": "script", "title": "체크인",
                             "lines": [{"speaker": "bot", "text": "いらっしゃいませ。"},
                                       {"speaker": "user", "text": "予約しています。"}]})
    assert scenarios.get_scenario("lib-hotel-ja-01")["lines"][0]["text"] == "いらっしゃいませ。"


def test_library_scenarios_do_not_join_the_old_catalogue_list(tmp_path, monkeypatch):
    db.add_library_scenario({"id": "lib-hotel-en-01", "theme_id": "hotel", "situation": "x",
                             "language": "en", "type": "script", "title": "x",
                             "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})
    assert all(s["id"] != "lib-hotel-en-01" for s in scenarios.scenarios_for("en", "script"))
```

`tests/test_library.py` 끝:

```python
from app import db


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    return db


def _add(store, n, theme="hotel", language="en"):
    store.add_library_scenario({"id": f"lib-{theme}-{language}-{n:02d}", "theme_id": theme, "situation": "s",
                                "language": language, "type": "script", "title": f"t{n}",
                                "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})


def test_pick_prefers_a_script_never_played(store):
    for n in (1, 2, 3):
        _add(store, n)
    store.create_session("en", "script", scenario_id="lib-hotel-en-01")
    store.create_session("en", "script", scenario_id="lib-hotel-en-03")
    assert library.pick_script("en", "hotel")["id"] == "lib-hotel-en-02"


def test_pick_chooses_randomly_among_the_unplayed(store):
    for n in (1, 2, 3):
        _add(store, n)
    import random
    picks = {library.pick_script("en", "hotel", rng=random.Random(seed))["id"] for seed in range(30)}
    assert picks == {"lib-hotel-en-01", "lib-hotel-en-02", "lib-hotel-en-03"}


def test_when_all_were_played_pick_the_one_played_longest_ago(store, monkeypatch):
    for n in (1, 2):
        _add(store, n)
    times = iter(["2026-09-05T00:00:00+00:00", "2026-09-01T00:00:00+00:00"])
    monkeypatch.setattr(db, "_now", lambda: next(times))
    store.create_session("en", "script", scenario_id="lib-hotel-en-01")
    store.create_session("en", "script", scenario_id="lib-hotel-en-02")
    assert library.pick_script("en", "hotel")["id"] == "lib-hotel-en-02"


def test_pick_is_scoped_to_language_and_theme_and_empty_is_none(store):
    _add(store, 1, theme="hotel", language="ja")
    assert library.pick_script("en", "hotel") is None
    assert library.pick_script("ja", "cafe-restaurant") is None


def test_free_setup(store):
    store.add_library_scenario({"id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None,
                                "language": "en", "type": "free", "title": "호텔", "goal": "g",
                                "persona_prompt": "p", "max_turns": 16})
    assert library.free_setup("en", "hotel")["id"] == "lib-hotel-en-free"
    assert library.free_setup("ja", "hotel") is None
```

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현**

`app/db.py` `MIGRATIONS` 끝에 v4→v5 단계를 추가(주석: 테마 라이브러리, 스펙 경로, 데이터는 생성 스크립트가 다시 만들 수 있음):

```python
    # v4 -> v5: the theme library (docs/superpowers/specs/2026-09-14-monologue-
    # theme-library-design.md). Same columns as user_scenarios so scenarios.from_row
    # reads both, plus theme_id and situation. Rows come from scripts/build_library.py
    # and can be rebuilt from it; nothing here is the learner's own data.
    ["""
    CREATE TABLE IF NOT EXISTS library_scenarios (
        id             TEXT PRIMARY KEY,
        theme_id       TEXT    NOT NULL,
        situation      TEXT,
        language       TEXT    NOT NULL,
        type           TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        goal           TEXT,
        persona_prompt TEXT,
        max_turns      INTEGER,
        lines_json     TEXT,
        created_at     TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_theme
        ON library_scenarios(language, type, theme_id);
    """],
```

파일 끝(`get_user_scenario` 뒤):

```python
def add_library_scenario(item) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO library_scenarios (id, theme_id, situation, language, type, title,"
            " goal, persona_prompt, max_turns, lines_json, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item["id"], item["theme_id"], item.get("situation"), item["language"], item["type"],
             item["title"], item.get("goal"), item.get("persona_prompt"), item.get("max_turns"),
             json.dumps(item["lines"], ensure_ascii=False) if item.get("lines") else None,
             _now()),
        )


def _library_item(row) -> dict:
    item = scenarios.from_row(row)
    item["theme_id"] = row["theme_id"]
    item["situation"] = row["situation"]
    return item


def library_scenarios(language, theme_id, kind) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM library_scenarios WHERE language = ? AND theme_id = ? AND type = ?"
            " ORDER BY id", (language, theme_id, kind)).fetchall()
    return [_library_item(r) for r in rows]


def get_library_scenario(scenario_id):
    with connect() as conn:
        row = conn.execute("SELECT * FROM library_scenarios WHERE id = ?", (scenario_id,)).fetchone()
    return _library_item(row) if row else None


def last_started(scenario_ids) -> dict:
    """id -> the newest started_at among sessions opened on it. Ids never played
    are absent -- that absence is what library.pick_script reads as 'new'."""
    ids = list(scenario_ids)
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    with connect() as conn:
        rows = conn.execute(
            f"SELECT scenario_id, MAX(started_at) AS last FROM sessions"
            f" WHERE scenario_id IN ({marks}) GROUP BY scenario_id", ids).fetchall()
    return {r["scenario_id"]: r["last"] for r in rows}
```

`app/scenarios.py` `get_scenario`:

```python
def get_scenario(scenario_id):
    for s in load_scenarios():
        if s["id"] == scenario_id:
            return s
    return db.get_user_scenario(scenario_id) or db.get_library_scenario(scenario_id)
```

`app/library.py`에 추가(맨 위 import에 `import random`, `from app import db`):

```python
def pick_script(language, theme_id, rng=random):
    """다음에 연습할 대본: 한 번도 안 해본 것 중 무작위, 다 해봤으면 가장 오래전에
    한 것. 같은 문장을 반복해 입에 붙이는 것도 연습이라 다 돌면 다시 준다."""
    items = db.library_scenarios(language, theme_id, "script")
    if not items:
        return None
    last = db.last_started([s["id"] for s in items])
    fresh = [s for s in items if s["id"] not in last]
    if fresh:
        return rng.choice(fresh)
    return min(items, key=lambda s: (last[s["id"]], s["id"]))


def free_setup(language, theme_id):
    items = db.library_scenarios(language, theme_id, "free")
    return items[0] if items else None
```

- [ ] **Step 4: GREEN** — 전체 `-m "not engine"`.

- [ ] **Step 5: 부수기** — (1) `get_scenario`에서 `or db.get_library_scenario(...)` 삭제: `finds_a_library_one` FAIL. (2) `fresh` 분기 삭제: `prefers_a_script_never_played` FAIL. (3) `min`을 `max`로: `played_longest_ago` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: a library table, and pick the script you have not played yet`

---

### Task 3: 생성 — 16줄 프롬프트, `/scenarios/generate` 검사, `scripts/build_library.py`

**Files:**
- Modify: `app/prompts.py`(`SCENARIO_SYSTEM_SCRIPT`, 새 `build_library_script_messages`), `app/api.py`(`generate_scenario`)
- Create: `scripts/build_library.py`, `tests/test_build_library.py`
- Test: `tests/test_prompts.py`, `tests/test_api_chat.py` 또는 generate 테스트가 있는 파일(`grep -rn "scenarios/generate" tests`로 찾는다)

**Interfaces:**
- Consumes: `library.load_themes`, `library.check_script`, `db.add_library_scenario`, `db.library_scenarios`, `prompts.build_scenario_messages`, `prompts.scenario_schema`, `llm.chat_json`.
- Produces:
  - `prompts.build_library_script_messages(language, theme_title, situation, previous: list[dict]) -> list[dict]` -- `previous`는 `[{"title", "opening"}]`(최근 10개만 넣는다).
  - `scripts/build_library.py`의 `build(themes, languages, per_theme, *, chat_json=llm.chat_json, log=print) -> dict` -- 반환 `{"added": int, "retries": int, "gave_up": int, "reasons": dict[str,int]}`.

- [ ] **Step 1: 실패하는 테스트**

`tests/test_prompts.py` 끝:

```python
def test_generated_scripts_are_sixteen_lines():
    system = prompts.build_scenario_messages("en", "script", "cafe")[0]["content"]
    assert "대사 16줄" in system and "대사 8줄" not in system


def test_library_script_prompt_names_theme_situation_and_what_to_avoid():
    msgs = prompts.build_library_script_messages(
        "ja", "호텔", "체크아웃 연장",
        [{"title": f"제목{i}", "opening": f"첫대사{i}"} for i in range(12)])
    system, user = msgs[0]["content"], msgs[-1]["content"]
    assert "대사 16줄" in system
    assert prompts.JAPANESE_SCRIPT_ONLY_RULE in system
    assert "호텔" in user and "체크아웃 연장" in user
    assert "제목11" in user and "첫대사11" in user
    assert "제목1\n" not in user and "제목0" not in user   # only the most recent ten


def test_library_script_prompt_without_previous_scripts_has_no_avoid_list():
    user = prompts.build_library_script_messages("en", "호텔", "체크인", [])[-1]["content"]
    assert "다르게" not in user
```

(`"제목1\n"` 검사가 `제목10`·`제목11`과 겹치지 않게, 구현이 목록을 줄마다 `- 제목: ... / 첫 대사: ...` 형태로 쓰면 `"- 제목1 "` 같은 정확한 접두어로 바꿔 검사한다. 핵심: 최근 10개(인덱스 2~11)만 들어간다.)

`tests/test_build_library.py`:

```python
import pytest

from app import config, db
from scripts import build_library


def _lines(prefix, n=16):
    """Lines that differ from any other prefix's lines almost entirely -- the
    builder's similarity check (0.8) would otherwise reject a shared template.
    The same prefix gives the same lines (that is how the duplicate test works)."""
    import hashlib
    out = []
    for i in range(n):
        h = hashlib.sha1(f"{prefix}-{i}".encode()).hexdigest().translate(str.maketrans("0123456789", "ghijklmnop"))
        text = f"{prefix} line {i} for practice." if i == 0 else f"{h[:7]} {h[7:14]} {h[14:21]}."
        out.append({"speaker": "bot" if i % 2 == 0 else "user", "text": text})
    return out


THEME = {"id": "hotel", "category": "travel", "title": "호텔", "situations": ["체크인", "방 문제", "짐 맡기기"]}


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    return db


class FakeModel:
    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.calls = []

    def __call__(self, messages, schema, **kw):
        self.calls.append(messages)
        if "persona_prompt" in schema.get("properties", {}):
            return {"title": "호텔 프런트", "goal": "방 열쇠를 받는다", "persona_prompt": "You are a hotel clerk."}
        nxt = self.scripts.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return {"title": nxt[0], "lines": nxt[1]}


def test_builds_the_missing_count_and_the_free_setup(store):
    model = FakeModel([(f"t{i}", _lines(f"Unique{i} alpha{i*13}")) for i in range(3)])
    report = build_library.build([THEME], ["en"], 3, chat_json=model, log=lambda *a: None)
    scripts = db.library_scenarios("en", "hotel", "script")
    assert [s["id"] for s in scripts] == ["lib-hotel-en-01", "lib-hotel-en-02", "lib-hotel-en-03"]
    assert [s["situation"] for s in scripts] == ["체크인", "방 문제", "짐 맡기기"]
    assert db.get_library_scenario("lib-hotel-en-free")["max_turns"] == config.DEFAULT_MAX_TURNS
    assert report["added"] == 3


def test_resumes_where_it_stopped(store):
    build_library.build([THEME], ["en"], 2, chat_json=FakeModel(
        [(f"t{i}", _lines(f"First{i} beta{i*17}")) for i in range(2)]), log=lambda *a: None)
    model = FakeModel([("t9", _lines("Third gamma99"))])
    build_library.build([THEME], ["en"], 3, chat_json=model, log=lambda *a: None)
    assert len(db.library_scenarios("en", "hotel", "script")) == 3
    assert db.library_scenarios("en", "hotel", "script")[-1]["situation"] == "짐 맡기기"
    assert sum("persona_prompt" not in str(c) for c in model.calls) == 1   # only the one missing script


def test_a_failing_generation_is_retried_then_given_up(store):
    bad = ("bad", _lines("Short", n=15))
    model = FakeModel([bad, bad, bad, bad, ("ok", _lines("Fine delta42"))])
    report = build_library.build([THEME], ["en"], 2, chat_json=model, log=lambda *a: None)
    assert report["gave_up"] == 1 and report["retries"] == 3
    assert report["reasons"]["line-count"] == 4
    assert [s["id"] for s in db.library_scenarios("en", "hotel", "script")] == ["lib-hotel-en-02"]


def test_model_errors_count_as_retries(store):
    from app.llm import LLMError
    model = FakeModel([LLMError("down"), ("ok", _lines("Recovered eps7"))])
    report = build_library.build([THEME], ["en"], 1, chat_json=model, log=lambda *a: None)
    assert report["added"] == 1 and report["reasons"]["model-error"] == 1


def test_duplicates_of_stored_scripts_are_rejected(store):
    same = _lines("Repeat zeta")
    model = FakeModel([("a", same), ("b", same), ("c", _lines("Other eta88"))])
    report = build_library.build([THEME], ["en"], 2, chat_json=model, log=lambda *a: None)
    assert report["added"] == 2 and report["reasons"]["same-opening"] == 1


def test_previous_titles_and_openings_reach_the_prompt(store):
    model = FakeModel([("first title", _lines("Opening theta1")), ("second", _lines("Opening iota2"))])
    build_library.build([THEME], ["en"], 2, chat_json=model, log=lambda *a: None)
    last_user = [c for c in model.calls if "persona_prompt" not in str(c)][-1][-1]["content"]
    assert "first title" in last_user and "Opening theta1 line 0 for practice." in last_user
```

generate 테스트 파일에 추가(기존 픽스처·목 방식 따름):

```python
def test_generate_retries_a_script_that_fails_the_check_once(client, monkeypatch):
    good = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"Line {i} okay."} for i in range(16)]
    answers = iter([{"title": "t", "lines": good[:15]}, {"title": "t", "lines": good}])
    calls = []
    def fake(messages, schema, **kw):
        calls.append(1)
        return next(answers)
    monkeypatch.setattr("app.api.llm.chat_json", fake)
    r = client.post("/api/scenarios/generate", json={"language": "en", "mode": "script", "wish": "cafe"})
    assert r.status_code == 200 and len(calls) == 2


def test_generate_gives_up_after_the_second_bad_script(client, monkeypatch):
    bad = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"Line {i}."} for i in range(15)]
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {"title": "t", "lines": bad})
    r = client.post("/api/scenarios/generate", json={"language": "en", "mode": "script", "wish": "cafe"})
    assert r.status_code == 422
```

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현**

`app/prompts.py`:
- `SCENARIO_SYSTEM_SCRIPT`의 `- lines: 대사 8줄.` → `- lines: 대사 16줄.`
- 파일의 대본 프롬프트 근처에 추가:

```python
_LIBRARY_PREVIOUS = 10


def build_library_script_messages(language, theme_title, situation, previous) -> list[dict]:
    """라이브러리용 대본 한 편. 같은 테마에서 30편을 만들면 서로 닮아가므로, 최근에
    만든 것의 제목과 첫 대사를 보여주고 다르게 쓰라고 한다."""
    system = SCENARIO_SYSTEM_SCRIPT.format(lang=KOREAN_LANGUAGE_NAMES[language])
    system += "\n초보 학습자가 소리 내어 따라 읽을 대본입니다. 한 줄은 짧게 씁니다."
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    user = f"테마: {theme_title}\n세부 상황: {situation}"
    recent = list(previous)[-_LIBRARY_PREVIOUS:]
    if recent:
        listed = "\n".join(f"- 제목: {p['title']} / 첫 대사: {p['opening']}" for p in recent)
        user += f"\n\n이미 만든 대본입니다. 제목, 첫 대사, 흐름이 이것들과 다르게 쓰세요.\n{listed}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]
```

`app/api.py` `generate_scenario`: 스크립트일 때 `llm.chat_json` 호출과 결과 조립을 `for attempt in range(2)` 루프로 감싼다 -- `library.check_script(result.get("lines"), payload.language, check_duplicates=False)`가 None이면 `break`, 아니면 다시. 두 번째도 실패하면 `HTTPException(422, f"만들어진 대본이 올바르지 않습니다: {reason}")`. 자유 모드는 한 번(지금과 같음). `from app import library`를 import에 추가. 기존 `scenarios.validate_item` 호출은 그대로 둔다.

`scripts/build_library.py` (`scripts/__init__.py`도 빈 파일로 만들어 테스트가 import할 수 있게):

```python
"""테마 라이브러리 일괄 생성. 앱 밖에서 한 번(또는 끊어서 여러 번) 돌린다.

    C:/git/Monologue/venv/Scripts/python.exe scripts/build_library.py
    ... --language ja --theme hotel cafe-restaurant --per-theme 3

이미 저장된 편수만큼 건너뛰므로 중간에 끊어도 다시 실행하면 이어진다.
GPU를 다른 프로그램(게임)이 쓰면 10배 가까이 느려진다(2026-09-14 실측).
"""
import argparse
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config, db, library, llm, prompts, scenarios  # noqa: E402

_ATTEMPTS = 3   # retries after the first try


def _free_setup(theme, language, chat_json):
    wish = f"{theme['title']} ({', '.join(theme['situations'])})"
    result = chat_json(prompts.build_scenario_messages(language, "free", wish),
                       prompts.scenario_schema("free"))
    item = {"id": f"lib-{theme['id']}-{language}-free", "theme_id": theme["id"], "situation": None,
            "language": language, "type": "free", "title": theme["title"],
            "goal": (result.get("goal") or "").strip() or None,
            "persona_prompt": (result.get("persona_prompt") or "").strip(),
            "max_turns": config.DEFAULT_MAX_TURNS}
    scenarios.validate_item(item)
    db.add_library_scenario(item)


def build(themes, languages, per_theme, *, chat_json=llm.chat_json, log=print):
    stats = {"added": 0, "retries": 0, "gave_up": 0, "reasons": Counter()}
    for language in languages:
        for theme in themes:
            if not db.library_scenarios(language, theme["id"], "free"):
                try:
                    _free_setup(theme, language, chat_json)
                except Exception as exc:  # a missing free setup is retried next run
                    stats["reasons"]["free-setup"] += 1
                    log(f"[{language}] {theme['id']} free setup failed: {exc}")
            existing = db.library_scenarios(language, theme["id"], "script")
            used = {s["id"] for s in existing}
            for n in range(1, per_theme + 1):
                sid = f"lib-{theme['id']}-{language}-{n:02d}"
                if sid in used:
                    continue
                situation = theme["situations"][(n - 1) % len(theme["situations"])]
                previous = [{"title": s["title"], "opening": s["lines"][0]["text"]} for s in existing]
                messages = prompts.build_library_script_messages(language, theme["title"], situation, previous)
                for attempt in range(_ATTEMPTS + 1):
                    if attempt:
                        stats["retries"] += 1
                    try:
                        result = chat_json(messages, prompts.scenario_schema("script"))
                    except llm.LLMError:
                        stats["reasons"]["model-error"] += 1
                        continue
                    lines = result.get("lines") if isinstance(result, dict) else None
                    reason = library.check_script(lines, language, [s["lines"] for s in existing])
                    if reason:
                        stats["reasons"][reason] += 1
                        continue
                    item = {"id": sid, "theme_id": theme["id"], "situation": situation, "language": language,
                            "type": "script", "title": (result.get("title") or situation).strip(),
                            "lines": lines}
                    db.add_library_scenario(item)
                    existing.append(db.get_library_scenario(sid))
                    stats["added"] += 1
                    log(f"[{language}] {theme['id']} {n:02d}/{per_theme} ok")
                    break
                else:
                    stats["gave_up"] += 1
                    log(f"[{language}] {theme['id']} {n:02d}/{per_theme} gave up")
    stats["reasons"] = dict(stats["reasons"])
    return stats


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=config.LANGUAGES, action="append")
    parser.add_argument("--theme", nargs="*")
    parser.add_argument("--per-theme", type=int, default=config.LIBRARY_PER_THEME)
    args = parser.parse_args(argv)
    db.init_db()
    themes = library.load_themes()
    if args.theme:
        themes = [t for t in themes if t["id"] in args.theme]
    started = time.perf_counter()
    report = build(themes, args.language or list(config.LANGUAGES), args.per_theme)
    report["minutes"] = round((time.perf_counter() - started) / 60, 1)
    print(report)


if __name__ == "__main__":
    main()
```

(한 편이 `_ATTEMPTS + 1`번 = 4번 시도 → "재생성 최대 3번". 테스트 `retried_then_given_up`은 이 해석을 고정한다: 첫 편 4번 실패 = retries 3, 두 번째 편 1번에 성공.)

- [ ] **Step 4: GREEN** — 전체 `-m "not engine"`.

- [ ] **Step 5: 부수기** — (1) `if sid in used: continue` 삭제: `resumes_where_it_stopped` FAIL. (2) `[s["lines"] for s in existing]` → `[]`: `duplicates_of_stored_scripts` FAIL. (3) `range(_ATTEMPTS + 1)` → `range(1)`: `retried_then_given_up` FAIL. (4) generate 루프를 `range(1)`: `retries_a_script_that_fails_the_check_once` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: sixteen-line scripts, and a resumable library builder that checks every one`

---

### Task 4: `GET /api/themes`, `POST /api/library/pick`, 뒤에서 음성 합성

**Files:**
- Modify: `app/api.py`
- Create: `tests/test_api_library.py`

**Interfaces:**
- Consumes: `library.load_themes`, `library.get_theme`, `library.pick_script`, `library.free_setup`, `api._speak`.
- Produces:
  - `GET /api/themes?language=en|ja` → `{"themes": [{"id","category","title","situations","ready": {"free": bool, "script": int}}]}` -- `script`는 그 언어 편수.
  - `POST /api/library/pick` `{language, mode, theme_id}` → `{"id","title","situation"}`; 404 없는 테마, 400 lesson, 409 `"이 테마는 아직 준비되지 않았어요"`.
  - `api._prepare_audio(lines, language)` -- 실행기에 제출, 캐시에 없는 줄만 `_speak`.
  - `api._audio_executor` (`ThreadPoolExecutor(max_workers=1)`)

- [ ] **Step 1: 실패하는 테스트**

`tests/test_api_library.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app import api, config, db, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    return TestClient(app)


class ImmediateExecutor:
    def __init__(self):
        self.jobs = []

    def submit(self, fn, *args):
        self.jobs.append(args)
        fn(*args)


def _script(n, theme="hotel", language="en"):
    lines = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"{theme} {n} line {i}."} for i in range(16)]
    db.add_library_scenario({"id": f"lib-{theme}-{language}-{n:02d}", "theme_id": theme, "situation": "체크인",
                             "language": language, "type": "script", "title": f"제목{n}", "lines": lines})
    return lines


def test_themes_lists_twenty_with_readiness(client):
    _script(1)
    db.add_library_scenario({"id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None, "language": "en",
                             "type": "free", "title": "호텔", "goal": "g", "persona_prompt": "p", "max_turns": 16})
    themes = client.get("/api/themes?language=en").json()["themes"]
    assert len(themes) == 20
    hotel = next(t for t in themes if t["id"] == "hotel")
    assert hotel["ready"] == {"free": True, "script": 1}
    assert next(t for t in themes if t["id"] == "shopping")["ready"] == {"free": False, "script": 0}


def test_pick_a_script_and_prepare_its_audio_in_the_background(client, monkeypatch):
    lines = _script(1)
    ex = ImmediateExecutor()
    monkeypatch.setattr(api, "_audio_executor", ex)
    body = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"}).json()
    assert body == {"id": "lib-hotel-en-01", "title": "제목1", "situation": "체크인"}
    assert len(ex.jobs) == 1 and ex.jobs[0][0] == lines
    for line in lines:
        key = tts.cache_key(api.clean_for_tts(line["text"]), "en", api.selected_voice("en"))
        assert tts.cached_path(key).exists()


def test_pick_then_start_uses_the_cached_audio(client, monkeypatch):
    _script(1)
    monkeypatch.setattr(api, "_audio_executor", ImmediateExecutor())
    picked = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"}).json()
    calls = []
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: calls.append(t) or b"RIFFfake")
    r = client.post("/api/sessions", json={"language": "en", "mode": "script", "scenario_id": picked["id"]})
    assert r.status_code == 200 and len(r.json()["lines"]) == 16
    assert calls == []


def test_pick_free_returns_the_theme_setup(client):
    db.add_library_scenario({"id": "lib-hotel-ja-free", "theme_id": "hotel", "situation": None, "language": "ja",
                             "type": "free", "title": "호텔", "goal": "g", "persona_prompt": "p", "max_turns": 16})
    body = client.post("/api/library/pick", json={"language": "ja", "mode": "free", "theme_id": "hotel"}).json()
    assert body["id"] == "lib-hotel-ja-free"


def test_pick_errors(client):
    assert client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "nope"}).status_code == 404
    assert client.post("/api/library/pick", json={"language": "en", "mode": "lesson", "theme_id": "hotel"}).status_code == 400
    r = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"})
    assert r.status_code == 409 and r.json()["detail"] == "이 테마는 아직 준비되지 않았어요"
    assert client.post("/api/library/pick", json={"language": "en", "mode": "free", "theme_id": "hotel"}).status_code == 409


def test_background_audio_failure_is_swallowed(client, monkeypatch):
    _script(1)
    monkeypatch.setattr(api, "_audio_executor", ImmediateExecutor())
    def dead(t, l, v):
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", dead)
    r = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"})
    assert r.status_code == 200
```

(`tts.cache_key`, `tts.cached_path`, `api.clean_for_tts`, `api.selected_voice`는 기존 이름이다 -- `app/api.py`의 `_resumable_audio_key`가 같은 조합을 쓴다.)

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현** — `app/api.py`, `list_scenarios` 라우트 뒤:

```python
from concurrent.futures import ThreadPoolExecutor   # (파일 맨 위 import로)

THEME_NOT_READY = "이 테마는 아직 준비되지 않았어요"

# 한 줄씩 순서대로. VOICEVOX를 동시에 두드려도 빨라지지 않고, 세션 시작의
# _speak와 겹칠 뿐이다. 캐시 키가 같으므로 겹쳐도 결과는 같다.
_audio_executor = ThreadPoolExecutor(max_workers=1)


@router.get("/themes")
def list_themes(language: Language):
    out = []
    for theme in library.load_themes():
        out.append({**theme, "ready": {
            "free": library.free_setup(language, theme["id"]) is not None,
            "script": len(db.library_scenarios(language, theme["id"], "script")),
        }})
    return {"themes": out}


class LibraryPick(BaseModel):
    language: Language
    mode: Mode
    theme_id: str


def _prepare_audio(lines, language):
    """Warm the TTS cache for a script the learner is about to open. Best effort:
    start_session's own _speak synthesises anything this did not get to."""
    for line in lines:
        try:
            _speak(line["text"], language)
        except Exception:
            pass


@router.post("/library/pick")
def pick_from_library(payload: LibraryPick):
    if library.get_theme(payload.theme_id) is None:
        raise HTTPException(404, "no such theme")
    if payload.mode == "lesson":
        raise HTTPException(400, "lesson mode has no themes")
    if payload.mode == "free":
        item = library.free_setup(payload.language, payload.theme_id)
    else:
        item = library.pick_script(payload.language, payload.theme_id)
    if item is None:
        raise HTTPException(409, THEME_NOT_READY)
    if payload.mode == "script":
        _audio_executor.submit(_prepare_audio, item["lines"], payload.language)
    return {"id": item["id"], "title": item["title"], "situation": item.get("situation")}
```

`library`를 `from app import ...`에 추가. (`_speak`는 이미 TTSError를 None으로 바꾸지만, 캐시 쓰기 실패 같은 다른 예외도 뒤에서 조용히 넘어가야 한다.)

- [ ] **Step 4: GREEN** — 전체.

- [ ] **Step 5: 부수기** — (1) `_audio_executor.submit` 줄 삭제: `prepare_its_audio`, `uses_the_cached_audio` FAIL. (2) `_prepare_audio`의 `try/except` 삭제하고 `_speak` 대신 `tts.synthesize_to_cache` 직접 호출: `failure_is_swallowed` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: GET /api/themes and POST /api/library/pick, warming the script's audio behind it`

---

### Task 5: 화면 — 모드 먼저, 테마 선택, 단계 로딩 표시

**Files:**
- Modify: `static/index.html`, `static/js/main.js`, `static/js/home.js`, `static/js/reading.js`, `static/css/components.css`, `static/js/home.test.js`
- Create: `static/js/pick.js`, `static/js/pick.test.js`

**Interfaces:**
- Consumes: `GET /api/themes?language=`, `POST /api/library/pick`, `GET /api/scenarios?language=&mode=`(내가 만든 것: `id`가 `user-`로 시작하는 항목), `POST /api/scenarios/generate`, `startSession` (session.js).
- Produces (`static/js/pick.js`):
  - `STATUS = { pickScript: '대본 고르는 중...', audio: '음성 준비 중...', makeScript: '대본 만드는 중...', makeScene: '상황 만드는 중...', opening: '첫 대사 만드는 중...' }`
  - `CATEGORY_LABELS = { daily: '일상', travel: '여행', smalltalk: '스몰토크', business: '비즈니스', mine: '내가 만든 것' }`
  - `openPick(mode): Promise<void>` -- `state.mode = mode`, 화면 전환, 모드 이름, 수업이면 테마 영역 숨김, 테마·내가 만든 것 불러오기
  - `selectCategory(key): void`, `selectTheme(themeId): Promise<void>`, `startFromPick(): Promise<void>`
  - `setStatus(text | null): void` -- `#start-status` 표시/숨김 + 문구
- 제거: `home.js`의 `loadChips`, `startFromHome`(이동). `home.js`에는 `loadHome`, `resumeSession`, `relativeDay`와 이어하기 로딩 문구가 남는다. `busy` 가드는 두 모듈이 공유해야 하므로 `home.js`의 `busy`를 `export function isBusy()`/`setBusy(v)`로 내보내거나, 가드를 `pick.js`로 옮기고 `resumeSession`이 `pick.js`의 것을 import한다(**session.js는 둘 다 import하지 않는다** -- home.js 헤더의 단방향 규칙). 선택한 쪽을 보고서에 적는다.

**마크업** (`static/index.html`):
- `#home`에서 `.home-ask`(`#wish`, `.hint`, `#chips`)와 `#btn-start` 삭제. `#modes`의 버튼은 그대로 두되 `.on` 클래스 없이.
- `#home` 뒤에 새 섹션:

```html
  <section id="pick" hidden>
    <div class="pick-head">
      <button id="btn-home" class="ghost" type="button">← 홈</button>
      <h2 id="pick-mode"></h2>
      <span class="seg" id="pick-language-seg">
        <button type="button" data-language="en">English</button>
        <button type="button" data-language="ja">日本語</button>
      </span>
    </div>
    <div id="pick-themes">
      <div id="category-tabs" class="tabs" role="tablist"></div>
      <div id="theme-grid" class="theme-grid"></div>
    </div>
    <div class="home-ask">
      <input id="wish" type="text" aria-label="직접 만들기">
      <p id="wish-hint" class="hint"></p>
    </div>
    <button id="btn-start" class="primary">시작</button>
    <div id="start-status" class="start-status" hidden>
      <div class="thinking"><i></i><i></i><i></i></div>
      <span id="start-status-text"></span>
    </div>
  </section>
```

- 입력칸 안내: 자유·스크립트 `placeholder="직접 만들기: 예) 이사 업체에 견적 묻기"`, `#wish-hint` `목록에 없는 상황을 쓰면 새로 만들어요`; 수업 `placeholder="예: 과거형, 식당에서 쓰는 표현"`, `#wish-hint` `비워두면 선생님이 골라줍니다`.
- `#resume-card` 안에 `<p id="resume-status" class="hint" hidden>대화 불러오는 중...</p>`.

**동작 규칙:**
- 모드 카드 클릭 → `openPick(mode)`. `← 홈` → `router.show('home')`, `loadHome()`.
- 언어 선택은 두 seg가 같은 핸들러를 쓴다: `state.language` 변경, 두 seg의 `.on` 동기화, `#pick`에 있으면 테마 다시 불러오기(선택 해제), 홈이면 `loadHome()`.
- 테마·카테고리 불러오기는 **요청 시점의 language·mode를 잡아 두고**, 응답이 왔을 때 달라졌으면 버린다(home.js의 기존 규칙).
- 카테고리 탭: `THEME_CATEGORIES` 순 네 개 + 내가 만든 것이 1개 이상이면 `내가 만든 것`. 첫 탭 선택 상태로 시작.
- 테마 카드: `<button class="theme-card" data-theme="id">` 안에 이름(`.t`)과 세부 상황을 ` · `로 이은 요약(`.s`). `ready`(자유면 `free`, 스크립트면 `script > 0`)가 false면 `disabled` + `.s`에 `준비 중`.
- 내가 만든 것 카드: `data-scenario="id"`, 이름만.
- 테마 카드 클릭 → 선택 표시(`.on`), 스크립트 모드면 즉시 `POST /library/pick`을 보내 **그 약속(Promise)** 을 들고 있는다(`pending = { themeId, promise }`). 다른 테마를 누르면 새 약속으로 바꾼다. 실패는 선택 해제 + `notify(err.message)`.
- `startFromPick()` (가드: 이미 시작 중이면 무시; language·mode를 시작 시점에 잡음; 시작 중에는 `#btn-start`·탭·카드·입력칸 disabled; 끝나면 `finally`에서 풀고 `setStatus(null)`):
  1. 수업: `setStatus(STATUS.opening)` → `startSession({language, mode, topic: wish || null})`.
  2. 입력칸에 글이 있음: 스크립트면 `STATUS.makeScript`, 자유면 `STATUS.makeScene` → `POST /scenarios/generate` → 스크립트면 `STATUS.audio`, 자유면 `STATUS.opening` → `startSession`.
  3. 내가 만든 것 카드가 선택됨: 스크립트 `STATUS.audio` / 자유 `STATUS.opening` → `startSession(scenarioId)`.
  4. 테마 선택됨(없으면 **지금 탭의 준비된 테마 중 무작위**를 선택한 것으로 친다): 스크립트면 들고 있는 약속이 없으면 지금 pick을 보내고, 끝나기 전이면 `STATUS.pickScript`를 보여주며 기다린 뒤 `STATUS.audio`; 자유면 pick 후 `STATUS.opening` → `startSession`.
  5. 실패: `setStatus(null)`, `notify` -- generate 실패 `대본을 만들지 못했어요: ...`(자유는 `상황을 만들지 못했어요: ...`), 그 밖 `시작하지 못했어요: ...`.
- `resumeSession`: 요청 동안 `#resume-status` 보이기, `finally`에서 숨김.
- `reading.js` `toggleMeaning`: 요청 전 `body.textContent = '뜻 가져오는 중...'; body.hidden = false;`.

**CSS** (`components.css`, 기존 토큰만 사용 -- `tests/test_css_tokens.py`):
- `.pick-head { display:flex; align-items:center; gap: var(--space-3); }` (`#pick-mode`는 `flex:1`)
- `.tabs`는 기존 `.seg`와 같은 모양(가로 버튼, `.on` 강조), `.theme-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-2); }`
- `.theme-card`는 기존 `.mode` 카드 모양을 따른다(`.t` 굵게, `.s` `--text-dim` 작은 글씨), `.on`은 `.mode.on`과 같은 강조, `:disabled` 흐리게.
- `.start-status { display:flex; align-items:center; gap: var(--space-2); color: var(--text-dim); font-size: var(--text-sm); }`
- `#home .modes .mode`는 이제 이동 버튼이므로 `.on` 스타일 대신 hover 강조만.

- [ ] **Step 1: 실패하는 테스트** — `static/js/pick.test.js` (home.test.js의 `beforeEach` 재import 방식을 따라 `pick.js?instance=N`로 매 테스트 새 모듈):

```js
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

let pick;
let instance = 0;
beforeEach(async () => {
  resetDom();
  router.register('home', 'home');
  router.register('pick', 'pick');
  router.register('session', 'session');
  state.language = 'en';
  state.sessionId = null;
  pick = await import(`./pick.js?instance=${++instance}`);
});

const THEMES = [
  { id: 'cafe-restaurant', category: 'daily', title: '카페·음식점 주문', situations: ['메뉴 추천 묻기', '포장 주문'], ready: { free: true, script: 30 } },
  { id: 'shopping', category: 'daily', title: '쇼핑·계산', situations: ['교환·환불'], ready: { free: false, script: 0 } },
  { id: 'hotel', category: 'travel', title: '호텔', situations: ['체크인'], ready: { free: true, script: 30 } },
];

function routes(extra = {}) {
  const seen = { picks: [], sessions: [], generates: [], statuses: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/themes')) return jsonResponse({ themes: THEMES });
    if (url.startsWith('/api/scenarios?')) return jsonResponse({ scenarios: extra.mine || [] });
    if (url === '/api/library/pick') {
      seen.picks.push(JSON.parse(options.body));
      if (extra.pick) return extra.pick(JSON.parse(options.body));
      return jsonResponse({ id: 'lib-hotel-en-07', title: '제목', situation: '체크인' });
    }
    if (url === '/api/scenarios/generate') {
      seen.generates.push(JSON.parse(options.body));
      seen.statuses.push($('start-status-text').textContent);
      return extra.generate ? extra.generate() : jsonResponse({ id: 'user-abc' });
    }
    if (url === '/api/sessions') {
      seen.sessions.push(JSON.parse(options.body));
      seen.statuses.push($('start-status-text').textContent);
      const mode = JSON.parse(options.body).mode;
      return jsonResponse(mode === 'script' ? { session_id: 1, mode, lines: [{ speaker: 'bot', text: 'Hi.' }] }
                                           : { session_id: 1, mode, opening: 'Hi.', opening_audio: null, goal: null });
    }
    return jsonResponse({});
  });
  return seen;
}

const tabs = () => $('category-tabs').children.map((b) => b.textContent);
const cards = () => $('theme-grid').children;

test('a mode opens the pick screen with its name and four category tabs', async () => {
  routes();
  await pick.openPick('script');
  assert.equal(router.current(), 'pick');
  assert.equal(state.mode, 'script');
  assert.equal($('pick-mode').textContent, '스크립트');
  assert.deepEqual(tabs(), ['일상', '여행', '스몰토크', '비즈니스']);
  assert.deepEqual(cards().map((c) => c.dataset.theme), ['cafe-restaurant', 'shopping']);
});

test('내가 만든 것 appears only when there is something in it', async () => {
  routes({ mine: [{ id: 'user-1', title: '이사 견적', type: 'script' }, { id: 'restaurant-seating-en', title: 'builtin' }] });
  await pick.openPick('script');
  assert.deepEqual(tabs(), ['일상', '여행', '스몰토크', '비즈니스', '내가 만든 것']);
  pick.selectCategory('mine');
  assert.deepEqual(cards().map((c) => c.dataset.scenario), ['user-1']);
});

test('a theme that is not ready is disabled and says so', async () => {
  routes();
  await pick.openPick('script');
  const shopping = cards().find((c) => c.dataset.theme === 'shopping');
  assert.equal(shopping.disabled, true);
  assert.match(shopping.children[1].textContent, /준비 중/);
});

test('in script mode choosing a theme picks a script at once, and a new theme picks again', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  pick.selectCategory('travel');
  await pick.selectTheme('hotel');
  assert.deepEqual(seen.picks.map((p) => p.theme_id), ['cafe-restaurant', 'hotel']);
});

test('in free mode choosing a theme does not pick until start', async () => {
  const seen = routes();
  await pick.openPick('free');
  await pick.selectTheme('cafe-restaurant');
  assert.equal(seen.picks.length, 0);
  await pick.startFromPick();
  assert.equal(seen.picks.length, 1);
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
  assert.deepEqual(seen.statuses, ['첫 대사 만드는 중...']);
});

test('script start uses the id picked when the theme was chosen and says the audio is being prepared', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.selectTheme('cafe-restaurant');
  await pick.startFromPick();
  assert.equal(seen.picks.length, 1);
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
  assert.deepEqual(seen.statuses, ['음성 준비 중...']);
  assert.equal($('start-status').hidden, true, 'the status clears once the session is open');
});

test('a pick still out when start is pressed shows 대본 고르는 중... first', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seen = routes({ pick: async () => { await held; return jsonResponse({ id: 'lib-x', title: 't', situation: 's' }); } });
  await pick.openPick('script');
  pick.selectTheme('cafe-restaurant');
  const started = pick.startFromPick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('start-status-text').textContent, '대본 고르는 중...');
  release();
  await started;
  assert.deepEqual(seen.statuses, ['음성 준비 중...']);
});

test('typed text makes a new script with two visible steps', async () => {
  const seen = routes();
  await pick.openPick('script');
  $('wish').value = '이사 업체에 견적 묻기';
  await pick.startFromPick();
  assert.equal(seen.generates[0].wish, '이사 업체에 견적 묻기');
  assert.deepEqual(seen.statuses, ['대본 만드는 중...', '음성 준비 중...']);
  assert.equal(seen.sessions[0].scenario_id, 'user-abc');
});

test('typed text in free mode says 상황 만드는 중... then 첫 대사 만드는 중...', async () => {
  const seen = routes();
  await pick.openPick('free');
  $('wish').value = '이사 견적';
  await pick.startFromPick();
  assert.deepEqual(seen.statuses, ['상황 만드는 중...', '첫 대사 만드는 중...']);
});

test('nothing chosen starts a random ready theme from the current tab', async () => {
  const seen = routes();
  await pick.openPick('script');
  await pick.startFromPick();
  assert.equal(seen.picks[0].theme_id, 'cafe-restaurant', 'shopping is not ready, so the only choice is cafe');
});

test('lesson hides the themes and starts with the topic', async () => {
  const seen = routes();
  await pick.openPick('lesson');
  assert.equal($('pick-themes').hidden, true);
  $('wish').value = '과거형';
  await pick.startFromPick();
  assert.deepEqual(seen.sessions[0], { language: 'en', mode: 'lesson', scenario_id: null, topic: '과거형' });
  assert.deepEqual(seen.statuses, ['첫 대사 만드는 중...']);
});

test('a failed generation clears the status and says what failed', async () => {
  routes({ generate: () => jsonResponse({ detail: 'bad' }, { ok: false, status: 422 }) });
  await pick.openPick('script');
  $('wish').value = 'x';
  await pick.startFromPick();
  assert.equal($('start-status').hidden, true);
  assert.match($('notice').textContent, /대본을 만들지 못했어요/);
  assert.equal($('btn-start').disabled, false);
});

test('a language switch while themes load does not paint the old language', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  stubFetch(async (url) => {
    if (url.startsWith('/api/themes?language=en')) { await held; return jsonResponse({ themes: THEMES }); }
    if (url.startsWith('/api/themes?language=ja')) return jsonResponse({ themes: [THEMES[2]] });
    return jsonResponse({ scenarios: [] });
  });
  const opening = pick.openPick('script');
  state.language = 'ja';
  const reopened = pick.openPick('script');
  release();
  await Promise.all([opening, reopened]);
  pick.selectCategory('travel');
  assert.deepEqual(cards().map((c) => c.dataset.theme), ['hotel']);
});
```

`static/js/home.test.js`: `startFromHome`을 쓰는 테스트는 `pick.test.js`로 옮길 가치가 있는 것(생성 대기 중 언어/모드 전환이 세션을 바꾸지 않음, 이어하기와 시작의 상호 가드)만 `startFromPick` 기준으로 옮겨 쓰고, `loadChips` 전용 테스트는 삭제한다. 이어하기 테스트에 추가: 요청 동안 `#resume-status`가 보이고 끝나면 숨는다. `reading.test.js`에 추가: 요청 중 뜻 칸 문구 `뜻 가져오는 중...`.

- [ ] **Step 2: RED 확인** — `node --test --test-force-exit static/js/pick.test.js`.

- [ ] **Step 3: 구현** — 위 마크업·동작 규칙·CSS대로 `pick.js`를 쓰고 `home.js`에서 옮긴다. `main.js`: `router.register('pick', 'pick')`, 모드 카드 → `openPick`, `#btn-home`, 두 언어 seg, `#category-tabs`·`#theme-grid` 클릭 위임, `#btn-start`·`#wish` Enter → `startFromPick`. `main.test.js`의 "index.html이 선언하지 않은 id" 검사가 통과해야 한다.

- [ ] **Step 4: GREEN** — node 전체, pytest `test_css_tokens.py`·`test_brand.py`.

- [ ] **Step 5: 부수기** — (1) 스크립트 모드 `selectTheme`의 즉시 pick 삭제: `picks a script at once` FAIL. (2) 시작 시 들고 있는 약속 대신 항상 새로 pick: `uses the id picked when the theme was chosen`의 `picks.length` FAIL. (3) `setStatus(STATUS.pickScript)` 삭제: `대본 고르는 중...` FAIL. (4) 응답 시점 language 비교 삭제: `language switch while themes load` FAIL. (5) `finally`의 `setStatus(null)` 삭제: `status clears` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: pick a mode, then a theme, and always see what is loading`

---

### Task 6: 실제 모델 표본 품질

**Files:**
- Create: `tests/test_library_quality.py`

- [ ] **Step 1: 테스트 작성**

```python
"""테마 라이브러리 생성 품질 -- 실제 모델. `-m engine`에서만 돈다.

실측(채울 것): 통과율, 첫 시도 통과율, 실패 이유 분포, 한 편 평균 시간.
문턱은 실측 아래로 둔다.
"""
import time

import pytest

from app import config, db, library
from scripts import build_library

pytestmark = pytest.mark.engine


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setattr(config, "DB_PATH", tmp_path_factory.mktemp("lib") / "t.db")
    db.init_db()
    themes = [library.get_theme("cafe-restaurant"), library.get_theme("meetings")]
    started = time.perf_counter()
    report = build_library.build(themes, ["en", "ja"], 3, log=print)
    report["seconds"] = time.perf_counter() - started
    yield report
    mp.undo()


def test_print_samples(run):
    print("\n", run)
    for language in ("en", "ja"):
        for theme in ("cafe-restaurant", "meetings"):
            for s in db.library_scenarios(language, theme, "script"):
                print(f"\n[{language}] {s['id']} {s['title']} ({s['situation']})")
                for line in s["lines"]:
                    print(f"   {line['speaker']}: {line['text']}")


def test_most_scripts_get_made(run):
    assert run["added"] >= 10, run      # 12 requested


def test_few_give_ups(run):
    assert run["gave_up"] <= 2, run


def test_every_theme_language_has_a_free_setup(run):
    for language in ("en", "ja"):
        for theme in ("cafe-restaurant", "meetings"):
            assert library.free_setup(language, theme), (language, theme)
```

- [ ] **Step 2: 실행** — `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/git/Monologue/venv/Scripts/python.exe -m pytest -m engine -s tests/test_library_quality.py` (포그라운드에서 끝까지 기다린다). 수치를 docstring에 적는다. 문턱을 못 넘으면 문턱을 바꾸지 말고 실패 이유 분포와 표본 전부를 보고한다.

- [ ] **Step 3: 커밋** — `test: library generation quality on the real model` + 실측 수치.

---

## 운영 (컨트롤러, 모든 태스크와 최종 리뷰 뒤)

1. main 머지 전에 워크트리를 8010으로 띄워(DB 복사본에 표본 라이브러리) 브라우저 확인: 홈 모드 카드 → 테마 화면, 탭, 카드, 스크립트 시작의 단계 문구, 직접 만들기, 수업, 이어하기 문구, 뜻 문구.
2. main 머지 → 8000 재시작.
3. 사용자에게 게임을 꺼 달라고 알린 뒤 본 DB(`C:/git/Monologue/monologue.db`, 백업 먼저)에 전체 생성: `venv/Scripts/python.exe scripts/build_library.py` (백그라운드, 약 4시간). 끝나면 보고서 수치(`added`, `retries`, `gave_up`, `reasons`, `minutes`)를 사용자에게 알린다.
