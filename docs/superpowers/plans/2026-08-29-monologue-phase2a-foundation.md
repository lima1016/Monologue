# Phase 2A — 토대 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교정 피드백이 한국어로 안정적으로 나오고 오류 태그가 DB에 쌓이기 시작하도록, 스키마 마이그레이션·피드백 프롬프트·프론트엔드 골격을 세운다.

**Architecture:** 백엔드는 `PRAGMA user_version` 기반 마이그레이션을 `db.init_db()`에 넣고, `FEEDBACK_SCHEMA`를 2필드 상수에서 5필드 언어별 함수로 바꾼다. 피드백 시스템 프롬프트를 영어에서 한국어로 옮긴다 (스파이크에서 검증된 처방). 프론트엔드는 동작을 바꾸지 않은 채 `app.js`를 ES 모듈로 쪼개고 디자인 토큰 CSS를 세운다 — B단계가 그 위에 화면을 올린다.

**Tech Stack:** Python 3.13, FastAPI, SQLite (표준 라이브러리 `sqlite3`), pytest, Ollama(`qwen2.5:14b`), 빌드 도구 없는 ES 모듈 + 순수 CSS

**Spec:** `docs/superpowers/specs/2026-08-29-monologue-phase2-design.md`

## Global Constraints

- 언어별 태그 목록은 정확히 이 값이다. 임의로 늘리거나 줄이지 않는다.
  - `en`: 시제 / 관사 / 전치사 / 어순 / 어휘 / 단복수 / 없음
  - `ja`: 시제 / 조사 / 활용 / 어순 / 어휘 / 경어 / 없음
- 피드백 시스템 프롬프트는 **한국어로** 쓴다. 영어로 "한국어로 써라"라고 지시하지 않는다 — 그것이 현재 버그의 원인이다.
- 마이그레이션 단계는 **추가만** 한다. 이미 적용된 단계의 SQL을 수정하지 않는다.
- 기존 31개 세션 데이터는 백필하지 않는다. 새 컬럼은 NULL로 남고 통계는 NULL을 제외한다.
- 빌드 도구를 도입하지 않는다. `<script type="module">`로 충분하다.
- DB 엔진은 SQLite를 유지한다.
- 모델은 `qwen2.5:14b`를 유지한다.
- 테스트 실행: `.\venv\Scripts\python.exe -m pytest -m "not engine"`
- 커밋 메시지는 기존 저장소 관례를 따른다 (`feat:` / `fix:` / `docs:` / `refactor:`).

---

### Task 1: 스키마 마이그레이션 프레임워크

현재 `db.init_db()`는 `conn.executescript(SCHEMA)`만 실행하고 SCHEMA는 전부 `CREATE TABLE IF NOT EXISTS`다. 기존 DB에는 컬럼 추가가 **조용히 실패한다.** 이 태스크가 그 경로를 만든다.

**Files:**
- Modify: `app/db.py:12-45` (SCHEMA 상수 아래에 MIGRATIONS 추가), `app/db.py:71-75` (`init_db`)
- Test: `tests/test_db.py`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `db.MIGRATIONS: list[list[str]]` — 인덱스 i는 버전 i에서 i+1로 가는 SQL 문 리스트
  - `db.schema_version() -> int` — 현재 DB의 `user_version`
  - `db.init_db() -> None` — 시그니처 불변, 동작 확장

- [ ] **Step 1: Write the failing tests**

`tests/test_db.py` 맨 아래에 추가한다. `store` 픽스처는 이미 파일 상단에 있다.

```python
import sqlite3


def test_fresh_database_lands_on_the_latest_schema_version(store):
    assert store.schema_version() == len(store.MIGRATIONS)


def test_init_db_is_idempotent(store):
    before = store.schema_version()
    store.init_db()
    store.init_db()
    assert store.schema_version() == before


def test_a_phase1_database_is_stamped_and_then_migrated(tmp_path, monkeypatch):
    """The real monologue.db predates user_version: it sits at 0 with the v1
    schema already applied. Running migrations from 0 must not try to recreate
    what is already there, and must still add the new columns."""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript(db.SCHEMA)          # Phase 1 schema, no user_version
    conn.execute(
        "INSERT INTO sessions (language, mode, started_at) VALUES ('en','free','t0')"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(db.config, "DB_PATH", path)
    db.init_db()

    assert db.schema_version() == len(db.MIGRATIONS)
    with db.connect() as c:
        cols = {r[1] for r in c.execute("PRAGMA table_info(messages)")}
        assert {"ok", "fixed", "tag"} <= cols
        assert c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_db.py -k "schema_version or idempotent or phase1" -v`
Expected: FAIL — `AttributeError: module 'app.db' has no attribute 'schema_version'`

- [ ] **Step 3: Implement the migration runner**

`app/db.py`에서 SCHEMA 상수 바로 아래에 추가한다:

```python
# Each entry migrates the database from version i to version i+1. Entries are
# append-only: editing one that has already run would leave databases with
# different shapes depending on when they were created.
MIGRATIONS = [
    # v0 -> v1: the Phase 1 schema
    [SCHEMA],
    # v1 -> v2: structured feedback fields (Phase 2A)
    [
        "ALTER TABLE messages ADD COLUMN ok INTEGER",
        "ALTER TABLE messages ADD COLUMN fixed TEXT",
        "ALTER TABLE messages ADD COLUMN tag TEXT",
    ],
]
```

`init_db`를 통째로 교체한다 (현재 `app/db.py:71-75`):

```python
def schema_version() -> int:
    with connect() as conn:
        return conn.execute("PRAGMA user_version").fetchone()[0]


def _stamp_phase1_database(conn) -> None:
    """A database created before migrations existed sits at user_version 0 with
    the v1 schema already applied. Stamp it as v1 so the runner resumes at the
    right step instead of replaying migration 0."""
    if conn.execute("PRAGMA user_version").fetchone()[0] != 0:
        return
    already = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).fetchone()
    if already:
        conn.execute("PRAGMA user_version = 1")


def init_db() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        _stamp_phase1_database(conn)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for step in MIGRATIONS[version:]:
            for statement in step:
                conn.executescript(statement)
            version += 1
            # PRAGMA does not accept bound parameters; version is an int we
            # computed ourselves, never user input.
            conn.execute(f"PRAGMA user_version = {version}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_db.py -v`
