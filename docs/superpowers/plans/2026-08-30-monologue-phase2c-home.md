# Phase 2C — 홈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱을 열었을 때 "2개 중 고르세요"가 아니라 "오늘 뭘 연습할까요?"가 되게 한다.

**Architecture:** 시나리오 카탈로그가 읽기 전용 JSON에서 JSON + DB 합집합이 된다. 홈의 자유 입력창에 카탈로그에 없는 것을 치면 로컬 모델이 시나리오를 만들어 `user_scenarios`에 넣는다. 끝나지 않은 세션을 이어서 할 수 있게 되고, 봇이 학습자보다 한 걸음 어렵게 말하도록 프롬프트에 i+1을 넣는다.

**Tech Stack:** Python 3.13, FastAPI, SQLite, pytest, Ollama(`qwen2.5:14b`), Node 내장 테스트 러너, 빌드 도구 없는 ES 모듈 + 순수 CSS

**Spec:** `docs/superpowers/specs/2026-08-29-monologue-phase2-design.md`

## Global Constraints

- **시나리오 select를 없앤다.** "2개 중 고르세요"와 "뭐든 만들어 드립니다"는 한 화면에 공존할 수 없다.
- **기본 카탈로그 `data/scenarios.json`은 읽기 전용으로 남는다.** 생성된 시나리오는 `user_scenarios` 테이블로 간다. 카탈로그는 `@lru_cache`가 걸린 파일이라, 여기에 쓰기를 섞으면 캐시 무효화와 파일 쓰기 경쟁을 직접 다뤄야 한다.
- **생성된 시나리오는 저장 전에 기존 `scenarios._validate()`를 통과해야 한다.** 로컬 14b가 만든 것을 검증 없이 넣으면 세션 시작 시점에 터진다.
- **프롬프트는 한국어로 쓴다.** Phase 2A와 2B에서 두 번 확인된 규칙이다 — 영어로 "한국어로 답하라"고 지시하면 영어가 나온다.
- **레벨은 누적으로 계산한다.** 단일 세션 판정은 노이즈다: 같은 입력 세 번에 beginner/intermediate/advanced가 나왔고, 실제 DB에서도 같은 시나리오 1턴짜리 세션 넷이 beginner→intermediate→intermediate→beginner였다. i+1이 그 값을 쓰면 봇의 난이도가 무작위로 널뛴다.
- 마이그레이션은 **덧붙이기만** 한다. 이미 적용된 단계를 수정하지 않는다.
- 모델 출력과 학습자 텍스트는 `textContent`로만 DOM에 넣는다. `innerHTML` 금지.
- 빌드 도구 없음. 상대 경로 `./x.js`에 `.js` 확장자 포함. import 그래프 비순환, `audio.js`는 `session.js`를 import하지 않는다.
- 색은 기존 토큰에서. 새 색이 필요하면 라이트 `:root`와 다크 블록 **양쪽에** 토큰으로 정의한다.
- 프론트엔드 테스트: `node --test 'static/js/*.test.js'` — 글롭을 따옴표로 감싼다. node가 직접 전개하므로 PowerShell과 bash 양쪽에서 같은 명령이 동작한다. 기준선 18개.
- 파이썬 테스트: `.\venv\Scripts\python.exe -m pytest -m "not engine"` — 전체 스위트. 기준선 160 passed / 8 deselected.
- 프롬프트를 건드리면 `.\venv\Scripts\python.exe -m pytest tests/test_feedback_quality.py -m engine`도 돌린다.
- 커밋 프리픽스: `feat:` / `fix:` / `docs:` / `refactor:` / `test:`

## Phase 2A·2B가 남긴 것 — 이 계획이 딛고 서는 바닥

- `db.MIGRATIONS`는 v2까지. 새 단계는 인덱스 2로 덧붙인다.
- `db.session_stats(session_id)` → `{turns, wrong, ungraded, tags, sentences}`.
- `db.stale_open_sessions(hours=24)` — 마지막 활동 기준, 아직 녹음이 남은 세션만.
- `db.latest_level(language)` — 가장 최근 종료 세션의 레벨. **노이즈다. Task 3이 대체한다.**
- `prompts.build_system_prompt(mode, language, *, scenario, topic, level, turns_used)` — 이미 `level`을 받아 "Pitch everything to that level"로 쓴다.
- `scenarios.scenarios_for(language, mode)` / `get_scenario(id)` / `_validate(item)`.
- 프론트엔드: `api.js`(공용), `audio.js`, `session.js`, `settings.js`, `router.js`, `main.js`, 순수 모듈 `match.js`/`turnstate.js`.
- `router.register(name, elementId)` / `show(name)` — 화면은 스스로 등록한다.

---

### Task 1: `user_scenarios` 테이블과 합쳐진 카탈로그

**Files:**
- Modify: `app/db.py` (MIGRATIONS, 함수 추가), `app/scenarios.py`
- Test: `tests/test_db.py`, `tests/test_scenarios.py`

**Interfaces:**
- Produces:
  - `db.add_user_scenario(item) -> None` — `item`은 `_validate`를 통과한 dict
  - `db.user_scenarios(language, kind=None) -> list[dict]` — 카탈로그와 같은 모양
  - `db.get_user_scenario(scenario_id) -> dict | None`
  - `db.touch_user_scenario(scenario_id) -> None` — `used_count += 1`
  - `scenarios.scenarios_for(language, mode=None)` — 카탈로그 + DB 합집합, DB가 먼저
  - `scenarios.get_scenario(id)` — 양쪽에서 찾는다

- [ ] **Step 1: Write the failing tests**

`tests/test_db.py`에 추가한다:

