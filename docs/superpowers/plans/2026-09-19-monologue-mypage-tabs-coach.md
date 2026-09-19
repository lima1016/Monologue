# 마이페이지 탭 + 약점 코치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 마이페이지를 복습 | 약점 | 기록 탭으로 나누고, 약점 탭에서 "내가 뭐가 부족한지"를 실제 문장 근거로 구체적으로 보여준다(태그별 예시 + LLM 코치 한마디).

**Architecture:** 서버는 `/stats/mypage`의 태그마다 최근 예시 3개를 붙이고, 새 `GET /api/mypage/coach`가 최근 30일 틀린 문장을 모델에 읽혀 습관 2~3개를 만든다(하루 1회 `coach_notes` 캐시, 스키마 v8). 모델은 예시 문장을 **번호로만** 가리키고 서버가 그 번호의 실제 문장을 채워 넣어, 지어낸 예가 나올 수 없게 한다. 화면은 기존 마이페이지 패널 셋을 tabpanel로 감싸고 레벨을 머리줄 한 줄로 줄인다. 코치는 약점 탭을 처음 열 때만 부른다.

**Tech Stack:** FastAPI + SQLite(`app/`), Ollama qwen2.5:14b(`app/llm.py`), vanilla JS ES modules(`static/js/`), node:test + dom-shim, pytest.

**Spec:** `docs/superpowers/specs/2026-09-19-monologue-mypage-tabs-coach-design.md`

## Global Constraints

- 기준: 쉐도잉 브랜치 머지 후 main(스키마 v7). 이 계획이 v8을 더한다. 워크트리 `C:/git/Monologue-wt/mypage-tabs`.
- 사용자 원칙: 오래 걸리는 동작은 화면에 알린다(코치 생성 중 문구). 탭 전환·로딩·버튼 글자 변경 때 크기가 튀지 않는다 — 자리 고정 + 짧은 opacity 페이드, **transform 금지**(fixed/sticky 자식이 깨진다).
- 한국어 설명에 중국어·다른 문자가 새면 보여주지 않는다: 기존 `api._is_korean_meaning` 재사용.
- `내 말` 줄에 취소선 금지(쉐도잉 리뷰에서 `.fix-row .said` 상속으로 한 번 났다). 새 클래스는 `.fix-row`/`.said` 이름을 쓰지 않는다.
- dom-shim에는 selector 엔진과 `closest()`가 없다(`closest()`는 항상 null). 테스트는 내보낸 함수(`selectTab`, `toggleTagItem`, `onTabKey`)를 직접 부른다.
- pytest: `cd <worktree> && PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/git/Monologue/venv/Scripts/python.exe -m pytest -m "not engine" -q -p no:cacheprovider` (워크트리에선 `test_kokoro_model_files_are_present` 1개 실패가 정상). node: `node --test --test-force-exit static/js/*.test.js`.
- 대본 생성(`scripts/build_library.py`)이 돌고 있으면 engine 테스트·전체 pytest가 끝나지 않는다 — `-m "not engine"`만.
- 새 테스트마다 구현을 일부러 부숴서 빨개지는지 확인하고 보고서에 적는다. 브라우저로 보지 않았으면 봤다고 쓰지 않는다.
- 커밋 메시지: 소문자 `feat:`/`fix:` 문장, 끝줄 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. 커밋 전 `git branch --show-current`가 `mypage-tabs`인지 확인.

---

### Task 1: 서버 — 태그 예시, 코치 입력, v8 캐시 테이블

**Files:**
- Modify: `app/db.py` (MIGRATIONS 끝에 v8, `wrong_tag_counts`에 예시, 새 함수 `coach_inputs`, `wrong_count_since`, `get_coach`, `save_coach`)
- Test: `tests/test_db.py`, `tests/test_api_mypage.py`

**Interfaces:**
- Produces:
  - `db.wrong_tag_counts(language) -> list[{"tag": str, "n": int, "examples": list[{"text": str, "fixed": str|None, "correction": str|None}]}]` — 예시는 그 태그의 최근 3개(created_at DESC, id DESC).
  - `db.coach_inputs(language, since: date, limit=30) -> list[{"text", "fixed", "tag", "correction"}]` — 최근 것부터. 조건: 그 언어, `speaker='user'`, `ok=0`, `fixed`가 NULL/빈 문자열 아님, `s.mode <> 'script'`, 로컬 날짜 ≥ since.
  - `db.wrong_count_since(language, since: date) -> int` — 같은 조건의 개수(limit 없음).
  - `db.get_coach(language) -> {"day": str, "items": list[dict]} | None`
  - `db.save_coach(language, day: str, items: list[dict]) -> None` — 언어당 한 행, 덮어쓰기.

- [ ] **Step 1: 실패하는 테스트**

`tests/test_db.py` 끝에(파일 상단 fixture 패턴을 따른다 — `config.DB_PATH`를 tmp_path로 monkeypatch 후 `db.init_db()`):

```python
def test_v8_adds_coach_notes_and_round_trips(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    assert db.schema_version() == 8
    assert db.get_coach("en") is None
    db.save_coach("en", "2026-09-19", [{"habit": "a", "tip": "b", "said": "x", "fixed": "y", "tag": "시제"}])
    db.save_coach("en", "2026-09-20", [{"habit": "c", "tip": "d", "said": "x", "fixed": "y", "tag": None}])
    assert db.get_coach("en") == {"day": "2026-09-20",
                                  "items": [{"habit": "c", "tip": "d", "said": "x", "fixed": "y", "tag": None}]}
    assert db.get_coach("ja") is None


def test_v7_database_migrates_to_v8_keeping_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(sid, "user", "I go", correction="c", ok=0, fixed="I went.", tag="시제")
    with db.connect() as conn:
        conn.execute("DROP TABLE coach_notes")
        conn.execute("PRAGMA user_version = 7")
    db.init_db()
    assert db.schema_version() == 8
    assert db.get_coach("en") is None
    assert db.wrong_tag_counts("en")[0]["n"] == 1
```

`tests/test_api_mypage.py` 끝에(`_finished` 헬퍼 사용):

```python
def test_tags_carry_their_three_newest_examples(client):
    _finished(turns=[("I go 1", 0, "I went 1.", "시제"), ("I go 2", 0, "I went 2.", "시제"),
                     ("I go 3", 0, "I went 3.", "시제"), ("I go 4", 0, "I went 4.", "시제"),
                     ("She have", 0, "She has.", "단복수")])
    tags = client.get("/api/stats/mypage?language=en").json()["tags"]
    tense = next(t for t in tags if t["tag"] == "시제")
    assert tense["n"] == 4
    assert [e["text"] for e in tense["examples"]] == ["I go 4", "I go 3", "I go 2"]
    assert tense["examples"][0] == {"text": "I go 4", "fixed": "I went 4.", "correction": "설명"}


def test_coach_inputs_skip_script_graded_ok_and_old_rows(client, monkeypatch):
    _finished(turns=[("I go", 0, "I went.", "시제"), ("fine", 1, None, "없음"), ("no fix", 0, None, "어휘")])
    _finished(mode="script", scenario_id="standup-meeting-en", turns=[("read", 0, "x.", "어순")])
    rows = db.coach_inputs("en", date(2026, 8, 20))
    assert [r["text"] for r in rows] == ["I go"]
    assert rows[0] == {"text": "I go", "fixed": "I went.", "tag": "시제", "correction": "설명"}
    assert db.wrong_count_since("en", date(2026, 8, 20)) == 1
    assert db.coach_inputs("en", date(2099, 1, 1)) == []
```