Expected: PASS — 새 테스트 3개 포함 전부 통과

- [ ] **Step 5: Verify the real database migrates**

Run:
```powershell
Copy-Item monologue.db monologue.db.bak
.\venv\Scripts\python.exe -c "from app import db; db.init_db(); print('version', db.schema_version()); import sqlite3; c=sqlite3.connect('monologue.db'); print(sorted(r[1] for r in c.execute('PRAGMA table_info(messages)')))"
```
Expected: `version 2` 와 컬럼 목록에 `fixed`, `ok`, `tag` 포함. 기존 행은 그대로 남아 있어야 한다.

- [ ] **Step 6: Commit**

```bash
git add app/db.py tests/test_db.py
git commit -m "feat: add PRAGMA user_version schema migrations

init_db only ran CREATE TABLE IF NOT EXISTS, so adding a column to SCHEMA
would silently never reach an existing database. Adds an append-only
migration list, and stamps Phase 1 databases as v1 so the runner does not
replay migration 0 over tables that already exist."
```

---

### Task 2: `add_message`가 ok / fixed / tag를 저장

**Files:**
- Modify: `app/db.py:93-112` (`add_message`)
- Test: `tests/test_db.py`

**Interfaces:**
- Consumes: Task 1의 v2 마이그레이션 (컬럼 존재)
- Produces: `db.add_message(session_id, speaker, text, correction=None, suggestion=None, ok=None, fixed=None, tag=None) -> int`

- [ ] **Step 1: Write the failing test**

`tests/test_db.py`에 추가한다:

```python
def test_add_message_persists_structured_feedback(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "I go store yesterday.",
                      correction="'go'는 과거형이 아닙니다.",
                      suggestion="'I went to the store yesterday.'라고 말하세요.",
                      ok=False, fixed="I went to the store yesterday.", tag="시제")
    row = store.get_messages(sid)[0]
    assert row["ok"] == 0
    assert row["fixed"] == "I went to the store yesterday."
    assert row["tag"] == "시제"


def test_add_message_leaves_feedback_fields_null_when_not_given(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    row = store.get_messages(sid)[0]
    assert row["ok"] is None and row["fixed"] is None and row["tag"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_db.py -k "structured_feedback or leaves_feedback" -v`
Expected: FAIL — `TypeError: add_message() got an unexpected keyword argument 'ok'`

- [ ] **Step 3: Extend `add_message`**

`app/db.py`의 `add_message`를 교체한다. 기존 docstring(턴 원자성 설명)은 그대로 둔다:

```python
def add_message(session_id, speaker, text, correction=None, suggestion=None,
                ok=None, fixed=None, tag=None) -> int:
    """Insert a message and auto-increment its turn within the session.

    Turn is computed inside the INSERT subquery to ensure atomicity: two concurrent
    calls for the same session will not both read MAX(turn) before either acquires
    the write lock, which would produce duplicate turn values. The UNIQUE constraint
    on (session_id, turn) catches any violation as a loud error.

    ok/fixed/tag are the structured half of the feedback; correction/suggestion
    stay as the prose explanation shown when the learner expands a chip.
    """
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages (session_id, turn, speaker, text, correction,"
            " suggestion, ok, fixed, tag, created_at)"
            " SELECT ?,"
            "        (SELECT COALESCE(MAX(turn), 0) + 1 FROM messages WHERE session_id = ?),"
            "        ?, ?, ?, ?, ?, ?, ?, ?",
            (session_id, session_id, speaker, text, correction, suggestion,
             ok, fixed, tag, _now()),
        )
        return cur.lastrowid
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_db.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/db.py tests/test_db.py
git commit -m "feat: store ok/fixed/tag alongside correction and suggestion"
```

---

### Task 3: 언어별 태그와 한국어 피드백 프롬프트

스파이크에서 검증된 처방 세 가지를 적용한다: 한국어 시스템 프롬프트, 언어별 태그 목록, 태그별 한 줄 정의.

**Files:**
- Modify: `app/prompts.py:98-104` (`FEEDBACK_SCHEMA`), `app/prompts.py:169-210` (`FEEDBACK_EXAMPLES`), `app/prompts.py:213-258` (`build_feedback_messages`)
- Test: `tests/test_prompts.py:84-88` (기존 스키마 테스트 교체) + 새 테스트

**Interfaces:**
- Consumes: 없음
- Produces:
  - `prompts.FEEDBACK_TAGS: dict[str, tuple[str, ...]]`
  - `prompts.FEEDBACK_TAG_DEFINITIONS: dict[str, str]`
  - `prompts.feedback_schema(language: str) -> dict` — **`FEEDBACK_SCHEMA` 상수를 대체한다**
  - `prompts.build_feedback_messages(language, user_text) -> list[dict]` — 시그니처 불변

- [ ] **Step 1: Write the failing tests**

`tests/test_prompts.py:84-88`의 기존 테스트를 찾아 지우고 (`prompts.FEEDBACK_SCHEMA`를 참조하는 테스트), 아래를 추가한다:

```python
def test_feedback_schema_requires_five_fields_and_language_specific_tags():
    en = prompts.feedback_schema("en")
    assert set(en["required"]) == {"ok", "fixed", "tag", "correction", "suggestion"}
    assert en["properties"]["ok"]["type"] == "boolean"
    assert "전치사" in en["properties"]["tag"]["enum"]
    assert "조사" not in en["properties"]["tag"]["enum"]

    ja = prompts.feedback_schema("ja")
    assert "조사" in ja["properties"]["tag"]["enum"]
    assert "전치사" not in ja["properties"]["tag"]["enum"]


def test_every_tag_has_a_definition_line():
    for language, tags in prompts.FEEDBACK_TAGS.items():
        defs = prompts.FEEDBACK_TAG_DEFINITIONS[language]
        for tag in tags:
            assert f"{tag} -" in defs, f"{language}/{tag} has no definition"


def test_feedback_system_prompt_is_written_in_korean():
    """The bug this fixes: the prompt asked for Korean *in English*, and the
    model followed the language it was addressed in rather than the request."""
    for language in ("en", "ja"):
        system = prompts.build_feedback_messages(language, "test")[0]["content"]
        hangul = sum(1 for ch in system if "가" <= ch <= "힣")
        assert hangul > 100, f"{language} system prompt is not Korean"


def test_feedback_examples_carry_the_full_five_field_shape():
    import json
    for language in ("en", "ja"):
        msgs = prompts.build_feedback_messages(language, "test")
        answers = [json.loads(m["content"]) for m in msgs if m["role"] == "assistant"]
        assert answers, "few-shot examples are missing"
        for answer in answers:
            assert set(answer) == {"ok", "fixed", "tag", "correction", "suggestion"}
            assert answer["tag"] in prompts.FEEDBACK_TAGS[language]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_prompts.py -v`
Expected: FAIL — `AttributeError: module 'app.prompts' has no attribute 'feedback_schema'`

- [ ] **Step 3: Replace the schema constant with per-language tags**

`app/prompts.py`의 `FEEDBACK_SCHEMA` 블록(현재 98-104행)을 통째로 교체한다:

```python
# Tag vocabularies are per language on purpose. Giving Japanese a "전치사" slot
# leaves particle errors with nowhere to go and they get filed as "어순"; the
# spike measured 6/8 with a shared list and 8/8 once split.
FEEDBACK_TAGS = {
    "en": ("시제", "관사", "전치사", "어순", "어휘", "단복수", "없음"),
    "ja": ("시제", "조사", "활용", "어순", "어휘", "경어", "없음"),
}

# Naming the tags is not enough -- the model guesses. One defining line each,
# plus the consistency rule in the system prompt, is what made tagging reliable.
FEEDBACK_TAG_DEFINITIONS = {
    "en": (
        "시제 - 동사의 과거/현재/미래 형태가 틀림\n"
        "관사 - a, an, the를 빠뜨렸거나 잘못 씀\n"
        "전치사 - in, on, at, to 같은 전치사를 잘못 고름\n"
        "어순 - 단어 순서 자체가 틀림\n"
        "어휘 - 단어 선택이 틀렸거나 부자연스러움\n"
        "단복수 - 단수/복수 형태나 주어-동사 수 일치가 틀림 (He don't -> He doesn't)\n"
        "없음 - 틀린 곳이 없음"
    ),
    "ja": (
        "시제 - 과거/현재/미래 형태가 틀림\n"
        "조사 - は, が, に, で, を, の 같은 조사를 잘못 골랐음\n"
        "활용 - 동사/형용사 활용형이 틀림 (て형, ない형, 명사수식 등)\n"
        "어순 - 단어 순서 자체가 틀림\n"
        "어휘 - 단어 선택이 틀렸거나 부자연스러움\n"
        "경어 - 존댓말/반말 수준이 안 맞음\n"
        "없음 - 틀린 곳이 없음"
    ),
}

KOREAN_LANGUAGE_NAMES = {"en": "영어", "ja": "일본어"}


def feedback_schema(language) -> dict:
    """Ollama constrains generation to this shape, so the JSON always parses.
    What it cannot enforce is the *content*: that the prose is Korean and that
    the chosen tag matches what the explanation actually says. Those are the
    system prompt's job."""
    return {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "fixed": {"type": "string"},
            "tag": {"type": "string", "enum": list(FEEDBACK_TAGS[language])},
            "correction": {"type": "string"},
            "suggestion": {"type": "string"},
        },
        "required": ["ok", "fixed", "tag", "correction", "suggestion"],
    }
```

- [ ] **Step 4: Extend the few-shot examples to the five-field shape**

`app/prompts.py`의 `FEEDBACK_EXAMPLES`에서 각 예시 dict에 `ok` / `fixed` / `tag`를 추가한다. 나머지 필드는 그대로 둔다.

```python
FEEDBACK_EXAMPLES = {
    "en": [
        {
            "learner": "I go store yesterday.",
            "ok": False,
            "fixed": "I went to the store yesterday.",
            "tag": "시제",
            "correction": (
                "'go'는 과거형이 아니라서 틀렸습니다. 'went'로 바꾸고 'to the'를 "
                "추가해야 합니다. 올바른 문장은 'I went to the store yesterday.'입니다."
            ),
            "suggestion": (
                "원어민이라면 'I went to the store yesterday.' 또는 'Yesterday I "
                "went to the store.'처럼 말할 거예요."
            ),
        },
        {
            "learner": "I have two brothers and one sister.",
            "ok": True,
            "fixed": "I have two brothers and one sister.",
            "tag": "없음",
            "correction": "이 문장은 문법적으로 이미 맞습니다. 고칠 부분이 없습니다.",
            "suggestion": (
                "좀 더 자연스럽게 말하고 싶다면 'I've got two brothers and a "
                "sister.'처럼 표현할 수도 있어요."
            ),
        },
    ],
    "ja": [
        {
            "learner": "きのう、レストランに行きます。",
            "ok": False,
            "fixed": "きのう、レストランに行きました。",
            "tag": "시제",
            "correction": (
                "'行きます'는 현재형이라서 어제 있었던 일에는 맞지 않습니다. 과거형인 "
                "'行きました'로 바꿔야 합니다. 올바른 문장은 'きのう、レストランに"
                "行きました。'입니다."
            ),
            "suggestion": "원어민이라면 '昨日、レストランに行きました。'처럼 자연스럽게 말할 거예요.",
        },
        {
            "learner": "わたしは毎朝コーヒーを飲みます。",
            "ok": True,
            "fixed": "わたしは毎朝コーヒーを飲みます。",
            "tag": "없음",
            "correction": "이 문장은 문법적으로 이미 맞습니다. 고칠 부분이 없습니다.",
            "suggestion": (
                "좀 더 자연스럽게 말하고 싶다면 '毎朝コーヒーを飲んでいます。'처럼 "
                "표현할 수도 있어요."
            ),
        },
    ],
}
```