```python
FREE_SCENARIO = {
    "id": "user-interview-1", "language": "en", "type": "free",
    "title": "구직 면접", "goal": "경력을 설명하고 질문에 답한다",
    "persona_prompt": "You are a hiring manager.", "max_turns": 8,
}


def test_user_scenario_round_trips_in_the_catalogue_shape(store):
    store.add_user_scenario(FREE_SCENARIO)
    got = store.get_user_scenario("user-interview-1")
    assert got == {**FREE_SCENARIO, "lines": None, "used_count": 0}


def test_user_scenarios_are_filtered_by_language_and_kind(store):
    store.add_user_scenario(FREE_SCENARIO)
    store.add_user_scenario({**FREE_SCENARIO, "id": "user-ja-1", "language": "ja"})
    assert [s["id"] for s in store.user_scenarios("en")] == ["user-interview-1"]
    assert [s["id"] for s in store.user_scenarios("en", "script")] == []


def test_script_scenario_round_trips_its_lines(store):
    script = {"id": "user-standup-1", "language": "en", "type": "script",
              "title": "스탠드업", "goal": None,
              "lines": [{"speaker": "bot", "text": "Morning!"},
                        {"speaker": "user", "text": "Morning."}]}
    store.add_user_scenario(script)
    assert store.get_user_scenario("user-standup-1")["lines"] == script["lines"]


def test_touch_counts_uses(store):
    store.add_user_scenario(FREE_SCENARIO)
    store.touch_user_scenario("user-interview-1")
    store.touch_user_scenario("user-interview-1")
    assert store.get_user_scenario("user-interview-1")["used_count"] == 2
```

`tests/test_scenarios.py`에 추가한다:

```python
def test_generated_scenarios_join_the_catalogue_and_come_first(tmp_path, monkeypatch):
    """The learner's own scenarios are the ones they meant; the built-in
    catalogue is the fallback behind them."""
    monkeypatch.setattr(db.config, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    db.add_user_scenario({"id": "user-x", "language": "en", "type": "free",
                          "title": "구직 면접", "goal": "g",
                          "persona_prompt": "p", "max_turns": 8})

    ids = [s["id"] for s in scenarios.scenarios_for("en", "free")]
    assert ids[0] == "user-x"
    assert "restaurant-seating-en" in ids


def test_get_scenario_finds_a_generated_one(tmp_path, monkeypatch):
    monkeypatch.setattr(db.config, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    db.add_user_scenario({"id": "user-y", "language": "en", "type": "free",
                          "title": "t", "goal": "g", "persona_prompt": "p", "max_turns": 8})
    assert scenarios.get_scenario("user-y")["title"] == "t"
    assert scenarios.get_scenario("restaurant-seating-en")["language"] == "en"
    assert scenarios.get_scenario("nope") is None
```

`tests/test_scenarios.py` 상단에 `from app import db`를 추가한다.

- [ ] **Step 2: Run them and confirm they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_db.py tests/test_scenarios.py -k "user_scenario or generated or touch_counts" -v`
Expected: FAIL — `AttributeError: module 'app.db' has no attribute 'add_user_scenario'`

- [ ] **Step 3: Add the migration**

`app/db.py`의 `MIGRATIONS`에 인덱스 2를 덧붙인다:

```python
    # v2 -> v3: scenarios the learner asked for, generated by the model
    # (Phase 2C). data/scenarios.json stays read-only: it is behind an
    # lru_cache, so mixing writes into it would mean owning cache
    # invalidation and file-write races for no gain.
    ["""
    CREATE TABLE IF NOT EXISTS user_scenarios (
        id             TEXT PRIMARY KEY,
        language       TEXT    NOT NULL,
        type           TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        goal           TEXT,
        persona_prompt TEXT,
        max_turns      INTEGER,
        lines_json     TEXT,
        created_at     TEXT    NOT NULL,
        used_count     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_user_scenarios_language
        ON user_scenarios(language, type);
    """],
```

- [ ] **Step 4: Implement the db functions**

`app/db.py`에 추가한다:

```python
def _scenario_row(row) -> dict:
    """Return a generated scenario in the same shape data/scenarios.json uses,
    so callers cannot tell a generated one from a built-in one."""
    item = {
        "id": row["id"], "language": row["language"], "type": row["type"],
        "title": row["title"], "goal": row["goal"],
        "used_count": row["used_count"],
    }
    if row["type"] == "free":
        item["persona_prompt"] = row["persona_prompt"]
        item["max_turns"] = row["max_turns"]
        item["lines"] = None
    else:
        item["lines"] = json.loads(row["lines_json"]) if row["lines_json"] else None
        item["persona_prompt"] = row["persona_prompt"]
        item["max_turns"] = row["max_turns"]
    return item


def add_user_scenario(item) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO user_scenarios (id, language, type, title, goal,"
            " persona_prompt, max_turns, lines_json, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item["id"], item["language"], item["type"], item["title"],
             item.get("goal"), item.get("persona_prompt"), item.get("max_turns"),
             json.dumps(item["lines"], ensure_ascii=False) if item.get("lines") else None,
             _now()),
        )


def user_scenarios(language, kind=None) -> list[dict]:
    """Newest first: the thing the learner just asked for is the thing they
    are most likely to want again."""
    sql = "SELECT * FROM user_scenarios WHERE language = ?"
    args = [language]
    if kind is not None:
        sql += " AND type = ?"
        args.append(kind)
    sql += " ORDER BY created_at DESC, id DESC"
    with connect() as conn:
        return [_scenario_row(r) for r in conn.execute(sql, args)]


def get_user_scenario(scenario_id):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM user_scenarios WHERE id = ?", (scenario_id,)
        ).fetchone()
    return _scenario_row(row) if row else None


def touch_user_scenario(scenario_id) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE user_scenarios SET used_count = used_count + 1 WHERE id = ?",
            (scenario_id,),
        )
```

`app/db.py` 상단에 `import json`을 추가한다.

- [ ] **Step 5: Merge the two sources in `app/scenarios.py`**

```python
from app import config, db


def scenarios_for(language, mode=None) -> list[dict]:
    """Catalogue entries for a language, optionally narrowed to one type.

    Generated scenarios come first: the learner asked for those by name, while
    the built-in catalogue is what we offer when they have not.
    """
    items = [s for s in load_scenarios() if s["language"] == language]
    if mode is not None:
        items = [s for s in items if s["type"] == mode]
    return db.user_scenarios(language, mode) + items