- [ ] **Step 2: 실패 확인** — `...pytest tests/test_db.py tests/test_api_mypage.py -q -p no:cacheprovider` → `schema_version() == 7`, `KeyError: 'examples'`, `AttributeError: coach_inputs` 등으로 FAIL.

- [ ] **Step 3: 구현** — `app/db.py`

MIGRATIONS 끝(v7 항목 뒤)에:

```python
    # v7 -> v8: the weak-spot coach's daily note (docs/superpowers/specs/
    # 2026-09-19-monologue-mypage-tabs-coach-design.md, "서버"). One row per
    # language, overwritten each day it is made; nothing here is the learner's
    # own data -- it is rebuilt from messages whenever it is missing.
    ["""
    CREATE TABLE IF NOT EXISTS coach_notes (
        language   TEXT PRIMARY KEY,
        day        TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    """],
```

`wrong_tag_counts`를 교체:

```python
_TAG_EXAMPLES = 3


def wrong_tag_counts(language) -> list[dict]:
    """Every wrong tag with its count and its newest few sentences: a count
    alone says *that* something goes wrong, the sentences say *what*."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT m.tag, COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user' AND m.ok = 0"
            "   AND m.tag IS NOT NULL AND m.tag <> '없음'"
            " GROUP BY m.tag ORDER BY n DESC, m.tag", (language,)).fetchall()
        out = []
        for r in rows:
            examples = conn.execute(
                "SELECT m.text, m.fixed, m.correction FROM messages m JOIN sessions s ON s.id = m.session_id"
                " WHERE s.language = ? AND m.speaker = 'user' AND m.ok = 0 AND m.tag = ?"
                " ORDER BY m.created_at DESC, m.id DESC LIMIT ?",
                (language, r["tag"], _TAG_EXAMPLES)).fetchall()
            out.append({"tag": r["tag"], "n": r["n"], "examples": [dict(e) for e in examples]})
    return out
```

그 아래에 코치 함수들. 날짜 경계는 `accuracy_since`와 같은 방식(UTC 문자열 선필터 + localtime 날짜 비교):

```python
def _local_cutoff(since) -> str:
    """UTC ISO string one day before local midnight of `since` -- a cheap
    string prefilter; the localtime date compare still decides membership
    (same reasoning as accuracy_since's docstring)."""
    local_tz = datetime.now().astimezone().tzinfo
    cutoff_local = datetime.combine(since - timedelta(days=1), datetime.min.time(), tzinfo=local_tz)
    return cutoff_local.astimezone(timezone.utc).isoformat(timespec="seconds")


_COACH_WHERE = (
    " FROM messages m JOIN sessions s ON s.id = m.session_id"
    " WHERE s.language = ? AND s.mode <> 'script' AND m.speaker = 'user' AND m.ok = 0"
    "   AND m.fixed IS NOT NULL AND m.fixed <> ''"
    "   AND m.created_at >= ? AND substr(datetime(m.created_at, 'localtime'), 1, 10) >= ?"
)


def coach_inputs(language, since, limit=30) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT m.text, m.fixed, m.tag, m.correction" + _COACH_WHERE +
            " ORDER BY m.created_at DESC, m.id DESC LIMIT ?",
            (language, _local_cutoff(since), since.isoformat(), limit)).fetchall()
    return [dict(r) for r in rows]


def wrong_count_since(language, since) -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*)" + _COACH_WHERE,
                            (language, _local_cutoff(since), since.isoformat())).fetchone()[0]


def get_coach(language) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT day, body FROM coach_notes WHERE language = ?", (language,)).fetchone()
    return {"day": row["day"], "items": json.loads(row["body"])} if row else None


def save_coach(language, day, items) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO coach_notes (language, day, body, created_at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(language) DO UPDATE SET day = excluded.day, body = excluded.body,"
            " created_at = excluded.created_at",
            (language, day, json.dumps(items, ensure_ascii=False), _now()))
```

`accuracy_since`도 `_local_cutoff(since)`를 쓰도록 바꿔 중복을 없앤다(동작 불변 — 기존 테스트가 지킨다). `json`, `timezone` import가 이미 있는지 확인하고 없으면 추가.

- [ ] **Step 4: 통과 확인** — 같은 명령 PASS. 그 다음 전체 `-m "not engine"`. 기존 테스트 중 `tags == [...]`를 정확히 비교하는 것이 `examples` 때문에 깨지면, 그 테스트의 기대값에 examples를 넣어 고친다(태그·개수 기대는 그대로).
- [ ] **Step 5: 부숴 보기** — (a) examples 쿼리의 `LIMIT ?`를 빼면 `test_tags_carry...` 빨강, (b) `_COACH_WHERE`에서 `s.mode <> 'script'`를 빼면 `test_coach_inputs...` 빨강. 되돌린다.
- [ ] **Step 6: 커밋** — `feat: my page's weak spots carry their newest sentences, and a daily coach note has a table (v8)`

---

### Task 2: 서버 — 코치 한마디 생성 엔드포인트

**Files:**
- Modify: `app/prompts.py` (COACH_SYSTEM, COACH_EXAMPLE, `coach_schema`, `build_coach_messages`)
- Modify: `app/api.py` (`_valid_coach_items`, `_generate_coach`, `GET /mypage/coach`)
- Create: `tests/test_api_coach.py`
- Create: `tests/test_coach_quality.py` (engine 마커)

**Interfaces:**
- Consumes: Task 1의 `db.coach_inputs`, `db.wrong_count_since`, `db.get_coach`, `db.save_coach`; 기존 `api._is_korean_meaning(text, source)`, `api._today()`, `llm.chat_json`.
- Produces: `GET /api/mypage/coach?language=en|ja` →
  - `{"status": "too_few", "count": int, "need": 5}` (최근 30일 틀린 문장 < 5, 모델 안 부름)
  - `{"status": "ready", "day": "YYYY-MM-DD", "count": int, "items": [{"habit": str, "tip": str, "said": str, "fixed": str, "tag": str|None}]}` (1~3개)
  - 503 `{"detail": "지금은 코치 한마디를 만들 수 없어요"}`

- [ ] **Step 1: 프롬프트** — `app/prompts.py` 끝에:

```python
# Editing this string? Run `pytest tests/test_coach_quality.py -m engine`
# against the real model afterward, and look at the table it prints.
COACH_SYSTEM = """당신은 한국인 학생의 {lang} 말하기를 지도하는 한국어 원어민 코치입니다.
설명은 한국어로만 씁니다.

아래는 학생이 최근 말하기 연습에서 틀린 문장들입니다. 번호마다 학생이 한 말, 고친 문장,
교사의 설명, 분류가 있습니다. 분류 이름은 자주 틀리니 믿지 말고, 학생이 한 말과 고친 문장을
직접 비교해서 여러 문장에 되풀이되는 습관을 찾으세요.

습관을 2~3개 주세요. 가장 자주 되풀이되는 것부터.
- habit: 학생이 실제로 하는 일을 구체적으로 한 문장(40자 이내). "문법이 약해요"처럼 막연하면 안 됩니다
- tip: 다음에 말할 때 바로 해 볼 수 있는 행동 한 문장(40자 이내). {lang} 표현을 넣을 때는 따옴표로 감쌉니다
- example_no: 이 습관이 가장 잘 보이는 문장의 번호 하나

마크다운과 이모지는 쓰지 않습니다."""

COACH_EXAMPLE_INPUT = [
    {"text": "Yes water please And this is my first time Can you recommend", "fixed": "Yes, water please. This is my first time here. Can you recommend something?", "tag": "어순", "correction": "문장을 나눠야 합니다."},
    {"text": "I'd like to sit the window", "fixed": "I'd like to sit by the window.", "tag": "어순", "correction": "by the를 넣어야 합니다."},
    {"text": "I go there yesterday", "fixed": "I went there yesterday.", "tag": "시제", "correction": "과거형을 써야 합니다."},
    {"text": "Okay I will take At the bar and let me know if The seat Available", "fixed": "Okay, I'll take a seat at the bar. Let me know if the window seat is available.", "tag": "어순", "correction": "문장을 나누고 is를 넣어야 합니다."},
    {"text": "I arrive here last week", "fixed": "I arrived here last week.", "tag": "시제", "correction": "과거형을 써야 합니다."},
    {"text": "Can I get a seat the bar", "fixed": "Can I get a seat at the bar?", "tag": "어순", "correction": "at을 넣어야 합니다."},
]
COACH_EXAMPLE_OUTPUT = {"items": [
    {"habit": "여러 말을 끊지 않고 한 문장처럼 길게 이어 말해요",
     "tip": "한 가지를 말하면 멈추고 숨을 한 번 쉬고 다음 문장을 말해요", "example_no": 1},
    {"habit": "장소 앞의 전치사(by, at)를 빠뜨려요",
     "tip": "자리·장소를 말할 때 \"by the\", \"at the\"를 먼저 붙여 말해요", "example_no": 2},
    {"habit": "지난 일을 말할 때 동사를 현재형으로 둬요",
     "tip": "yesterday, last week가 나오면 동사를 과거형으로 바꿔요", "example_no": 3},
]}

_COACH_CORRECTION_CHARS = 80


def _coach_input(rows) -> str:
    lines = []
    for i, r in enumerate(rows, 1):
        why = (r.get("correction") or "").replace("\n", " ")[:_COACH_CORRECTION_CHARS]
        lines.append(f"{i}. 학생: {r['text']} / 고친 문장: {r['fixed']} / 설명: {why} / 분류: {r.get('tag') or '-'}")
    return "틀린 문장들:\n" + "\n".join(lines) + "\n\n되풀이되는 습관을 2~3개 주세요."


def coach_schema() -> dict:
    return {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {"habit": {"type": "string"}, "tip": {"type": "string"},
                       "example_no": {"type": "integer"}},
        "required": ["habit", "tip", "example_no"]}}},
        "required": ["items"]}


def build_coach_messages(language, rows) -> list[dict]:
    """Few-shot, not rules alone: this file's feedback prompt learned that
    this model does not follow rules it has not been shown. The example is in
    English for both languages -- it teaches the shape (habits, not tags), and
    the query turn carries the learner's own language."""
    system = COACH_SYSTEM.format(lang=KOREAN_LANGUAGE_NAMES[language])
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": _coach_input(COACH_EXAMPLE_INPUT)},
        {"role": "assistant", "content": json.dumps(COACH_EXAMPLE_OUTPUT, ensure_ascii=False)},
        {"role": "user", "content": _coach_input(rows)},
    ]
```

- [ ] **Step 2: 실패하는 테스트** — `tests/test_api_coach.py`:

```python
"""코치 한마디 -- 서버 쪽. 모델은 전부 목(mock)이다."""
import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import api, config, db, llm, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    monkeypatch.setattr(api, "_today", lambda: date.today())
    return TestClient(app)


def _wrong(n, language="en"):
    sid = db.create_session(language, "free", scenario_id="airport-checkin-en")
    for i in range(n):
        db.add_message(sid, "user", f"I go {i}", correction="과거형", ok=0, fixed=f"I went {i}.", tag="시제")
        db.add_message(sid, "bot", "reply")


def _model(monkeypatch, *answers):
    calls = []
    def fake(messages, schema, temperature=0.3):
        calls.append(messages)
        answer = answers[min(len(calls), len(answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(llm, "chat_json", fake)
    return calls


GOOD = {"items": [
    {"habit": "지난 일을 현재형으로 말해요", "tip": "yesterday가 나오면 과거형으로 바꿔요", "example_no": 1},
    {"habit": "문장을 끊지 않고 이어 말해요", "tip": "한 문장 말하고 숨을 쉬어요", "example_no": 2},
]}


def test_too_few_does_not_call_the_model(client, monkeypatch):
    _wrong(4)
    calls = _model(monkeypatch, GOOD)
    body = client.get("/api/mypage/coach?language=en").json()
    assert body == {"status": "too_few", "count": 4, "need": 5}
    assert calls == []


def test_ready_fills_the_example_from_the_real_sentence(client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, GOOD)
    body = client.get("/api/mypage/coach?language=en").json()
    assert body["status"] == "ready" and body["count"] == 6 and body["day"] == date.today().isoformat()
    # rows come newest first: example_no 1 is the newest sentence
    assert body["items"][0] == {"habit": "지난 일을 현재형으로 말해요", "tip": "yesterday가 나오면 과거형으로 바꿔요",
                                "said": "I go 5", "fixed": "I went 5.", "tag": "시제"}
    assert body["items"][1]["said"] == "I go 4"


def test_same_day_is_served_from_the_cache(client, monkeypatch):
    _wrong(6)
    calls = _model(monkeypatch, GOOD)
    first = client.get("/api/mypage/coach?language=en").json()
    second = client.get("/api/mypage/coach?language=en").json()
    assert first == second and len(calls) == 1


def test_an_older_day_is_made_again(client, monkeypatch):
    _wrong(6)
    db.save_coach("en", "2000-01-01", [{"habit": "옛날", "tip": "옛날", "said": "a", "fixed": "b", "tag": None}])
    calls = _model(monkeypatch, GOOD)
    body = client.get("/api/mypage/coach?language=en").json()
    assert len(calls) == 1 and body["items"][0]["habit"] != "옛날"


@pytest.mark.parametrize("bad", [
    {"habit": "过去的事情用现在时", "tip": "改成过去式", "example_no": 1},        # Chinese
    {"habit": "지난 일을 현재형으로 말해요", "tip": "과거형으로", "example_no": 99},  # no such sentence
    {"habit": "지난 일을 현재형으로 말해요", "tip": "과거형으로", "example_no": 0},
    {"habit": "", "tip": "과거형으로", "example_no": 1},
    {"habit": "Use past tense", "tip": "Change the verb", "example_no": 1},         # English, no Hangul
])
def test_a_bad_item_is_dropped(bad, client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, {"items": [bad, GOOD["items"][1]]}, {"items": [bad, GOOD["items"][1]]})
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert [i["habit"] for i in items] == ["문장을 끊지 않고 이어 말해요"]


def test_fewer_than_two_asks_once_more(client, monkeypatch):
    _wrong(6)
    calls = _model(monkeypatch, {"items": [GOOD["items"][0]]}, GOOD)
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert len(calls) == 2 and len(items) == 2


def test_the_same_habit_twice_is_kept_once(client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, {"items": [GOOD["items"][0], GOOD["items"][0], GOOD["items"][1]]})
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert [i["habit"] for i in items] == ["지난 일을 현재형으로 말해요", "문장을 끊지 않고 이어 말해요"]


def test_nothing_usable_is_503_and_not_cached(client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, {"items": []}, {"items": []})
    r = client.get("/api/mypage/coach?language=en")
    assert r.status_code == 503 and r.json()["detail"] == "지금은 코치 한마디를 만들 수 없어요"
    assert db.get_coach("en") is None


def test_a_dead_model_is_503_after_one_call(client, monkeypatch):
    _wrong(6)
    calls = _model(monkeypatch, llm.LLMError("down"))
    assert client.get("/api/mypage/coach?language=en").status_code == 503
    assert len(calls) == 1


def test_languages_are_kept_apart(client, monkeypatch):
    _wrong(6, "en")
    _wrong(2, "ja")
    _model(monkeypatch, GOOD)
    assert client.get("/api/mypage/coach?language=ja").json()["status"] == "too_few"
    assert client.get("/api/mypage/coach?language=en").json()["status"] == "ready"
```