- [ ] **Step 5: Rewrite `build_feedback_messages` with a Korean system prompt**

`app/prompts.py:213-258`의 함수를 통째로 교체한다:

```python
FEEDBACK_SYSTEM = """당신은 한국인 학생을 가르치는 한국어 원어민 교사입니다.
당신이 말하고 쓰는 언어는 오직 한국어입니다. {lang}은(는) 당신이 설명하는 '대상'일 뿐,
당신이 사용하는 언어가 아닙니다.

학생이 {lang} 문장을 한 줄 말했습니다. 아래 다섯 항목을 채우세요.

- ok: 문법적으로 맞으면 true, 틀린 곳이 있으면 false
- fixed: 고친 문장 하나만. 이미 맞으면 원문 그대로. {lang}으로 씁니다
- tag: 틀린 부분의 종류. 아래 정의를 보고 정확히 하나만 고릅니다
{defs}
- correction: 무엇이 왜 틀렸는지. 한국어로 두 문장 이내
- suggestion: 원어민이라면 어떻게 말할지. 한국어로 두 문장 이내

tag는 correction에서 실제로 지적한 내용과 일치해야 합니다.

correction과 suggestion은 반드시 한국어로 씁니다. 인용하는 {lang} 예문만 {lang}으로 둡니다.
마크다운과 이모지는 쓰지 않습니다."""


def build_feedback_messages(language, user_text) -> list[dict]:
    """Ask for structured grammar feedback on one learner line.

    The system prompt is written in Korean, and that is the fix, not a style
    choice. The previous version asked for Korean output *in English*; the model
    answered in the language it was addressed in, and English corrections are
    still sitting in the messages table from that period. Moving the instruction
    itself into Korean took the spike from unreliable to 10/10 (en) and 8/8 (ja).

    Few-shot examples stay -- a stated rule alone was not enough to hold the
    local model, especially on already-correct lines.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    system = FEEDBACK_SYSTEM.format(
        lang=language_name, defs=FEEDBACK_TAG_DEFINITIONS[language]
    )
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE

    messages = [{"role": "system", "content": system}]
    for example in FEEDBACK_EXAMPLES[language]:
        messages.append({"role": "user", "content": f"학생이 말한 문장: {example['learner']}"})
        messages.append({
            "role": "assistant",
            "content": json.dumps(
                {k: example[k] for k in ("ok", "fixed", "tag", "correction", "suggestion")},
                ensure_ascii=False,
            ),
        })
    messages.append({"role": "user", "content": f"학생이 말한 문장: {user_text}"})
    return messages
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_prompts.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/prompts.py tests/test_prompts.py
git commit -m "fix: write the feedback system prompt in Korean

Finishes what 6d705d8 started. The prompt asked for Korean explanations in
English, and the model answered in the language it was addressed in --
English corrections from that period are still in the messages table.

Also splits the tag vocabulary per language (Japanese has no prepositions,
so particle errors were being filed as word order) and gives every tag a
defining line. Spike: 10/10 en and 8/8 ja on Korean output, 8/10 and 8/8
on tag accuracy."
```

---

### Task 4: 5필드 피드백을 API로 연결

**Files:**
- Modify: `app/api.py:103-109` (`_feedback`), `app/api.py:164-180` (`chat_turn`)
- Test: `tests/test_api_chat.py:29-31` (가짜 `chat_json` 갱신) + 새 테스트

**Interfaces:**
- Consumes: `db.add_message(..., ok=, fixed=, tag=)` (Task 2), `prompts.feedback_schema(language)` (Task 3)
- Produces: `POST /api/chat` 응답에 `ok: bool | None`, `fixed: str | None`, `tag: str | None` 추가

- [ ] **Step 1: Update the fake and write the failing test**

`tests/test_api_chat.py:29-31`의 `chat_json` 가짜를 교체한다:

```python
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {
                            "ok": False,
                            "fixed": "I went there.",
                            "tag": "시제",
                            "correction": "'go'는 과거형이 아닙니다.",
                            "suggestion": "'I went there.'라고 말하세요.",
                        })
```

같은 파일 아래에 추가한다:

```python
def test_chat_returns_and_stores_structured_feedback(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    sid = r.json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there."}).json()

    assert body["ok"] is False
    assert body["fixed"] == "I went there."
    assert body["tag"] == "시제"

    stored = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    assert stored["ok"] == 0
    assert stored["tag"] == "시제"


def test_chat_survives_a_feedback_failure(client, monkeypatch):
    """A feedback failure must never cost the learner their turn -- the bot
    still replies and the message is still recorded, just without feedback."""
    def boom(messages, schema, **kw):
        raise RuntimeError("model is down")
    monkeypatch.setattr("app.api.llm.chat_json", boom)

    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    sid = r.json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there."}).json()

    assert body["bot_reply"]
    assert body["ok"] is None and body["tag"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_chat.py -k "structured_feedback or survives_a_feedback" -v`
Expected: FAIL — `KeyError: 'ok'` (응답에 아직 없음)

- [ ] **Step 3: Rewrite `_feedback` to return the full record**

`app/api.py:103-109`을 교체한다:

```python
_NO_FEEDBACK = {"ok": None, "fixed": None, "tag": None,
                "correction": None, "suggestion": None}


def _feedback(language: str, text: str) -> dict:
    """Structured grammar feedback for one learner line.

    Never raises. A model hiccup must not cost the learner their turn -- the
    conversation continues and the message is stored without feedback.
    """
    try:
        result = llm.chat_json(prompts.build_feedback_messages(language, text),
                               prompts.feedback_schema(language))
    except Exception:
        return dict(_NO_FEEDBACK)
    ok = result.get("ok")
    return {
        "ok": None if ok is None else bool(ok),
        "fixed": result.get("fixed"),
        "tag": result.get("tag"),
        "correction": result.get("correction"),
        "suggestion": result.get("suggestion"),
    }
```

- [ ] **Step 4: Thread it through `chat_turn`**

`app/api.py`에서 현재 이 두 줄을

```python
    correction, suggestion = _feedback(language, text)
    db.add_message(payload.session_id, "user", text, correction, suggestion)
```

아래로 바꾼다:

```python
    feedback = _feedback(language, text)
    db.add_message(payload.session_id, "user", text,
                   correction=feedback["correction"],
                   suggestion=feedback["suggestion"],
                   ok=feedback["ok"], fixed=feedback["fixed"], tag=feedback["tag"])
```

그리고 같은 함수의 `return` 블록을 바꾼다:

```python
    return {
        "turn": turns_used + 1,
        "bot_reply": reply,
        "audio_key": _speak(reply, language),
        **feedback,
    }
```

- [ ] **Step 5: Run the full suite**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine" -v`
Expected: PASS — 전부 통과. `test_api_report.py`와 `test_api_config.py`도 깨지지 않아야 한다.

- [ ] **Step 6: Commit**

```bash
git add app/api.py tests/test_api_chat.py
git commit -m "feat: return and store ok/fixed/tag from the chat endpoint"
```

---

### Task 5: 피드백 품질 회귀 테스트 (engine 마커)

스파이크에서 쓴 채점 세트를 저장소로 옮긴다. 프롬프트를 나중에 고칠 때 품질이 떨어지는 것을 잡는 그물이다. 실제 모델을 부르므로 `-m engine`으로만 돈다.

**Files:**
- Create: `tests/test_feedback_quality.py`

**Interfaces:**
- Consumes: `prompts.build_feedback_messages`, `prompts.feedback_schema`, `llm.chat_json` (Task 3)
- Produces: 없음 (테스트 전용)

- [ ] **Step 1: Write the test**

```python
"""Feedback quality against the real model. Runs only under `-m engine`.

These are threshold tests, not exact-match tests: the model is sampled, so a
single wrong tag is not a regression. The thresholds are set below what the
spike measured (en 10/10 Korean, 8/10 tag; ja 8/8 both) so normal variance
does not fail the build, but a prompt regression does.
"""
import re

import pytest

from app import llm, prompts

pytestmark = pytest.mark.engine

CASES = [
    ("en", "I go store yesterday.", False, "시제"),
    ("en", "She have two cat.", False, "단복수"),
    ("en", "I am interested on music.", False, "전치사"),
    ("en", "Yesterday I to the park went.", False, "어순"),
    ("en", "I want to buy car.", False, "관사"),
    ("en", "My father is a doctor.", True, "없음"),
    ("en", "Could you tell me where the station is?", True, "없음"),
    ("ja", "きのう、レストランに行きます。", False, "시제"),
    ("ja", "わたしは学校で行きます。", False, "조사"),
    ("ja", "毎日ジムに行くします。", False, "활용"),
    ("ja", "友達と映画を見ました。", True, "없음"),
    ("ja", "すみません、駅はどこですか。", True, "없음"),
]


def _hangul(text):
    return len(re.findall(r"[가-힣]", text or ""))


def _ask(language, sentence):
    return llm.chat_json(prompts.build_feedback_messages(language, sentence),
                         prompts.feedback_schema(language))


@pytest.fixture(scope="module")
def results():
    return [(lang, text, exp_ok, exp_tag, _ask(lang, text))
            for lang, text, exp_ok, exp_tag in CASES]


def test_explanations_are_written_in_korean(results):
    """The bug that motivated this file: English corrections in the database.
    Quoted target-language examples inflate the Latin count, so count Hangul
    rather than comparing alphabets."""
    bad = [text for _, text, _, _, out in results
           if _hangul(out["correction"]) < 8 or _hangul(out["suggestion"]) < 8]
    assert len(bad) <= 1, f"not Korean: {bad}"


def test_ok_flag_matches_whether_the_sentence_was_correct(results):
    wrong = [text for _, text, exp_ok, _, out in results if out["ok"] != exp_ok]
    assert len(wrong) <= 1, f"wrong ok: {wrong}"


def test_tags_are_mostly_right(results):
    wrong = [(text, out["tag"], exp) for _, text, _, exp, out in results
             if out["tag"] != exp]
    assert len(wrong) <= 3, f"wrong tags: {wrong}"


def test_fixed_is_a_real_sentence_not_an_explanation(results):
    """`fixed` feeds the re-speak button, so it must be the target-language
    sentence alone -- Korean prose in this field would be read aloud as the
    thing to repeat."""
    for _, text, _, _, out in results:
        assert out["fixed"], f"empty fixed for {text}"
        assert _hangul(out["fixed"]) == 0, f"Korean leaked into fixed for {text}"
```

- [ ] **Step 2: Run it against the real model**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_feedback_quality.py -m engine -v`
Expected: PASS (약 40초). Ollama가 떠 있어야 한다.

- [ ] **Step 3: Confirm it stays out of the default run**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine" -q`
Expected: `test_feedback_quality.py`가 deselect 되고 나머지는 통과

- [ ] **Step 4: Commit**

```bash
git add tests/test_feedback_quality.py
git commit -m "test: add engine-marked feedback quality thresholds"
```

---

### Task 6: 디자인 토큰 CSS

**Files:**
- Create: `static/css/tokens.css`, `static/css/base.css`, `static/css/components.css`
- Modify: `static/index.html:7` (스타일시트 링크)
- Delete: `static/style.css` (내용은 위 세 파일로 나뉜다)