def get_scenario(scenario_id):
    for s in load_scenarios():
        if s["id"] == scenario_id:
            return s
    return db.get_user_scenario(scenario_id)
```

`app/db.py`가 `app/scenarios.py`를 import하지 않는지 확인한다 — 순환이 된다.

- [ ] **Step 6: Run the full suite and commit**

```powershell
.\venv\Scripts\python.exe -m pytest -m "not engine"
```

```bash
git add app/db.py app/scenarios.py tests/
git commit -m "feat: let generated scenarios join the built-in catalogue"
```

---

### Task 2: 시나리오 생성 엔드포인트

**Files:**
- Modify: `app/prompts.py`, `app/api.py`
- Test: `tests/test_prompts.py`, `tests/test_api_config.py`

**Interfaces:**
- Produces:
  - `prompts.SCENARIO_SCHEMA(kind)` — `free`와 `script`가 다른 모양
  - `prompts.build_scenario_messages(language, kind, wish)` — 한국어 시스템 프롬프트
  - `POST /api/scenarios/generate` `{language, mode, wish}` → 저장된 시나리오

- [ ] **Step 1: Write the failing tests**

`tests/test_prompts.py`:

```python
def test_scenario_prompt_is_written_in_korean_and_carries_the_wish():
    msgs = prompts.build_scenario_messages("en", "free", "구직 면접")
    system, user = msgs[0]["content"], msgs[-1]["content"]
    hangul = sum(1 for ch in system if "가" <= ch <= "힣")
    assert hangul > 100, "scenario prompt is not Korean"
    assert "구직 면접" in user


def test_scenario_schema_differs_by_kind():
    free = prompts.scenario_schema("free")
    assert set(free["required"]) == {"title", "goal", "persona_prompt"}
    script = prompts.scenario_schema("script")
    assert "lines" in script["required"]
    assert script["properties"]["lines"]["type"] == "array"
```

`tests/test_api_config.py`:

```python
def test_generating_a_scenario_stores_it_and_returns_it(client, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json", lambda messages, schema, **kw: {
        "title": "구직 면접", "goal": "경력을 설명하고 질문에 답한다",
        "persona_prompt": "You are a hiring manager interviewing a candidate.",
    })
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "free", "wish": "구직 면접"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "구직 면접"
    assert body["id"].startswith("user-")

    listed = client.get("/api/scenarios?language=en&mode=free").json()["scenarios"]
    assert body["id"] in [s["id"] for s in listed]


def test_a_generated_scenario_that_fails_validation_is_rejected(client, monkeypatch):
    """A local 14b will sometimes return something unusable. Better a clear
    error than a row that explodes when the learner presses 시작."""
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"title": "", "goal": "", "persona_prompt": ""})
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "free", "wish": "구직 면접"})
    assert r.status_code == 422


def test_lesson_mode_cannot_generate_a_scenario(client):
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "lesson", "wish": "past tense"})
    assert r.status_code == 422
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_prompts.py tests/test_api_config.py -k "scenario" -v`

- [ ] **Step 3: Add the schema and prompt**

`app/prompts.py`:

```python
def scenario_schema(kind) -> dict:
    """What a generated scenario must contain. Ollama constrains generation to
    this shape, so the JSON always parses -- what it cannot enforce is that the
    persona is usable or the lines alternate, which is why scenarios._validate
    still runs before anything is stored."""
    if kind == "free":
        return {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "goal": {"type": "string"},
                "persona_prompt": {"type": "string"},
            },
            "required": ["title", "goal", "persona_prompt"],
        }
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "speaker": {"type": "string", "enum": ["bot", "user"]},
                        "text": {"type": "string"},
                    },
                    "required": ["speaker", "text"],
                },
            },
        },
        "required": ["title", "lines"],
    }


SCENARIO_SYSTEM_FREE = """당신은 한국인 학습자를 위한 {lang} 회화 연습 상황을 만드는 사람입니다.
당신이 쓰는 언어는 한국어입니다. {lang}은(는) 만들어 낼 대사와 페르소나에만 씁니다.

학습자가 연습하고 싶은 상황을 한 줄로 말했습니다. 그 상황을 실제로 굴러가게 할
설정을 만드세요.

- title: 학습자가 목록에서 알아볼 수 있는 짧은 한국어 제목
- goal: 이 대화에서 학습자가 해내야 할 일. 한국어 한 문장.
        "영어를 연습한다" 같은 막연한 것 말고, "창가 자리를 요청하고 안내받는다"처럼
        끝났는지 아닌지 판별할 수 있는 것으로 씁니다
- persona_prompt: 봇이 연기할 상대의 지시문. **{lang}으로 씁니다.** 누구인지, 어떤
        태도인지, 대화를 어떻게 시작하는지를 담습니다. 학습자가 아니라 상대를
        묘사합니다

상대는 학습자를 가르치지 않습니다. 그 상황에 실제로 있을 법한 사람으로 행동합니다."""


SCENARIO_SYSTEM_SCRIPT = """당신은 한국인 학습자를 위한 {lang} 회화 대본을 만드는 사람입니다.
당신이 쓰는 언어는 한국어입니다. 대본의 대사는 {lang}으로 씁니다.

학습자가 연습하고 싶은 상황을 한 줄로 말했습니다. 그 상황의 짧은 대본을 만드세요.

- title: 학습자가 목록에서 알아볼 수 있는 짧은 한국어 제목
- lines: 대사 8줄. speaker는 "bot"과 "user"가 번갈아 나오고 **bot으로 시작합니다.**
        text는 {lang}으로, 실제 대화에서 쓰는 짧은 구어체로 씁니다.
        교과서 문장이 아니라 사람이 실제로 하는 말이어야 합니다"""