`llm.LLMError`가 `app/llm.py`에 있는지 확인(있다 — `chat`이 올린다).

- [ ] **Step 3: 실패 확인** — `...pytest tests/test_api_coach.py -q -p no:cacheprovider` → 404로 FAIL.

- [ ] **Step 4: 구현** — `app/api.py`, `suggest_replies` 라우트 아래 또는 `/stats/mypage` 라우트 근처에:

```python
COACH_UNAVAILABLE = "지금은 코치 한마디를 만들 수 없어요"
_COACH_DAYS = 30
_COACH_MIN_WRONG = 5
_COACH_MAX_ITEMS = 3
_coach_locks = {"en": threading.Lock(), "ja": threading.Lock()}


class _NoCoach(Exception):
    pass


def _valid_coach_items(raw, rows, kept: list[dict]) -> list[dict]:
    """Items that can be shown, appended to `kept`. The model names its
    example by number only; the sentence shown is the learner's own row, so
    an invented example cannot reach the screen. A habit or tip that is not
    Korean (a Chinese leak, an English answer) is dropped -- quoted target-
    language phrases inside a tip are allowed, as in the ▸ 뜻 check."""
    out = list(kept)
    source = "\n".join(f"{r['text']} {r['fixed']}" for r in rows)
    for item in raw if isinstance(raw, list) else []:
        if len(out) >= _COACH_MAX_ITEMS:
            break
        if not isinstance(item, dict):
            continue
        habit, tip, no = item.get("habit"), item.get("tip"), item.get("example_no")
        if not (isinstance(habit, str) and isinstance(tip, str) and isinstance(no, int)):
            continue
        habit, tip = _first_line(habit).strip(), _first_line(tip).strip()
        if not habit or not tip or not 1 <= no <= len(rows):
            continue
        if not (_is_korean_meaning(habit, source=source) and _is_korean_meaning(tip, source=source)):
            continue
        if any(o["habit"] == habit for o in out):
            continue
        row = rows[no - 1]
        out.append({"habit": habit, "tip": tip, "said": row["text"], "fixed": row["fixed"], "tag": row.get("tag")})
    return out


def _generate_coach(language, rows) -> list[dict]:
    """Two or three habits, or _NoCoach. Fewer than two survivors earns one
    more sample at the same temperature; a dead model does not (same rule as
    _generate_suggestions)."""
    messages = prompts.build_coach_messages(language, rows)
    kept: list[dict] = []
    for _ in range(2):
        try:
            result = llm.chat_json(messages, prompts.coach_schema(), temperature=0.3)
        except Exception as exc:
            if kept:
                break
            raise _NoCoach from exc
        kept = _valid_coach_items(result.get("items") if isinstance(result, dict) else None, rows, kept)
        if len(kept) >= 2:
            break
    if not kept:
        raise _NoCoach
    return kept


@router.get("/mypage/coach")
def mypage_coach(language: Language):
    """코치 한마디: habits read off the learner's own wrong sentences, made
    once a day per language. The lock keeps two opens of the weak tab (or two
    tabs) from making the same note twice; the second waits and reads the
    first's."""
    today = _today()
    since = today - timedelta(days=_COACH_DAYS - 1)
    count = db.wrong_count_since(language, since)
    if count < _COACH_MIN_WRONG:
        return {"status": "too_few", "count": count, "need": _COACH_MIN_WRONG}
    with _coach_locks[language]:
        cached = db.get_coach(language)
        if cached and cached["day"] == today.isoformat():
            return {"status": "ready", "day": cached["day"], "count": count, "items": cached["items"]}
        rows = db.coach_inputs(language, since)
        try:
            items = _generate_coach(language, rows)
        except _NoCoach:
            raise HTTPException(503, COACH_UNAVAILABLE)
        db.save_coach(language, today.isoformat(), items)
    return {"status": "ready", "day": today.isoformat(), "count": count, "items": items}
```

`threading` import가 없으면 추가. `_first_line`은 api.py에 이미 있다(`_reply_meaning`이 쓴다). `Language` 타입은 기존 라우트와 같은 것.

- [ ] **Step 5: 통과 확인** — `tests/test_api_coach.py` PASS, 그다음 전체 `-m "not engine"`.

- [ ] **Step 6: 부숴 보기** — (a) `_valid_coach_items`에서 `1 <= no <= len(rows)` 검사를 빼면 `example_no 99` 케이스가 IndexError로 빨강, (b) `_is_korean_meaning` 검사를 빼면 Chinese/English 케이스 빨강, (c) 캐시 날짜 비교를 빼면(`if cached:`) `test_an_older_day...` 빨강. 되돌린다.

- [ ] **Step 7: 실제 모델 품질 테스트** — `tests/test_coach_quality.py`:

```python
"""코치 한마디 -- 실제 모델. `pytest tests/test_coach_quality.py -m engine -s`
표를 보고 사람이 판단한다: 습관이 구체적인가, 실제 문장과 맞는가, 한국어만인가."""
import pytest

from app import api, prompts, llm

pytestmark = pytest.mark.engine

EN_ROWS = [
    {"text": "Yes water please And this is my first time to visit here Can you recommend Dishes", "fixed": "Yes, water please. And this is my first time to visit here. Can you recommend some dishes?", "tag": "어순", "correction": "문장을 구분해야 합니다."},
    {"text": "I'd like to sit the window. Sit.", "fixed": "I'd like to sit by the window.", "tag": "어순", "correction": "by the를 추가해야 합니다."},
    {"text": "Oh thank you I want to try grilled salmon And can I get Orange juice please", "fixed": "Oh, thank you. I want to try the grilled salmon. And can I get orange juice, please?", "tag": "어순", "correction": "문장 순서와 구분."},
    {"text": "I'd like to see oil seed", "fixed": "I'd like to see the oil seeds.", "tag": "관사", "correction": "the와 복수형."},
    {"text": "Okay I will take a At the bar for now and let me know if The window seat Available", "fixed": "Okay, I will take a seat at the bar for now and let me know if the window seat is available.", "tag": "어순", "correction": "seat, is가 빠짐."},
    {"text": "Yesterday I go to the office early", "fixed": "Yesterday I went to the office early.", "tag": "시제", "correction": "과거형."},
    {"text": "Last week I meet my manager", "fixed": "Last week I met my manager.", "tag": "시제", "correction": "과거형."},
]
JA_ROWS = [
    {"text": "昨日会社に行きます", "fixed": "昨日会社に行きました。", "tag": "시제", "correction": "과거형으로."},
    {"text": "先週友達と会います", "fixed": "先週友達と会いました。", "tag": "시제", "correction": "과거형으로."},
    {"text": "コーヒーをください、あと水もください、それと窓の席がいいです", "fixed": "コーヒーをください。水もお願いします。窓側の席がいいです。", "tag": "어순", "correction": "문장을 나눠야 합니다."},
    {"text": "駅は行きたいです", "fixed": "駅に行きたいです。", "tag": "조사", "correction": "に를 써야 합니다."},
    {"text": "学校は行きます", "fixed": "学校に行きます。", "tag": "조사", "correction": "に를 써야 합니다."},
]


@pytest.mark.parametrize("language,rows", [("en", EN_ROWS), ("ja", JA_ROWS)])
def test_coach_on_the_real_model(language, rows):
    for run in range(3):
        items = api._generate_coach(language, rows)
        print(f"\n[{language} run {run + 1}]")
        for i in items:
            print(f"  - {i['habit']} | {i['tip']} | {i['said']} -> {i['fixed']}")
        assert 1 <= len(items) <= 3
        for i in items:
            assert api._is_korean_meaning(i["habit"]) and i["said"] in [r["text"] for r in rows]
```