**Interfaces:**
- Consumes: 없음
- Produces: CSS 커스텀 프로퍼티 (`--bg`, `--surface`, `--line`, `--accent`, `--correct`, `--suggest`, `--space-*`, `--text-*`) 와 컴포넌트 클래스 (`.btn`, `.btn-primary`, `.btn-ghost`, `.msg`, `.chip`, `.card`, `.panel`)

- [ ] **Step 1: Write `static/css/tokens.css`**

```css
/* Design tokens. Light first, with dark handled by redefining the same names --
   never define a colour only inside the dark block. */
:root {
  --bg: #fbfbfe;
  --surface: #ffffff;
  --surface-sunken: #f6f7fb;
  --line: #e6e7ef;
  --text: #1c1d26;
  --text-dim: #8a8c9e;
  --text-faint: #9a9cae;

  --accent: #4c5fd7;
  --accent-soft: #eef1fd;
  --accent-ink: #4453c4;

  /* Correction and suggestion are toned down on purpose: a learner sees these
     every single turn, and red/green reads as being told off. */
  --correct: #e8896b;
  --correct-bg: #fff5f2;
  --correct-ink: #6b3a2a;
  --suggest: #63b58a;
  --suggest-bg: #f2f8f5;
  --suggest-ink: #28503c;

  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px;

  --text-xs: 11px;  --text-sm: 12.5px; --text-base: 14px;
  --text-lg: 17px;  --text-xl: 21px;   --text-2xl: 25px;

  --radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;
  --shadow: 0 2px 8px rgba(30, 32, 60, .08);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14151c;
    --surface: #1c1e27;
    --surface-sunken: #191a22;
    --line: #2b2d3a;
    --text: #e8e9f0;
    --text-dim: #9698ab;
    --text-faint: #7b7d90;
    --accent: #7c8bea;
    --accent-soft: #232640;
    --accent-ink: #96a2f0;
    --correct-bg: #2a1e1a;
    --correct-ink: #f0b49c;
    --suggest-bg: #17251d;
    --suggest-ink: #9ad7b7;
    --shadow: 0 2px 8px rgba(0, 0, 0, .4);
  }
}
```

- [ ] **Step 2: Write `static/css/base.css`**

```css
/* Author rules like `label { display: block }` outrank the UA's [hidden] rule,
   so hidden must be reasserted or toggling it in JS does nothing. */
[hidden] { display: none !important; }
* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0 var(--space-6) var(--space-8);
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: var(--text-base);
  line-height: 1.55;
}

main { max-width: 900px; margin: 0 auto; }

h1 { font-size: var(--text-lg); margin: 0; letter-spacing: -.3px; }
h2 { font-size: var(--text-base); margin: 0 0 var(--space-3); letter-spacing: -.2px; }

.label {
  font-size: 9px; text-transform: uppercase; letter-spacing: .7px;
  color: var(--text-faint); font-weight: 700; margin: 0 0 var(--space-2);
}
.hint { color: var(--text-dim); font-weight: normal; }
```

- [ ] **Step 3: Write `static/css/components.css`**

`static/style.css`에 있던 나머지 규칙을 토큰을 쓰도록 옮긴다:

```css
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-4) 0; border-bottom: 1px solid var(--line);
  margin-bottom: var(--space-5);
}
.status { display: flex; align-items: center; gap: var(--space-3); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-faint); }
.dot.up { background: #2a9d5c; }
.dot.down { background: #c0392b; }

.row { display: flex; gap: var(--space-4); }
label { display: block; margin-bottom: var(--space-3); font-size: var(--text-sm); }

select, input[type=text] {
  display: block; width: 100%; margin-top: var(--space-1);
  padding: var(--space-2) var(--space-3); font: inherit;
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  background: var(--surface); color: inherit;
}
select:focus-visible, input[type=text]:focus-visible, button:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

button {
  font: inherit; padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm); cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: inherit;
}
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.primary:hover:not(:disabled) { background: var(--accent-ink); }
button.ghost { background: transparent; color: var(--text-dim); }
button:disabled { opacity: .45; cursor: not-allowed; }

#conversation { margin: var(--space-5) 0; min-height: 160px; }
.msg {
  margin-bottom: var(--space-3); padding: var(--space-2) var(--space-3);
  border-radius: var(--radius); max-width: 78%;
}
.msg.bot { background: var(--surface-sunken); border-bottom-left-radius: var(--space-1); }
.msg.user {
  background: var(--accent-soft); margin-left: auto;
  border-bottom-right-radius: var(--space-1);
}

#controls { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
#controls input { flex: 1; min-width: 220px; margin-top: 0; }

#feedback {
  margin-top: var(--space-6); border-top: 1px solid var(--line);
  padding-top: var(--space-4);
}
.fb {
  border-left: 2px solid var(--accent); padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-3); background: var(--surface-sunken);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: var(--text-sm);
}
.fb .said { color: var(--text-dim); font-style: italic; margin-bottom: var(--space-1); }
.fb .label { display: inline; }

.notice {
  background: var(--correct-bg); color: var(--correct-ink);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

#script-lines li { padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); }
#script-lines li.current { background: var(--accent-soft); font-weight: 600; }
#script-lines li.done { opacity: .5; }

#report-body {
  white-space: pre-wrap; font: inherit; background: var(--surface);
  border: 1px solid var(--line); padding: var(--space-4);
  border-radius: var(--radius);
}

dialog {
  border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: var(--space-6); min-width: 320px;
  background: var(--surface); color: var(--text); box-shadow: var(--shadow);
}
dialog::backdrop { background: rgba(20, 21, 28, .45); }
.voice { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-1) 0; }
.voice label { margin: 0; flex: 1; }
```

- [ ] **Step 4: Point index.html at the new files**

`static/index.html:7`의 한 줄을 세 줄로 바꾼다:

```html
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/components.css">
```

- [ ] **Step 5: Delete the old stylesheet**

```bash
git rm static/style.css
```