def build_scenario_messages(language, kind, wish) -> list[dict]:
    """Ask the model for a scenario the learner asked for by name.

    Korean system prompt for the same reason every other prompt here is: asking
    for Korean in English produced English, twice, and moving the instruction
    itself into Korean is what fixed it.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    template = SCENARIO_SYSTEM_FREE if kind == "free" else SCENARIO_SYSTEM_SCRIPT
    system = template.format(lang=language_name)
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"학습자가 연습하고 싶다고 한 것: {wish}"},
    ]
```

- [ ] **Step 4: Add the route**

`app/api.py`:

```python
class ScenarioWish(BaseModel):
    language: Language
    mode: Mode
    wish: str


@router.post("/scenarios/generate")
def generate_scenario(payload: ScenarioWish):
    """Turn one line from the learner into a scenario they can practise.

    Lesson mode has no scenario -- its `topic` goes straight into the system
    prompt -- so asking for one is a mistake worth naming rather than silently
    producing something unused.
    """
    if payload.mode not in ("free", "script"):
        raise HTTPException(422, "only free and script modes have scenarios")
    wish = payload.wish.strip()
    if not wish:
        raise HTTPException(422, "wish is empty")

    try:
        result = llm.chat_json(
            prompts.build_scenario_messages(payload.language, payload.mode, wish),
            prompts.scenario_schema(payload.mode),
        )
    except Exception:
        raise HTTPException(503, "상황을 만들지 못했습니다. 잠시 뒤에 다시 시도해 주세요.")

    item = {
        "id": f"user-{uuid.uuid4().hex[:12]}",
        "language": payload.language,
        "type": payload.mode,
        "title": (result.get("title") or wish).strip(),
        "goal": (result.get("goal") or "").strip() or None,
    }
    if payload.mode == "free":
        item["persona_prompt"] = (result.get("persona_prompt") or "").strip()
        item["max_turns"] = config.DEFAULT_MAX_TURNS
    else:
        item["lines"] = result.get("lines") or []

    # A local 14b will sometimes return something unusable. Validating here means
    # a bad generation is a clear error now, not a crash when the learner
    # presses 시작.
    try:
        scenarios.validate_item(item)
    except scenarios.ScenarioError as exc:
        raise HTTPException(422, f"만들어진 상황이 올바르지 않습니다: {exc}")

    db.add_user_scenario(item)
    return {"id": item["id"], "title": item["title"], "type": item["type"],
            "goal": item.get("goal")}
```

`app/api.py`에 `import uuid`를 추가한다. `app/scenarios.py`의 `_validate`를 `validate_item`으로 공개한다 (기존 호출부도 함께 고친다) — 사설 이름을 다른 모듈에서 부르는 것보다 낫다.

- [ ] **Step 5: Run both suites and commit**

```powershell
.\venv\Scripts\python.exe -m pytest -m "not engine"
.\venv\Scripts\python.exe -m pytest tests/test_feedback_quality.py -m engine
```

```bash
git add app/prompts.py app/api.py app/scenarios.py tests/
git commit -m "feat: generate a scenario from one line the learner types"
```

---

### Task 3: 누적 레벨과 i+1

**Files:**
- Modify: `app/db.py`, `app/prompts.py`, `app/api.py`
- Test: `tests/test_db.py`, `tests/test_prompts.py`

**Interfaces:**
- Produces:
  - `db.stable_level(language, recent=5, min_sessions=3) -> str | None` — 표본이 모자라면 `None`
  - `build_system_prompt`의 `level`이 `stable_level`에서 오고, 프롬프트가 i+1을 지시

- [ ] **Step 1: Write the failing tests**

`tests/test_db.py`:

```python
def _finished(store, language, level):
    sid = store.create_session(language, "free")
    store.end_session(sid, "r", level)
    return sid


def test_stable_level_needs_a_minimum_sample(store):
    """A single session of a few sentences cannot support a verdict. The real
    database showed four consecutive one-turn sessions on the same scenario
    recorded beginner, intermediate, intermediate, beginner."""
    _finished(store, "en", "advanced")
    _finished(store, "en", "advanced")
    assert store.stable_level("en") is None


def test_stable_level_is_the_mode_of_recent_sessions(store):
    for level in ["beginner", "intermediate", "beginner", "beginner"]:
        _finished(store, "en", level)
    assert store.stable_level("en") == "beginner"


def test_stable_level_only_looks_at_the_recent_window(store):
    for level in ["beginner", "beginner", "beginner"]:
        _finished(store, "en", level)
    for level in ["advanced", "advanced", "advanced", "advanced", "advanced"]:
        _finished(store, "en", level)
    assert store.stable_level("en", recent=5) == "advanced"


def test_stable_level_ignores_the_other_language(store):
    for level in ["advanced", "advanced", "advanced"]:
        _finished(store, "ja", level)
    assert store.stable_level("en") is None
```

`tests/test_prompts.py`:

```python
def test_the_bot_is_told_to_pitch_slightly_above_the_learner():
    """i+1: comprehensible input works when it sits a step beyond what the
    learner can already produce, not level with it."""
    text = prompts.build_system_prompt("free", "en", level="intermediate",
                                       scenario={"persona_prompt": "p", "goal": "g",
                                                 "max_turns": 8})
    assert "intermediate" in text
    assert "step above" in text.lower()
```

- [ ] **Step 2: Run them and confirm they fail**

- [ ] **Step 3: Implement `db.stable_level`**

```python
def stable_level(language, recent=5, min_sessions=3):
    """The learner's level, judged over several sessions rather than one.

    A per-session estimate is noise: the same transcript run three times
    through the model produced beginner, intermediate and advanced, and the
    real database holds four consecutive one-turn sessions on one scenario
    recorded beginner, intermediate, intermediate, beginner. Anything that
    changes how the bot teaches -- i+1 pitching, and the level Phase D shows --
    has to read a stable value or it swings at random.

    Returns None when the sample is too thin to say anything, which callers
    must handle rather than defaulting silently.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT level FROM sessions"
            " WHERE language = ? AND ended_at IS NOT NULL AND level IS NOT NULL"
            " ORDER BY ended_at DESC LIMIT ?",
            (language, recent),
        ).fetchall()
    levels = [r["level"] for r in rows]
    if len(levels) < min_sessions:
        return None
    return max(set(levels), key=levels.count)