실행은 컨트롤러가 대본 생성을 멈춘 뒤 한다(서브에이전트는 파일만 만들고 `-m "not engine"`에서 제외되는지만 확인).

- [ ] **Step 8: 커밋** — `feat: 코치 한마디 -- habits read off the learner's own wrong sentences, once a day, examples by number only`

---

### Task 3: 화면 — 탭 세 개와 머리줄 레벨

**Files:**
- Modify: `static/index.html` (#mypage 구조)
- Modify: `static/css/components.css` (마이페이지 절)
- Modify: `static/js/mypage.js` (`selectTab`, `onTabKey`, `openMypage({ tab })`, `renderLevel`, 복습 개수를 탭 이름에)
- Modify: `static/js/main.js` (탭 클릭·키 연결, 홈 복습 카드 → 복습 탭)
- Test: `static/js/mypage.test.js`, `tests/test_mypage_css.py`

**Interfaces:**
- Consumes: 기존 `openMypage`, `renderLevel`, `paintReviewHead`, `reviewsLeft`.
- Produces:
  - `export function selectTab(name, { focus = false } = {})` — name ∈ `'review'|'weak'|'history'`. 탭 버튼 `aria-selected`/`tabindex`, 패널 `hidden`, localStorage `mypage-tab` 저장(try/catch). `'weak'`로 바뀔 때 `onWeakShown()` 호출(Task 4가 채운다; 이 태스크에선 빈 함수로 둔다).
  - `export function onTabKey(e)` — ArrowLeft/ArrowRight/Home/End로 이동·선택·포커스.
  - `export async function openMypage({ tab } = {})` — `tab`이 주어지면 그 탭, 아니면 저장된 탭(없거나 읽기 실패면 `'review'`).
  - 탭 버튼 id `tab-review`, `tab-weak`, `tab-history`; 복습 개수 `#tab-review-n`.

- [ ] **Step 1: 마크업** — `static/index.html`의 `<section id="mypage">` 안을 다음으로 바꾼다(`#review-section`, `#weak-section`, `#history-section` 내부는 그대로 두고 `panel` 클래스와 새 속성만 더한다; `#level-card`는 머리 안으로):

```html
  <section id="mypage" hidden>
    <div class="mypage-head">
      <button id="btn-mypage-home" class="ghost" type="button">← 홈</button>
      <h2>마이페이지</h2>
      <span class="seg" id="mypage-language-seg">
        <button type="button" data-language="en">English</button>
        <button type="button" data-language="ja">日本語</button>
      </span>
      <div id="level-card" class="level-strip">
        <div id="level-body"></div>
      </div>
    </div>
    <div id="mypage-tabs" class="mypage-tabs" role="tablist" aria-label="마이페이지">
      <button type="button" role="tab" id="tab-review" data-tab="review" aria-controls="review-section" aria-selected="true" tabindex="0">복습<span id="tab-review-n" class="tab-n"></span></button>
      <button type="button" role="tab" id="tab-weak" data-tab="weak" aria-controls="weak-section" aria-selected="false" tabindex="-1">약점</button>
      <button type="button" role="tab" id="tab-history" data-tab="history" aria-controls="history-section" aria-selected="false" tabindex="-1">기록</button>
    </div>
    <div class="mypage-panels">
      <div id="review-section" class="panel" role="tabpanel" aria-labelledby="tab-review">
        ...기존 내용 그대로...
      </div>
      <div id="weak-section" class="panel" role="tabpanel" aria-labelledby="tab-weak" hidden>
        ...기존 내용 그대로...
      </div>
      <div id="history-section" class="panel" role="tabpanel" aria-labelledby="tab-history" hidden>
        ...기존 내용 그대로...
      </div>
    </div>
  </section>
```

dom-shim의 `resetDom()`이 index.html을 읽어 요소를 만드는지, 아니면 id 목록을 따로 가지는지 확인하고, 새 id(`mypage-tabs`, `tab-review`, `tab-weak`, `tab-history`, `tab-review-n`)가 테스트에서 `$()`로 잡히게 맞춘다.

- [ ] **Step 2: CSS** — `components.css` 마이페이지 절(`#mypage {`… 근처):

```css
/* The level is one line in the head, not a card: it is a fact to glance at,
   and the room it took is what the tabs below need. */
.level-strip { flex-basis: 100%; }
:where(#level-body) > p { margin: 0; }
.level-line { font-size: var(--text-sm); color: var(--text-dim); }
.level-line b { color: var(--text); font-weight: 700; }
.level-line.skeleton { width: 40%; }

.mypage-tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--line); }
.mypage-tabs [role="tab"] { background: none; border: 0; border-bottom: 2px solid transparent;
  margin-bottom: -1px; padding: var(--space-2) var(--space-3); font-size: var(--text-md);
  color: var(--text-dim); font-weight: 600; border-radius: 0; }
.mypage-tabs [role="tab"][aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.mypage-tabs [role="tab"]:focus-visible { outline-offset: -2px; }
/* The count sits in a reserved box, so 복습 3 -> 복습 (none left) does not
   move 약점 and 기록 sideways. */
.tab-n { display: inline-block; min-width: 1.5em; margin-left: var(--space-1);
  font-size: var(--text-sm); color: var(--accent); text-align: left; }

/* One height for every tab: switching to a short one must not pull the page
   up under the pointer. Opacity only (no transform -- R-rule). */
.mypage-panels { min-height: min(70vh, 34rem); }
.mypage-panels > [role="tabpanel"] { animation: tab-in var(--dur-fast) ease; }
@keyframes tab-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .mypage-panels > [role="tabpanel"] { animation: none; } }
```

토큰 이름(`--text-md`, `--dur-fast`, `--accent` 등)은 `tokens.css`에 실제로 있는 것만 쓴다 — 없으면 가장 가까운 기존 토큰으로 바꾼다(`tests/test_css_tokens.py`가 잡는다). 기존 `.level-value`/`.level-note` 규칙과 `#level-card`의 `:where(...)` 트랜지션 목록은 `.level-line` 기준으로 정리한다.

`tests/test_mypage_css.py`에(파일의 기존 읽기 헬퍼 패턴 사용):

```python
def test_tab_panels_share_one_height_and_fade_without_transform():
    css = read_css()
    assert re.search(r"\.mypage-panels\s*\{[^}]*min-height", css)
    block = re.search(r"@keyframes tab-in\s*\{(.*?)\}\s*\}", css, re.S).group(1)
    assert "opacity" in block and "transform" not in block


def test_tab_count_reserves_its_width():
    assert re.search(r"\.tab-n\s*\{[^}]*min-width", read_css())
```

- [ ] **Step 3: 실패하는 node 테스트** — `static/js/mypage.test.js`에. localStorage 스텁:

```js
function stubStorage(initial = {}) {
  const data = { ...initial };
  globalThis.localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
  return data;
}

test('my page opens on the review tab by default and on the remembered tab after', async () => {
  routes();
  const store = stubStorage();
  await mypage.openMypage();
  assert.equal($('tab-review').getAttribute('aria-selected'), 'true');
  assert.equal($('weak-section').hidden, true);
  mypage.selectTab('history');
  assert.equal(store['mypage-tab'], 'history');
  assert.equal($('history-section').hidden, false);
  assert.equal($('review-section').hidden, true);
  assert.equal($('tab-history').getAttribute('tabindex'), '0');
  assert.equal($('tab-review').getAttribute('tabindex'), '-1');
  await mypage.openMypage();
  assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
});

test('an explicit tab wins over the remembered one (home review card)', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage({ tab: 'review' });
  assert.equal($('review-section').hidden, false);
});

test('a storage that throws still opens on review', async () => {
  routes();
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  await mypage.openMypage();
  assert.equal($('review-section').hidden, false);
  mypage.selectTab('weak');            // must not throw
  assert.equal($('weak-section').hidden, false);
});

test('an unknown remembered tab falls back to review', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'nonsense' });
  await mypage.openMypage();
  assert.equal($('review-section').hidden, false);
});

test('arrow keys move between tabs and wrap', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  const key = (k, from) => {
    let prevented = false;
    mypage.onTabKey({ key: k, target: $(from), preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(key('ArrowRight', 'tab-review'), true);
  assert.equal($('tab-weak').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, $('tab-weak'));
  key('ArrowLeft', 'tab-weak');
  key('ArrowLeft', 'tab-review');
  assert.equal($('tab-history').getAttribute('aria-selected'), 'true');
  key('Home', 'tab-history');
  assert.equal($('tab-review').getAttribute('aria-selected'), 'true');
  assert.equal(key('a', 'tab-review'), false);
});

test('the review tab carries the count of reviews left', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  assert.equal($('tab-review-n').textContent, '2');
});

test('the level is one line in the head', async () => {
  routes();
  stubStorage();
  await mypage.openMypage();
  assert.match(text($('level-body')), /레벨 판정까지 세션 2\/3 · 발화 9\/15/);
  routes({ stats: () => jsonResponse(STATS({ level: { value: 'intermediate', sessions: 5, utterances: 40, need_sessions: 3, need_utterances: 15 } })) });
  await mypage.openMypage();
  assert.match(text($('level-body')), /레벨 중급/);
});
```

`afterEach`/`beforeEach`에서 `delete globalThis.localStorage`로 테스트 사이 누출을 막는다. 기존 테스트 중 `판정하기엔 아직 일러요` / `지금 레벨 중급`을 기대하는 것은 새 문구로 고친다(`레벨 판정까지 세션 2/3 · 발화 9/15`, `레벨 중급 · 최근 세션 판정`).

- [ ] **Step 4: 실패 확인** — node 스위트, 새 테스트 FAIL(`selectTab is not a function` 등).

- [ ] **Step 5: 구현** — `static/js/mypage.js`:

```js
const TABS = ['review', 'weak', 'history'];
const TAB_KEY = 'mypage-tab';
const PANEL = { review: 'review-section', weak: 'weak-section', history: 'history-section' };

function rememberedTab() {
  try {
    const t = globalThis.localStorage?.getItem(TAB_KEY);
    return TABS.includes(t) ? t : 'review';
  } catch {
    return 'review';
  }
}

export function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'review';
  for (const t of TABS) {
    const on = t === name;
    const tab = $(`tab-${t}`);
    tab.setAttribute('aria-selected', String(on));
    tab.setAttribute('tabindex', on ? '0' : '-1');
    $(PANEL[t]).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
  try { globalThis.localStorage?.setItem(TAB_KEY, name); } catch { /* private window: fine */ }
  if (name === 'weak') onWeakShown();
}

/* Task 4 fills this: the coach is asked for only when 약점 is looked at. */
function onWeakShown() {}

export function onTabKey(e) {
  const current = e.target?.dataset?.tab;
  const i = TABS.indexOf(current);
  if (i < 0) return;
  const next = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i + TABS.length - 1) % TABS.length,
                 Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(TABS[next], { focus: true });
}
```

`openMypage`를 `openMypage({ tab } = {})`로 바꾸고, `router.show('mypage')` 직후 `selectTab(tab || rememberedTab());`. **주의:** main.js가 `openMypage`를 이벤트 리스너로 직접 넘기는 곳(`addEventListener('click', openMypage)`)은 첫 인자로 Event가 들어오므로 `({ tab } = {})` 구조분해가 `tab: undefined`가 되어 괜찮지만, 명시적으로 `() => openMypage()`로 바꿔 둔다.

`dom-shim`이 `getAttribute`/`setAttribute`/`hidden`/`focus`를 지원하는지 확인(`hidden`, `focus`는 있다). `tabindex`는 `setAttribute`로.

`renderLevel`:

```js
export function renderLevel(level) {
  const body = $('level-body');
  if (level && level.value) {
    const line = el('p', 'level-line');
    line.append(el('b', '', `레벨 ${LEVEL_NAMES[level.value] || level.value}`), document.createTextNode(' · 최근 세션 판정'));
    body.replaceChildren(line);
    return;
  }
  const needSessions = level?.need_sessions ?? 3;
  const needUtterances = level?.need_utterances ?? 15;
  const sessions = Math.min(level?.sessions ?? 0, needSessions);
  const utterances = Math.min(level?.utterances ?? 0, needUtterances);
  body.replaceChildren(el('p', 'level-line', `레벨 판정까지 세션 ${sessions}/${needSessions} · 발화 ${utterances}/${needUtterances}`));
}
```

dom-shim에 `document.createTextNode`가 없으면 `el('span', '', ' · 최근 세션 판정')`로 대신한다. `paintSkeletons`의 레벨 부분은 `skeletonLine('p', 'level-line')` 하나로.

복습 개수: `paintReviewHead()` 안에서 `$('tab-review-n').textContent = reviewsLeft() > 0 ? String(reviewsLeft()) : '';` — 카드가 빠질 때마다 이미 `paintReviewHead`가 불리는지 확인하고, 불리지 않는 경로가 있으면 거기도 추가.

`static/js/main.js`:

```js
$('mypage-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest?.('[role="tab"]');
  if (tab) selectTab(tab.dataset.tab);
});
$('mypage-tabs').addEventListener('keydown', onTabKey);
$('btn-mypage').addEventListener('click', () => openMypage());
$('week-more').addEventListener('click', () => openMypage());
$('review-home-go').addEventListener('click', () => openMypage({ tab: 'review' }));
```

import에 `selectTab`, `onTabKey` 추가. `#tab-review-n` span을 클릭해도 `closest`가 버튼을 찾는다(실제 브라우저).

- [ ] **Step 6: 통과 확인** — node 전체, `tests/test_mypage_css.py`, `tests/test_css_tokens.py`.
- [ ] **Step 7: 부숴 보기** — (a) `selectTab`에서 localStorage 저장을 빼면 remembered 테스트 빨강, (b) `rememberedTab`의 try/catch를 빼면 throwing-storage 테스트 빨강, (c) `openMypage`에서 `tab ||`를 빼면 explicit-tab 테스트 빨강. 되돌린다.
- [ ] **Step 8: 커밋** — `feat: my page in three tabs -- 복습, 약점, 기록 -- with the level as one line in the head`

---

### Task 4: 화면 — 약점 탭: 태그 예시 펼치기와 코치 한마디

**Files:**
- Modify: `static/index.html` (`#weak-section` 안에 코치 블록)
- Modify: `static/css/components.css`
- Modify: `static/js/mypage.js` (`renderTags` 예시, `toggleTagItem`, `onTagClick`, `loadCoach`, `onWeakShown`)
- Modify: `static/js/main.js` (`#tag-bars` 클릭, `#coach-body` 다시 시도 클릭)
- Test: `static/js/mypage.test.js`, `tests/test_mypage_css.py`

**Interfaces:**
- Consumes: Task 1의 `/stats/mypage` `tags[].examples[{text, fixed, correction}]`; Task 2의 `GET /api/mypage/coach` 응답(too_few/ready/503); Task 3의 `selectTab`/`onWeakShown` 자리.
- Produces: `export function toggleTagItem(item)`, `export function onTagClick(e)`, `export async function loadCoach({ force = false } = {})`.

- [ ] **Step 1: 마크업** — `#weak-section` 맨 위(기존 `<p class="label">자주 걸리는 것</p>` 앞)에:

```html
      <div id="coach" class="coach">
        <div class="coach-head"><p class="label">코치 한마디</p><span id="coach-day" class="hint"></span></div>
        <div id="coach-body" aria-live="polite"></div>
      </div>
```

- [ ] **Step 2: 실패하는 node 테스트** — `routes()`에 코치 경로를 더한다(`extra.coach`가 있으면 그걸, 없으면 ready):

```js
const COACH = {
  status: 'ready', day: '2026-09-19', count: 12, items: [
    { habit: '여러 말을 끊지 않고 이어 말해요', tip: '한 문장 말하고 숨을 한 번 쉬어요', said: 'Yes water please And', fixed: 'Yes, water please.', tag: '어순' },
    { habit: '장소 앞 전치사를 빠뜨려요', tip: '"by the"를 먼저 붙여요', said: 'sit the window', fixed: 'sit by the window.', tag: '어순' },
  ] };
// in routes(): if (url.startsWith('/api/mypage/coach')) { seen.coach = (seen.coach || 0) + 1; return extra.coach ? extra.coach(url) : jsonResponse(COACH); }
```

`STATS()`의 tags에 examples를 넣는다:

```js
tags: [{ tag: '시제', n: 6, examples: [
  { text: 'I go there yesterday', fixed: 'I went there yesterday.', correction: '지난 일은 과거형으로 말해야 합니다. 이 문장에서는 go가 went가 됩니다.' },
  { text: 'I meet him last week', fixed: 'I met him last week.', correction: '과거형' }] },
  { tag: '관사', n: 3, examples: [] }],
```

테스트:

```js
test('the coach is asked for only when 약점 is opened, once per load', async () => {
  const seen = routes();
  stubStorage();
  await mypage.openMypage();
  assert.equal(seen.coach, undefined);
  mypage.selectTab('weak');
  mypage.selectTab('review');
  mypage.selectTab('weak');
  await settleAll();
  assert.equal(seen.coach, 1);
  assert.match(text($('coach-body')), /여러 말을 끊지 않고 이어 말해요/);
  assert.match(text($('coach-body')), /한 문장 말하고 숨을 한 번 쉬어요/);
  assert.match(text($('coach-body')), /내 말 Yes water please And/);
  assert.match(text($('coach-body')), /고친 문장 Yes, water please\./);
  assert.equal($('coach-day').textContent, '오늘 만듦');
});

test('while the coach is being made the wait is said on screen', async () => {
  let release;
  routes({ coach: () => new Promise((r) => { release = () => r(jsonResponse(COACH)); }) });
  stubStorage();
  await mypage.openMypage();
  mypage.selectTab('weak');
  assert.match(text($('coach-body')), /코치가 최근 문장을 읽는 중이에요/);
  release();
  await settleAll();
  assert.doesNotMatch(text($('coach-body')), /읽는 중/);
});

test('too few wrong sentences says how many are needed', async () => {
  routes({ coach: () => jsonResponse({ status: 'too_few', count: 3, need: 5 }) });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  await settleAll();
  assert.match(text($('coach-body')), /틀린 문장이 5개 넘게 모이면 코치가 짚어 줘요 \(지금 3개\)/);
});

test('a failed coach offers 다시 시도 and it asks again', async () => {
  let fail = true;
  const seen = routes({ coach: () => (fail ? jsonResponse({ detail: 'x' }, 503) : jsonResponse(COACH)) });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  await settleAll();
  assert.match(text($('coach-body')), /코치 한마디를 만들지 못했어요/);
  fail = false;
  await mypage.loadCoach({ force: true });
  assert.equal(seen.coach, 2);
  assert.match(text($('coach-body')), /여러 말을 끊지 않고/);
});

test('a coach answer from an older load or language is not painted', async () => {
  let release;
  routes({ coach: () => new Promise((r) => { release = () => r(jsonResponse(COACH)); }) });
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  state.language = 'ja';
  routes({ coach: () => jsonResponse({ status: 'too_few', count: 1, need: 5 }) });
  await mypage.openMypage();
  await settleAll();
  release();
  await settleAll();
  assert.match(text($('coach-body')), /지금 1개/);
});

test('a tag opens to its newest sentences, without a strike-through class', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  const item = $('tag-bars').children.find((c) => c.classList.contains('tag-item'));
  const fold = item.children.find((c) => c.classList.contains('tag-examples'));
  assert.ok(fold.classList.contains('is-collapsed'));
  mypage.toggleTagItem(item);
  assert.ok(!fold.classList.contains('is-collapsed'));
  const head = item.children.find((c) => c.classList.contains('tag-bar'));
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.match(text(fold), /내 말 I go there yesterday/);
  assert.match(text(fold), /고친 문장 I went there yesterday\./);
  assert.match(text(fold), /지난 일은 과거형으로/);
  assert.equal(JSON.stringify(fold).includes('"said"'), false);
});

test('a tag with no sentences stays a plain bar', async () => {
  routes();
  stubStorage({ 'mypage-tab': 'weak' });
  await mypage.openMypage();
  const items = $('tag-bars').children.filter((c) => c.classList.contains('tag-item'));
  const plain = items[1];
  assert.equal(plain.children.some((c) => c.classList.contains('tag-examples')), false);
});
```

`settleAll`, `text` 헬퍼가 파일에 없으면 기존 테스트가 쓰는 대기 방식(`await new Promise(setImmediate)` 여러 번 등)으로 만든다. dom-shim의 `children`이 배열인지(find/filter가 되는지) 확인하고 아니면 `Array.from`. `jsonResponse(body, status)`가 status를 받는지 확인하고 아니면 dom-shim 패턴대로. 마지막 단언(`"said"` 클래스 없음)은 dom-shim 직렬화가 안 되면, fold 안 모든 노드를 걸어 `said` 클래스가 없는지 보는 헬퍼로 바꾼다.

- [ ] **Step 3: 실패 확인** — node 새 테스트 FAIL.

- [ ] **Step 4: 구현** — `static/js/mypage.js`:

`renderTags`의 막대 부분을 교체:

```js
  bars.replaceChildren(...tags.map((t) => {
    const item = el('div', 'tag-item');
    const examples = t.examples || [];
    const bar = examples.length ? button('tag-bar', '') : el('div', 'tag-bar');
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${(t.n / max) * 100}%`;
    track.append(fill);
    bar.append(el('span', 'name', t.tag), track, el('span', 'n', `${t.n}회${examples.length ? ' ▸' : ''}`));
    item.append(bar);
    if (examples.length) {
      bar.setAttribute('aria-expanded', 'false');
      item.append(fold('tag-examples', ...examples.map(tagExample)));
    }
    return item;
  }));