- [ ] **Step 6: Verify in the browser**

서버를 재시작하고 `http://127.0.0.1:8000`을 **Ctrl+Shift+R**로 하드 리로드한다 (README의 캐시 주의사항).

```powershell
.\venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```

확인할 것:
- 화면이 스타일 없는 상태로 무너지지 않는다 (CSS 경로 오타 시 그렇게 된다)
- 시작 → 대화 한 턴 → 세션 끝내기가 이전과 똑같이 동작한다
- 설정 다이얼로그가 열리고 음성 목록이 보인다
- OS를 다크 모드로 바꿔도 글자가 읽힌다

- [ ] **Step 7: Commit**

```bash
git add static/css static/index.html
git commit -m "refactor: split the stylesheet into design tokens, base, and components"
```

---

### Task 7: `app.js`를 ES 모듈로 분리

**동작을 바꾸지 않는 순수 이동이다.** 화면과 상태 머신은 B단계에서 올라간다. 지금 파일을 쪼개두면 B가 거대한 단일 파일을 고치지 않아도 된다.

**Files:**
- Create: `static/js/api.js`, `static/js/audio.js`, `static/js/session.js`, `static/js/settings.js`, `static/js/main.js`
- Modify: `static/index.html` (마지막 `<script>` 줄)
- Delete: `static/app.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `api.js` → `$`, `api`, `getJSON`, `postJSON`, **`state`**
  - `audio.js` → `play`, `speakInBrowser`, `recognition`, `startRecording`, `stopRecording`, `BCP47`
  - `session.js` → `notify`, `refreshHealth`, `loadScenarios`, `startSession`, `sendTurn`, `nextScriptLine`, `endSession`, `addMessage`, `addFeedback`, `uploadPendingRecording`
  - `settings.js` → `renderVoiceList`, `previewVoice`
  - `main.js` → 진입점, export 없음

`state`가 `session.js`가 아니라 `api.js`에 있는 것은 순환 참조를 피하기 위해서다 — `audio.js`의 `speakInBrowser`가 `state.language`를 읽는데, `state`를 `session.js`에 두면 `session.js → audio.js → session.js`가 된다.

- [ ] **Step 1: Move code into the modules**

`static/app.js`를 열고 아래 표대로 **함수를 있는 그대로** 옮긴다. 본문은 고치지 않는다 — 이 태스크에서 바뀌는 것은 `export` / `import` 줄뿐이다.

| 목적지 | 옮길 것 (현재 `app.js` 기준) |
|---|---|
| `js/api.js` | `$`, `api`, `getJSON`, `postJSON` |
| `js/audio.js` | `BCP47`, `play`, `speakInBrowser`, `setupRecognition`, `recognition`, `startRecording`, `stopRecording` |
| `js/session.js` | `state`, `refreshHealth`, `notify`, `loadScenarios`, `startSession`, `addMessage`, `addFeedback`, `sendTurn`, `startScript`, `advanceScript`, `nextScriptLine`, `uploadPendingRecording`, `endSession` |
| `js/settings.js` | `currentPreviewAudio`, `currentPreviewUrl`, `renderVoiceList`, `previewVoice` |
| `js/main.js` | 파일 하단의 `addEventListener` 배선 전부 + 최초 호출 `loadScenarios()` / `refreshHealth()` |

각 파일 맨 위에 `'use strict';`는 넣지 않는다 — ES 모듈은 항상 strict다.

필요한 import 줄:

```javascript
// js/audio.js
import { $, state } from './api.js';

// js/session.js
import { $, api, getJSON, postJSON, state } from './api.js';
import { play, startRecording, stopRecording } from './audio.js';

// js/settings.js
import { $, api, getJSON, postJSON } from './api.js';
import { notify } from './session.js';

// js/main.js
import { $, state } from './api.js';
import { recognition, BCP47, startRecording } from './audio.js';
import { notify, refreshHealth, loadScenarios, startSession,
         sendTurn, nextScriptLine, endSession } from './session.js';
import { renderVoiceList, previewVoice } from './settings.js';
```

`state`는 `session.js`가 아니라 `api.js` 하단에 둔다:

```javascript
// js/api.js 하단
export const state = {
  sessionId: null,
  language: 'en',
  mode: 'free',
  scriptLines: [],
  scriptIndex: 0,
  recorder: null,
  chunks: [],
  busy: false, // re-entrancy guard: blocks a second sendTurn/nextScriptLine while one is in flight
};
```

- [ ] **Step 2: Switch index.html to a module entry point**

`static/index.html`의 마지막 스크립트 줄을 바꾼다:

```html
<script type="module" src="/js/main.js"></script>
```

- [ ] **Step 3: Delete the old file**

```bash
git rm static/app.js
```

- [ ] **Step 4: Verify every path still works in the browser**

서버 재시작 후 **Ctrl+Shift+R**. DevTools 콘솔을 열어두고 확인한다 — 모듈 해석 실패는 콘솔에만 나오고 화면은 조용히 죽는다.

- [ ] 콘솔에 에러가 없다
- [ ] 언어/모드를 바꾸면 시나리오 목록이 갱신된다
- [ ] 자유 모드: 시작 → 봇 인사말이 들린다 → 텍스트 입력 후 보내기 → 봇이 답한다 → 피드백이 아래 쌓인다
- [ ] 스크립트 모드: 시작 → 대본이 보인다 → 다음 버튼으로 진행된다
- [ ] 🎤 버튼이 음성인식을 시작하고 결과가 입력창에 들어간다
- [ ] 세션 끝내기 → 리포트가 나온다
- [ ] 설정 → 음성 목록 → 미리듣기가 재생된다
- [ ] 헤더의 상태 점 두 개가 초록이다

- [ ] **Step 5: Commit**

```bash
git add static/js static/index.html
git commit -m "refactor: split app.js into ES modules