```

- [ ] **Step 4: Add i+1 to the system prompt**

`app/prompts.py`에서 레벨을 언급하는 줄(현재 "The student's current level is {level}. Pitch everything to that level.")을 바꾼다:

```
The student's current level is {level}. Pitch your own speech a small step
above it -- a little longer, a little richer -- so there is something new to
pick up, while staying comprehensible. Do not drop to their level, and do not
leap past it.
```

- [ ] **Step 5: Use it in `app/api.py`**

`chat_turn`과 `start_session`이 `db.latest_level(...)`을 쓰는 곳을 바꾼다:

```python
    level=db.stable_level(session["language"]) or "beginner",
```

`latest_level`은 남겨둔다 — 기존 테스트가 쓰고 있고, 지우는 것은 이 태스크의 범위가 아니다. 다만 docstring에 `stable_level`을 가리키는 한 줄을 더한다.

- [ ] **Step 6: Run both suites and commit**

```bash
git add app/db.py app/prompts.py app/api.py tests/
git commit -m "feat: pitch the bot a step above a level judged over several sessions"
```

---

### Task 4: 이어서 하기와 유령 세션 정리

**Files:**
- Modify: `app/db.py`, `app/api.py`
- Test: `tests/test_db.py`, `tests/test_api_chat.py`

**Interfaces:**
- Produces:
  - `db.resumable_session(language) -> dict | None` — 가장 최근의 안 끝난 세션, 24시간 이내
  - `db.abandon_stale_sessions(hours=24) -> int` — `ended_at`을 찍어 목록에서 치운다
  - `GET /api/sessions/resumable?language=en` → `{session: {...} | null}`

- [ ] **Step 1: Write the failing tests**

```python
def test_resumable_session_offers_only_the_most_recent_unfinished_one(store):
    old = store.create_session("en", "free", scenario_id="airport-checkin-en")
    store.add_message(old, "user", "hi")
    new = store.create_session("en", "free", scenario_id="restaurant-seating-en")
    store.add_message(new, "user", "hello")
    assert store.resumable_session("en")["id"] == new


def test_a_finished_session_is_not_resumable(store):
    sid = store.create_session("en", "free")
    store.end_session(sid, "r", "beginner")
    assert store.resumable_session("en") is None


def test_a_session_with_no_messages_is_not_worth_resuming(store):
    """Pressing 시작 and closing the tab leaves one of these. There is nothing
    to come back to."""
    store.create_session("en", "free")
    assert store.resumable_session("en") is None


def test_abandon_stale_sessions_closes_them_and_they_stop_being_offered(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "hi")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00+00:00'")
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'")
    assert store.abandon_stale_sessions(hours=24) == 1
    assert store.resumable_session("en") is None
    assert store.get_session(sid)["ended_at"] is not None
```

- [ ] **Step 2: Run them and confirm they fail**

- [ ] **Step 3: Implement**

```python
def resumable_session(language):
    """The session the learner would want to come back to, if any.

    Only one is offered even when several are open: a list of half-finished
    conversations is a chore, not a feature. Sessions with no messages are
    skipped -- pressing 시작 and closing the tab leaves one of those, and there
    is nothing in it to resume.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    with connect() as conn:
        row = conn.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS turns"
            " FROM sessions s"
            " WHERE s.language = ? AND s.ended_at IS NULL AND s.started_at >= ?"
            "   AND EXISTS (SELECT 1 FROM messages m2 WHERE m2.session_id = s.id)"
            " ORDER BY s.id DESC LIMIT 1",
            (language, cutoff),
        ).fetchone()
    return dict(row) if row else None


def abandon_stale_sessions(hours=24) -> int:
    """Close sessions nobody came back to, so they stop being offered and stop
    being swept for recordings on every /end."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    with connect() as conn:
        cur = conn.execute(
            "UPDATE sessions SET ended_at = ?"
            " WHERE ended_at IS NULL"
            "   AND COALESCE((SELECT MAX(m.created_at) FROM messages m"
            "                 WHERE m.session_id = sessions.id), started_at) < ?",
            (_now(), cutoff),
        )
        return cur.rowcount
```

- [ ] **Step 4: Add the route**

```python
@router.get("/sessions/resumable")
def resumable(language: Language):
    """Offer the session the learner walked away from, and clear out the ones
    they are never coming back to while we are here."""
    db.abandon_stale_sessions()
    session = db.resumable_session(language)
    if session is None:
        return {"session": None}
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    return {"session": {
        "id": session["id"], "mode": session["mode"], "turns": session["turns"],
        "title": scenario["title"] if scenario else (session["topic"] or "수업"),
    }}
```

**주의**: 이 라우트는 `/sessions/{session_id}` 보다 **먼저** 등록되어야 한다. FastAPI는 등록 순서대로 매칭하므로, 뒤에 두면 `resumable`이 `session_id`로 잡혀 422가 난다. 그 순서를 고정하는 테스트를 쓴다:

```python
def test_resumable_is_not_swallowed_by_the_session_id_route(client):
    assert client.get("/api/sessions/resumable?language=en").status_code == 200
```

- [ ] **Step 5: Run the suite and commit**

```bash
git add app/db.py app/api.py tests/
git commit -m "feat: offer the session the learner walked away from"
```

---

### Task 5: 홈 통계

**Files:**
- Modify: `app/db.py`, `app/api.py`
- Test: `tests/test_db.py`, `tests/test_api_config.py`

**Interfaces:**
- Produces:
  - `db.home_stats(language) -> {streak, week_turns, fixed_total, top_tag}`
  - `GET /api/stats/home?language=en`

- [ ] **Step 1: Write the failing tests**

```python
def test_home_stats_counts_this_weeks_turns_and_total_fixes(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "a", ok=False, fixed="A", tag="시제")
    store.add_message(sid, "user", "b", ok=True, tag="없음")
    store.add_message(sid, "bot", "reply")
    stats = store.home_stats("en")
    assert stats["week_turns"] == 2      # bot lines are not the learner speaking
    assert stats["fixed_total"] == 1
    assert stats["top_tag"] == "시제"