```

```js
/* 내 말 / 고친 문장 / why -- own class names: .said elsewhere (the report's
   .fix-row) strikes its text through, and the learner's words are not wrong
   to look at here. */
function tagExample(e) {
  const box = el('div', 'tag-ex');
  box.append(labelled('tag-ex-mine', '내 말', e.text), labelled('tag-ex-fixed', '고친 문장', e.fixed || ''));
  if (e.correction) box.append(button('tag-ex-why', e.correction));
  return box;
}

function labelled(cls, label, value) {
  const p = el('p', cls);
  p.append(el('span', 'tag-ex-label', label), el('span', 'tag-ex-text', value));
  return p;
}

export function toggleTagItem(item) {
  const box = find(item, 'tag-examples');
  const head = find(item, 'tag-bar');
  if (!box) return;
  const open = box.classList.toggle('is-collapsed') === false;
  if (head) head.setAttribute('aria-expanded', String(open));
}

/* main.js's delegated click on #tag-bars: a bar folds its sentences open, a
   clipped why opens to its full length. */
export function onTagClick(e) {
  const why = e.target.closest('.tag-ex-why');
  if (why) { why.classList.toggle('is-open'); return; }
  const item = e.target.closest('.tag-item');
  if (item && e.target.closest('.tag-bar')) toggleTagItem(item);
}
```

`text()` 테스트 헬퍼가 `내 말 I go there yesterday`로 읽도록 라벨과 값 사이에 공백이 생기는지 확인(라벨 span 뒤 CSS gap이면 textContent엔 공백이 없다 — 그러면 테스트 정규식을 `/내 말\s*I go there yesterday/`로).

코치:

```js
const COACH_WAIT = '코치가 최근 문장을 읽는 중이에요 · 10~20초';
let coachFor = '';     // `${loadToken}:${language}` the coach was asked for