Behaviour-preserving move. Phase 2B adds screens and a state machine on
top; splitting first means that work does not land in one 13KB file.
state lives in api.js so audio.js can read state.language without a
cycle through session.js."
```

---

### Task 8: 화면 라우터

B·C·D단계가 화면을 등록할 자리를 만든다. A단계에서는 지금 있는 화면 두 개(설정 화면, 세션 화면)만 등록한다.

**Files:**
- Create: `static/js/router.js`
- Modify: `static/js/session.js` (직접 `hidden` 토글하던 곳), `static/js/main.js`
- Test: 없음. 라우터는 DOM을 직접 만지므로 자동 테스트에 하네스가 필요한데, 로직이 열 줄이라 아직 값어치가 없다. Step 4의 수동 확인으로 검증한다. B단계에서 상태 머신을 순수 함수로 뽑을 때 그 하네스를 함께 만든다.

**Interfaces:**
- Consumes: `$` (`api.js`)
- Produces:
  - `router.register(name, elementId) -> void`
  - `router.show(name) -> void` — 등록된 화면 중 하나만 보이게 한다
  - `router.current() -> string | null`

- [ ] **Step 1: Write `static/js/router.js`**

```javascript
import { $ } from './api.js';

/* One screen visible at a time. Screens register themselves rather than the
   router knowing the list, so Phase 2C and 2D can add home and mypage without
   editing this file. */
const screens = new Map();
let active = null;

export function register(name, elementId) {
  screens.set(name, elementId);
}

export function current() {
  return active;
}

export function show(name) {
  if (!screens.has(name)) throw new Error(`unknown screen: ${name}`);
  for (const [screen, id] of screens) {
    const el = $(id);
    if (el) el.hidden = screen !== name;
  }
  active = name;
}
```

- [ ] **Step 2: Register the existing screens in `main.js`**

`main.js`의 import 목록에 추가하고, 최초 호출부 위에 등록을 넣는다:

```javascript
import * as router from './router.js';

router.register('setup', 'setup');
router.register('session', 'session');
router.register('report', 'report');
router.show('setup');
```

- [ ] **Step 3: Replace direct `hidden` toggles in `session.js`**

`session.js`에서 화면 전환에 해당하는 세 곳을 라우터 호출로 바꾼다. **`#feedback`, `#script-panel`, `#btn-next` 같은 화면 *안쪽* 요소의 `hidden`은 그대로 둔다** — 라우터는 화면 단위만 다룬다.

`startSession` 안:
```javascript
    // 이전:  $('setup').hidden = true;  $('session').hidden = false;
    router.show('session');
    $('feedback').hidden = false;
```

`endSession` 안:
```javascript
    // 이전:  $('session').hidden = true;  $('report').hidden = false;
    router.show('report');
```

`session.js` 상단에 `import * as router from './router.js';`를 추가한다.

- [ ] **Step 4: Verify in the browser**

서버 재시작, **Ctrl+Shift+R**. 확인할 것:

- [ ] 첫 화면에 설정 폼만 보인다 (세션/리포트는 안 보인다)
- [ ] 시작을 누르면 설정 폼이 사라지고 대화 화면만 보인다
- [ ] 세션 끝내기를 누르면 대화 화면이 사라지고 리포트만 보인다
- [ ] 「새 세션」을 누르면 페이지가 새로고침되고 설정 폼으로 돌아간다
- [ ] 콘솔에 에러가 없다

- [ ] **Step 5: Commit**

```bash
git add static/js/router.js static/js/main.js static/js/session.js
git commit -m "feat: add a screen router

Screens register themselves so 2C and 2D can add home and mypage without
touching the router. Only whole screens go through it -- panels inside a
screen keep toggling hidden directly."
```

---

## A단계 완료 확인

모든 태스크가 끝난 뒤 아래를 순서대로 실행한다.

- [ ] **전체 테스트**

```powershell
.\venv\Scripts\python.exe -m pytest -m "not engine" -v
.\venv\Scripts\python.exe -m pytest -m engine -v
```
둘 다 통과해야 한다.

- [ ] **실제 DB가 마이그레이션됐는지**

```powershell
.\venv\Scripts\python.exe -c "from app import db; print(db.schema_version())"
```
`2`가 나와야 한다.

- [ ] **한국어 교정이 실제로 저장되는지** — 이것이 A단계의 진짜 목표다

서버를 띄우고 브라우저에서 영어 자유 세션을 하나 시작해, 일부러 틀린 문장을 하나 말한다 (예: `I go store yesterday.`). 그다음:

```powershell
.\venv\Scripts\python.exe -c "import sqlite3; c=sqlite3.connect('monologue.db'); c.row_factory=sqlite3.Row; r=[dict(x) for x in c.execute('SELECT text,ok,tag,fixed,correction FROM messages WHERE speaker=\"user\" ORDER BY id DESC LIMIT 1')][0]; [print(k,':',v) for k,v in r.items()]"
```

기대: `ok`가 0, `tag`가 `시제`, `fixed`가 영어 문장 하나, `correction`이 **한국어**.

- [ ] **README에 마이그레이션 한 줄 추가**

`README.md`의 「개발 중 주의」 절에 덧붙인다:

```markdown
`app/db.py`의 `SCHEMA`를 고쳐도 기존 DB에는 반영되지 않습니다. 컬럼을 추가할
때는 `MIGRATIONS`에 단계를 **덧붙이세요** — 이미 적용된 단계를 수정하면 DB마다
스키마가 갈립니다.
```

```bash
git add README.md
git commit -m "docs: note the migration rule in the development gotchas"
```

---

## 다음 단계

A단계가 끝나면 **B단계(세션 화면)** 계획을 따로 쓴다. B는 이 단계에서 만든 `ok` / `fixed` / `tag`를 읽어 교정 칩과 재발화를 구현하고, `state.busy` 불리언을 상태 머신으로 교체한다.

A단계가 도는 동안 실제로 연습을 하면 태그가 쌓이므로, D단계(마이페이지)에 도달했을 때 화면이 비어 있지 않다.