def test_home_stats_has_no_top_tag_before_there_is_evidence(store):
    """A weakness ranked off one or two mistakes is a guess dressed as a fact."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "a", ok=False, fixed="A", tag="시제")
    assert store.home_stats("en")["top_tag"] is None


def test_home_stats_streak_counts_consecutive_days_ending_today(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "today")
    assert store.home_stats("en")["streak"] == 1
```

- [ ] **Step 2: Run them and confirm they fail**

- [ ] **Step 3: Implement**

`top_tag`는 **최소 3회** 나온 태그만 반환한다. 근거가 얇은 약점은 사실처럼 보이는 추측이다.

```python
def home_stats(language) -> dict:
    """Numbers for the home screen. All computed, none estimated.

    `top_tag` is withheld until a tag has appeared at least three times: a
    weakness ranked off one mistake is a guess wearing the costume of a fact,
    and the home screen is where the learner decides what to practise.
    """
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")
    with connect() as conn:
        week_turns = conn.execute(
            "SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user' AND m.created_at >= ?",
            (language, week_ago),
        ).fetchone()[0]
        fixed_total = conn.execute(
            "SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user' AND m.ok = 0",
            (language,),
        ).fetchone()[0]
        tag_rows = conn.execute(
            "SELECT m.tag, COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user' AND m.ok = 0"
            "   AND m.tag IS NOT NULL AND m.tag <> '없음'"
            " GROUP BY m.tag ORDER BY n DESC LIMIT 1",
            (language,),
        ).fetchone()
        days = [r[0] for r in conn.execute(
            "SELECT DISTINCT substr(m.created_at, 1, 10) d"
            " FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user'"
            " ORDER BY d DESC", (language,))]

    top_tag = tag_rows["tag"] if tag_rows and tag_rows["n"] >= 3 else None

    streak, day = 0, datetime.now(timezone.utc).date()
    for stamp in days:
        if stamp != day.isoformat():
            break
        streak += 1
        day -= timedelta(days=1)

    return {"streak": streak, "week_turns": week_turns,
            "fixed_total": fixed_total, "top_tag": top_tag}
```

`from datetime import date` 는 필요 없다 — `datetime.now(...).date()`로 충분하다.

- [ ] **Step 4: Add the route and commit**

```python
@router.get("/stats/home")
def home_stats(language: Language):
    return db.home_stats(language)
```

```bash
git add app/db.py app/api.py tests/
git commit -m "feat: compute the home screen's counters"
```

---

### Task 6: 홈 화면 마크업과 스타일

**Files:**
- Modify: `static/index.html`, `static/css/components.css`
- Modify: `static/js/main.js` (라우터 등록만)

- [ ] **Step 1: Replace the setup section**

`<section id="setup">` 전체를 교체한다. **id는 `home`으로 바꾼다** — 이 화면은 더 이상 설정 폼이 아니다.

```html
  <section id="home">
    <div class="home-head">
      <h2 id="home-greeting">오늘은 뭘 연습할까요?</h2>
      <span class="seg" id="language-seg">
        <button type="button" data-language="en" class="on">English</button>
        <button type="button" data-language="ja">日本語</button>
      </span>
    </div>

    <div id="resume-card" hidden>
      <div>
        <p id="resume-title"></p>
        <p id="resume-sub" class="hint"></p>
      </div>
      <button id="btn-resume">계속 →</button>
    </div>

    <p id="recommend" class="recommend" hidden></p>

    <input id="wish" type="text" placeholder="예: 구직 면접, 병원 접수, 길 묻기">
    <p class="hint">비워두고 시작하면 봇이 골라줍니다</p>

    <div id="chips" class="chips"></div>

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

    <div class="stats" id="home-stats" hidden>
      <div class="stat"><span class="v" id="stat-streak">0</span><span class="k">연속 학습일</span></div>
      <div class="stat"><span class="v" id="stat-week">0</span><span class="k">이번 주 발화</span></div>
      <div class="stat"><span class="v" id="stat-fixed">0</span><span class="k">고친 표현</span></div>
    </div>
  </section>
```

`#language` / `#mode` / `#scenario` / `#scenario-row` / `#topic-row` / `#topic` select와 label은 전부 사라진다. 언어와 모드는 이제 버튼 그룹이고, 시나리오는 입력창과 칩이 대신한다.

- [ ] **Step 2: Register the renamed screen**

`static/js/main.js`의 `router.register('setup', 'setup')`를 `router.register('home', 'home')`로, `router.show('setup')`를 `router.show('home')`로 바꾼다. `session.js`에서 `router.show('setup')`를 부르는 곳이 있으면 함께 고친다.

- [ ] **Step 3: Style it**

```css
/* --- home --- */
#home { max-width: 640px; }
.home-head { display: flex; align-items: center; justify-content: space-between;
             margin-bottom: var(--space-4); }
#home-greeting { font-size: var(--text-xl); margin: 0; letter-spacing: -.4px; }

.seg { display: inline-flex; background: var(--surface-sunken); border-radius: var(--radius-sm);
       padding: 2px; }
.seg button { font-size: var(--text-xs); padding: var(--space-1) var(--space-3);
              border: 0; background: transparent; color: var(--text-dim); border-radius: var(--radius-sm); }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }

#resume-card { display: flex; align-items: center; gap: var(--space-3);
               background: var(--accent); color: #fff; border-radius: var(--radius);
               padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4); }
#resume-card > div { flex: 1; }
#resume-title { margin: 0; font-weight: 650; }
#resume-sub { margin: 2px 0 0; color: rgba(255,255,255,.8); }
#btn-resume { background: rgba(255,255,255,.18); border-color: transparent; color: #fff; }

.recommend { background: var(--correct-bg); color: var(--correct-ink);
             border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3);
             font-size: var(--text-sm); margin: 0 0 var(--space-4); }

#wish { font-size: var(--text-lg); padding: var(--space-3); }

.chips { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-3) 0 var(--space-4); }
.chips button { font-size: var(--text-xs); padding: var(--space-1) var(--space-3);
                border-radius: var(--radius-pill); color: var(--text-dim); }
.chips button:hover { color: var(--text); border-color: var(--accent); }

.modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2);
         margin-bottom: var(--space-4); }
.mode { display: flex; flex-direction: column; gap: 3px; text-align: left;
        padding: var(--space-3); border-radius: var(--radius); }
.mode .n { font-size: var(--text-sm); font-weight: 650; }
.mode .d { font-size: var(--text-xs); color: var(--text-dim); line-height: 1.4; }
.mode.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

.stats { display: flex; gap: var(--space-3); margin-top: var(--space-6);
         padding-top: var(--space-4); border-top: 1px solid var(--line); }
.stat { flex: 1; text-align: center; display: flex; flex-direction: column; gap: 2px; }
.stat .v { font-size: var(--text-xl); font-weight: 700; letter-spacing: -.4px; }
.stat .k { font-size: var(--text-xs); color: var(--text-faint); }

@media (max-width: 560px) { .modes { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Verify**

프론트/파이썬 테스트를 돌린다. 포트 **8010**에 서버를 띄우고(사용자 서버는 8000) `/`가 200이고 서빙된 HTML에 `#home`, `#wish`, `#chips`, `#modes`, `#resume-card`가 있고 `#scenario`, `#topic`, `#setup`이 없는지 확인한다. `static/js/`에서 사라진 id를 참조하는 곳이 남아 있는지 grep한다 — **이 단계에서는 아직 남아 있는 게 정상이다** (Task 7이 고친다). 무엇이 남았는지 목록으로 보고한다.

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/css/components.css static/js/main.js
git commit -m "feat: replace the setup form with a home screen"
```

---

### Task 7: 홈 배선

**Files:**
- Modify: `static/js/session.js`, `static/js/main.js`, `static/js/api.js`

**Interfaces:**
- Produces:
  - `state.language` / `state.mode`가 버튼 그룹에서 온다
  - `session.loadChips()` — 현재 언어·모드의 시나리오를 칩으로
  - `session.startFromHome()` — 입력창 내용에 따라 재사용 · 생성 · 무작위 선택

- [ ] **Step 1: Replace `loadScenarios` with `loadChips`**

```javascript
/* The chips are the catalogue, not a required choice. A learner who knows what
   they want types it; the chips are for the ones they have used before and for
   the days they have no idea. */
export async function loadChips() {
  const box = $('chips');
  box.replaceChildren();
  if (state.mode === 'lesson') return;   // lesson takes a topic, not a scenario
  const { scenarios } = await getJSON(`/scenarios?language=${state.language}&mode=${state.mode}`);
  for (const s of scenarios.slice(0, 8)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.title;
    b.dataset.id = s.id;
    box.append(b);
  }
}
```

칩을 누르면 그 시나리오로 바로 시작한다 — 입력창에 제목을 채워넣고 사용자가 다시 시작을 누르게 하는 것은 클릭을 하나 되살리는 일이다.

- [ ] **Step 2: Implement `startFromHome`**

```javascript
/* Three ways in, one button:
   - a chip, or text that names a scenario we already have -> reuse it
   - text we have never seen -> ask the model to build it
   - nothing typed -> pick one, because "고르세요" is what this screen removed */
export async function startFromHome(scenarioId = null) {
  const wish = $('wish').value.trim();
  $('btn-start').disabled = true;
  try {
    let id = scenarioId;
    if (!id && state.mode !== 'lesson' && wish) {
      const { scenarios } = await getJSON(`/scenarios?language=${state.language}&mode=${state.mode}`);
      const hit = scenarios.find((s) => s.title.trim() === wish);
      if (hit) id = hit.id;
      else {
        notify('상황을 만드는 중입니다...');
        const made = await postJSON('/scenarios/generate',
          { language: state.language, mode: state.mode, wish });
        id = made.id;
        notify('');
      }
    }
    if (!id && state.mode !== 'lesson') {
      const { scenarios } = await getJSON(`/scenarios?language=${state.language}&mode=${state.mode}`);
      if (!scenarios.length) { notify('연습할 상황이 없습니다.'); return; }
      id = scenarios[Math.floor(Math.random() * scenarios.length)].id;
    }
    await startSession({ scenarioId: id, topic: state.mode === 'lesson' ? wish : null });
  } catch (err) {
    notify(`시작하지 못했습니다: ${err.message}`);
  } finally {
    $('btn-start').disabled = false;
  }
}
```

`startSession`의 시그니처를 `startSession({ scenarioId, topic })`로 바꾸고, 사라진 `$('language')` / `$('mode')` / `$('scenario')` / `$('topic')` 참조를 `state.language` / `state.mode`와 인자로 대체한다.

- [ ] **Step 3: Wire the button groups in `main.js`**

```javascript
$('language-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-language]');
  if (!btn) return;
  state.language = btn.dataset.language;
  [...$('language-seg').children].forEach((b) => b.classList.toggle('on', b === btn));
  loadChips();
  refreshHealth();
  loadHome();
});

$('modes').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  [...$('modes').children].forEach((b) => b.classList.toggle('on', b === btn));
  $('wish').placeholder = state.mode === 'lesson'
    ? '예: 과거형, 식당에서 쓰는 표현'
    : '예: 구직 면접, 병원 접수, 길 묻기';
  loadChips();
});

$('chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) startFromHome(btn.dataset.id);
});

$('btn-start').addEventListener('click', () => startFromHome());
$('wish').addEventListener('keydown', (e) => { if (e.key === 'Enter') startFromHome(); });
```

`refreshHealth`가 `$('language').value`를 읽던 곳을 `state.language`로 바꾼다.

- [ ] **Step 4: Verify**

**자유 식별자 감사**를 건드린 파일 전부에 돌린다 — 받아들인 브라우저 전역을 이름으로 열거한다. Phase 2A가 정확히 이 부류의 Critical로 페이지를 백지로 만들었고 어느 스위트도 잡지 못했다.

**사라진 id 참조 sweep**: `static/js/`에서 `'language'`, `'mode'`, `'scenario'`, `'scenario-row'`, `'topic-row'`, `'topic'`, `'setup'`을 grep해서 **0건**임을 보인다. `$('language')`가 남아 있으면 `null.value`로 터진다.

포트 **8010**에서 서버를 띄우고 `curl`로 확인한다: `/api/scenarios?language=en&mode=free`가 카탈로그를 돌려주는지, `POST /api/scenarios/generate`가 실제 모델로 시나리오를 만드는지(실제 JSON을 인용한다), 그리고 그것이 곧바로 `/api/scenarios` 목록에 나타나는지.

- [ ] **Step 5: Commit**

```bash
git add static/js
git commit -m "feat: one input, three ways to start a session"
```

---

### Task 8: 이어서 하기와 통계 렌더링

**Files:**
- Modify: `static/js/session.js`, `static/js/main.js`

**Interfaces:**
- Produces: `session.loadHome()` — 이어서 하기 카드, 추천, 통계를 채운다

- [ ] **Step 1: Implement `loadHome`**

`session.js` 모듈 최상단에 `let resumeTarget = null;`을 선언한다 — `loadHome`이 채우고
`resumeSession`이 읽는다.

```javascript
/* Everything on the home screen that depends on history. Fails quietly: a
   learner who wants to practise should never be stopped by a counter. */
export async function loadHome() {
  try {
    const [{ session }, stats] = await Promise.all([
      getJSON(`/sessions/resumable?language=${state.language}`),
      getJSON(`/stats/home?language=${state.language}`),
    ]);

    $('resume-card').hidden = !session;
    if (session) {
      resumeTarget = session;
      $('resume-title').textContent = `이어서 하기 — ${session.title}`;
      $('resume-sub').textContent = `${session.turns}턴까지 하고 멈췄습니다`;
    }

    $('stat-streak').textContent = stats.streak;
    $('stat-week').textContent = stats.week_turns;
    $('stat-fixed').textContent = stats.fixed_total;
    $('home-stats').hidden = !(stats.streak || stats.week_turns || stats.fixed_total);

    $('recommend').hidden = !stats.top_tag;
    if (stats.top_tag) {
      $('recommend').textContent = `요즘 ${stats.top_tag}에서 자주 걸립니다. 오늘은 그쪽을 노려볼까요?`;
    }
  } catch {
    /* history is a nicety -- never block the learner from starting */
  }
}
```

- [ ] **Step 2: Implement resume**

이어서 하기는 새 세션을 만들지 않고 기존 세션에 붙는다. `GET /api/sessions/{id}`가 이미 메시지를 돌려주므로 그것으로 대화를 복원한다:

```javascript
export async function resumeSession() {
  if (!resumeTarget) return;
  try {
    const { messages } = await getJSON(`/sessions/${resumeTarget.id}`);
    state.sessionId = resumeTarget.id;
    state.mode = resumeTarget.mode;
    router.show('session');
    $('conversation').replaceChildren();
    for (const m of messages) addMessage(m.speaker, m.text);
    notify('');
  } catch (err) {
    notify(`이어서 하지 못했습니다: ${err.message}`);
  }
}
```

스크립트 모드 세션은 이어서 할 수 없다 — 대본 진행 상태(`scriptIndex`)가 서버에 없다. `resumable_session`이 `mode = 'script'`를 제외하도록 Task 4의 쿼리에 조건을 더하고, 그 테스트도 함께 쓴다. **이 제약을 Task 4의 브리프에 없던 것으로 발견하면 보고한다.**

- [ ] **Step 3: Wire it and load on entry**

```javascript
$('btn-resume').addEventListener('click', resumeSession);
```

`main.js`의 시작 시 호출에 `loadHome()`을 더한다.

- [ ] **Step 4: Verify**

두 스위트, 자유 식별자 감사, 포트 8010 확인. `curl`로 세션을 하나 시작해 한 턴 보낸 뒤 `/api/sessions/resumable?language=en`이 그것을 돌려주는지, 끝낸 뒤에는 `null`인지 확인하고 실제 JSON을 인용한다.

- [ ] **Step 5: Commit**

```bash
git add static/js
git commit -m "feat: offer to resume, and show what practice has added up to"
```

---

## C단계 완료 확인

- [ ] 두 스위트와 엔진 품질 게이트

```powershell
node --test 'static/js/*.test.js'
.\venv\Scripts\python.exe -m pytest -m "not engine"
.\venv\Scripts\python.exe -m pytest tests/test_feedback_quality.py -m engine
```

- [ ] 손으로 한 바퀴 (브라우저, Ctrl+Shift+R 후)

빈 입력으로 시작 → 봇이 골라주는지. 칩을 눌러 시작 → 그 상황으로 가는지. **카탈로그에 없는 것을 쳐서 시작 → 모델이 만들어 주는지.** 대화 중 탭을 닫고 다시 열어 → 이어서 하기가 뜨는지. 수업 모드에서 주제를 쳐서 시작 → 칩이 사라지고 주제가 먹히는지. 언어를 일본어로 바꿔 → 칩과 통계가 따라 바뀌는지.

- [ ] 사라진 요소 참조가 0건인지

```powershell
Select-String -Path static/js/*.js -Pattern "'(language|mode|scenario|scenario-row|topic-row|topic|setup)'"
```

`state.language` / `state.mode` 같은 속성 접근은 제외하고, `$('...')` 형태의 조회가 없어야 한다.

---

## 다음 단계

C단계가 끝나면 **D단계(마이페이지)** 계획을 쓴다. D는 `stable_level`(Task 3에서 이미 만든 것)을 화면에 쓰고, 태그 집계 그래프와 복습 목록, 세션 기록을 다룬다. 그다음 E(쉐도잉, 1분 말하기)다.