function onWeakShown() { loadCoach(); }

export async function loadCoach({ force = false } = {}) {
  const lang = state.language;
  const token = loadToken;
  const key = `${token}:${lang}`;
  if (!force && coachFor === key) return;
  coachFor = key;
  const stale = () => token !== loadToken || state.language !== lang;
  const body = $('coach-body');
  $('coach-day').textContent = '';
  body.replaceChildren(loadingNoteWith(COACH_WAIT), ...[0, 1].map(coachSkeleton));
  body.setAttribute('aria-busy', 'true');
  try {
    const c = await getJSON(`/mypage/coach?language=${lang}`);
    if (stale()) return;
    if (c.status === 'too_few') {
      body.replaceChildren(el('p', 'hint', `틀린 문장이 ${c.need}개 넘게 모이면 코치가 짚어 줘요 (지금 ${c.count}개)`));
    } else {
      body.replaceChildren(...(c.items || []).map(coachItem));
      $('coach-day').textContent = '오늘 만듦';
    }
  } catch {
    if (stale()) return;
    coachFor = '';
    const row = el('div', 'coach-fail');
    row.append(el('p', 'mypage-error', '코치 한마디를 만들지 못했어요'), button('coach-retry', '다시 시도'));
    body.replaceChildren(row);
  } finally {
    if (!stale()) body.removeAttribute('aria-busy');
  }
}

function coachItem(i) {
  const box = el('div', 'coach-item');
  box.append(el('p', 'coach-habit', i.habit), el('p', 'coach-tip', `→ ${i.tip}`),
             labelled('tag-ex-mine', '내 말', i.said), labelled('tag-ex-fixed', '고친 문장', i.fixed));
  return box;
}

function coachSkeleton() {
  const box = el('div', 'coach-item is-skeleton');
  box.append(skeletonLine('p', 'coach-habit'), skeletonLine('p', 'coach-tip'), skeletonLine('p', 'tag-ex-mine'));
  return box;
}
```

`loadingNoteWith(words)`: 기존 `loadingNote()`가 `LOADING` 문구를 박아 두었으면 인자를 받게 바꾼다(`loadingNote(words = LOADING)`). 언어 전환·재진입 때 `openMypage`가 새 `loadToken`을 만들므로, `openMypage` 끝에서 현재 탭이 `weak`이면 `loadCoach()`를 부른다(`selectTab`이 `openMypage` 초반에 불릴 때는 loadToken이 이미 올라간 뒤여야 한다 — `++loadToken`을 `selectTab` 호출보다 먼저 두거나, `selectTab` 후에 따로 `if (current === 'weak') loadCoach()`). 코치 블록은 `paintSkeletons`/`setRefreshing` 대상이 아니다(자기 로딩을 가진다).

`static/js/main.js`:

```js
$('tag-bars').addEventListener('click', onTagClick);
$('coach-body').addEventListener('click', (e) => { if (e.target.closest('.coach-retry')) loadCoach({ force: true }); });
```

- [ ] **Step 5: CSS**

```css
/* 약점 -- the coach first: what to do next time, from the learner's own lines. */
.coach { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: var(--space-3);
  margin-bottom: var(--space-4); background: var(--surface-sunken); }
.coach-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.coach-head .label { margin: 0 0 var(--space-2); }
/* Two skeleton items are the height of two real ones, so the wait does not
   jump when the answer lands. */
#coach-body { position: relative; display: flex; flex-direction: column; gap: var(--space-3); min-height: 9rem; }
.coach-habit { margin: 0; font-weight: 650; color: var(--text); }
.coach-tip { margin: var(--space-1) 0; color: var(--suggest-ink); font-size: var(--text-sm); }
.coach-fail { display: flex; align-items: center; gap: var(--space-2); }

.tag-item { display: flex; flex-direction: column; }
button.tag-bar { width: 100%; background: none; border: 0; padding: var(--space-1) 0; text-align: left; cursor: pointer; }
.tag-ex { border-left: 2px solid var(--line); padding: var(--space-1) 0 var(--space-1) var(--space-3); margin: var(--space-1) 0; }
.tag-ex-mine, .tag-ex-fixed { margin: 0; font-size: var(--text-sm); display: flex; gap: var(--space-2); }
.tag-ex-mine .tag-ex-text { color: var(--text-dim); text-decoration: none; }
.tag-ex-fixed .tag-ex-text { color: var(--text); font-weight: 600; }
.tag-ex-label { flex: none; width: 4.5em; color: var(--text-faint); font-size: var(--text-xs); padding-top: 0.15em; }
.tag-ex-why { background: none; border: 0; padding: 0; margin-top: var(--space-1); text-align: left;
  font-size: var(--text-xs); color: var(--text-dim); cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tag-ex-why.is-open { -webkit-line-clamp: unset; display: block; }
```

`tests/test_mypage_css.py`:

```python
def test_the_learners_words_are_never_struck_through_on_my_page():
    css = read_css()
    for sel in (r"\.tag-ex-mine[^{]*", r"\.tag-ex-text[^{]*"):
        for block in re.findall(sel + r"\{([^}]*)\}", css):
            assert "line-through" not in block


def test_the_coach_body_keeps_its_height_while_loading():
    assert re.search(r"#coach-body\s*\{[^}]*min-height", read_css())
```

토큰 이름은 `tokens.css`에 있는 것만.

- [ ] **Step 6: 통과 확인** — node 전체, pytest `-m "not engine"`.
- [ ] **Step 7: 부숴 보기** — (a) `loadCoach`의 `coachFor === key` 가드를 빼면 once-per-load 테스트 빨강, (b) `stale()` 검사를 빼면 older-load 테스트 빨강, (c) `tagExample`의 클래스를 `said`로 바꾸면 strike-through 테스트 빨강. 되돌린다.
- [ ] **Step 8: 커밋** — `feat: 약점 says what goes wrong -- each tag opens to its sentences, and a coach reads them for habits`

---

## 컨트롤러 마무리(서브에이전트 아님)

1. 대본 생성 멈춤 → `pytest tests/test_coach_quality.py -m engine -s`로 en/ja 표 확인. 본 DB 복사본으로 `/api/mypage/coach` 실제 호출(8010) — 습관이 구체적인가, 실제 문장 근거인가, 팁이 바로 해 볼 수 있는가, 한국어만인가. 표를 사용자에게 보여준다. 프롬프트를 고치면 전후 비교.
2. 8010 브라우저: 탭 전환 높이, 폰 폭(탭 3개 한 줄), 코치 로딩→결과 높이, 태그 펼침, 다크 모드.
3. 본 DB 백업 → main 머지 → 8000 재시작(v8).
