# 쉐도잉 (Phase 2 E-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대본 라이브러리의 모든 줄을 "듣기 → 따라 말하기 → 공개·비교" 카드로 연습하는 쉐도잉 모드를 만든다.

**Architecture:** 서버 모드는 `script` 그대로, `sessions.shadowing` 플래그(스키마 v7)로 갈린다. 한 줄 시도 = `messages` 한 행(`script_index`로 줄당 한 행, 다시 하기는 갱신), 판정은 서버의 `text_match.matches`(= `match.js`의 쌍둥이). 끝내기는 LLM 없이 숫자와 복습 넣기만. 화면은 새 `static/js/shadow.js`(지금 줄 카드)가 맡고, `session.js`는 주입된 훅으로 마이크 결과·턴 상태만 넘긴다.

**Tech Stack:** FastAPI, SQLite, pytest, 브라우저 ES 모듈 + `node --test`(dom-shim).

**Spec:** `docs/superpowers/specs/2026-09-19-monologue-shadowing-design.md`

## Global Constraints

- 작업 위치: 워크트리 `C:/git/Monologue-wt/shadowing`, 브랜치 `shadowing`. `C:/git/Monologue`는 건드리지 않는다(사용자 8000 서버 + 대본 일괄 생성이 그 DB를 쓰는 중).
- 파이썬 `C:/git/Monologue/venv/Scripts/python.exe`, 워크트리 루트에서, 항상 `-m "not engine"`.
- **대본 생성이 Ollama를 계속 쓰고 있다.** 실제 LLM을 부르는 테스트(예: `tests/test_api_script_line.py`의 free 세션 시작)는 수십 분 걸린다. 태스크 중에는 **자기가 건드린 테스트 파일만** 돌린다. 전체 스위트는 컨트롤러가 마지막에 생성을 멈추고 돌린다.
- node: `node --test --test-force-exit static/js/*.test.js`. 기준선 node 256. 워크트리에서 `test_kokoro_model_files_are_present` 실패는 정상(engines/ gitignore).
- 서버를 띄워야 하면 **8010만**. `config.DB_PATH`는 저장소 루트의 `monologue.db`라서 워크트리에서 띄우면 워크트리의 `monologue.db`를 쓴다 — 필요하면 `C:/git/Monologue/monologue.db`를 워크트리 루트로 **복사**해서 쓴다(gitignore 확인, 커밋 금지). 8000은 절대 건드리지 않는다.
- 판정 문턱 **0.9**(`PASS_THRESHOLD`), 천천히 듣기 **0.75배**, 복습 넣기 날짜 **내일**(로컬 날짜, `api._today() + timedelta(days=1)`).
- 문구(그대로): `쉐도잉`, `원어민 소리를 듣고 바로 따라 말하기`, `음성 준비 중...`, `다시 듣기`, `천천히 듣기`, `글자 보기`, `듣는 중...`, `받아쓰는 중...`, `못 알아들었어요. 다시 해보세요`, `내 말: "<text>"`, `✓ 대본과 같아요`, `✗ 조금 달라요`, `글자 보고 함`, `▶ 원어민`, `▶ 내 발음`, `다시 하기`, `다음 줄 →`, `끝! 리포트 보기`, `저장하지 못했어요`, `<i> / <n>`(줄 번호), 가린 자리 `●●●●●`, 리포트 `따라 한 줄 <n>/<전체>`, `대본과 같음 <m>`, `글자 보고 함 <p>`, `어려웠던 줄`, `이 줄들은 내일 복습에 나와요`, `전부 대본대로 따라 했어요 🎉`, 헤드라인 `<n>줄을 따라 말했어요.`, 지난 기록 `따라 한 줄 <n> · 쉐도잉`, 복습 카드 라벨 `내 말` / `대본`.
- 사용자 규칙: 기다림은 문구로 보인다. 단계가 바뀌어도 카드 자리·높이가 튀지 않는다(`min-height` 고정 + `setShown`/`.is-invisible` 페이드, `transform` 금지 — fixed/sticky 자식이 깨진다).
- 새 가드마다 **일부러 부숴 빨개지는지** 확인하고 되돌린다. 보고서에 무엇을 부쉈고 어떤 테스트가 빨개졌는지 적는다.
- 커밋 메시지 끝:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

---

### Task 1: 서버 — v7, 판정 쌍둥이, 한 줄 저장

**Files:**
- Modify: `app/db.py` (MIGRATIONS 끝, `create_session`, 새 `save_shadow_line`)
- Modify: `app/text_match.py` (새 `similarity`, `matches`, `PASS_THRESHOLD`)
- Modify: `app/api.py` (`SessionStart`, `start_session`, 새 `POST /sessions/{id}/shadow-line`, `script_turn`/`store_script_line`/`undo_last_turn` 가드)
- Test: `tests/test_text_match.py`, `tests/test_db.py`, 새 `tests/test_api_shadow.py`

**Interfaces:**
- Produces:
  - `text_match.matches(spoken: str, target: str, language: str) -> bool`, `text_match.similarity(...) -> float`, `text_match.PASS_THRESHOLD = 0.9`
  - `db.create_session(language, mode, scenario_id=None, topic=None, shadowing=False) -> int`
  - `db.save_shadow_line(session_id, index, text, target, matched: bool, peeked: bool) -> int` (message id; 같은 index면 같은 id)
  - `POST /api/sessions` 본문 `shadowing: bool`(기본 false) → 응답에 `shadowing`
  - `POST /api/sessions/{id}/shadow-line {index, text, peeked}` → `{message_id, matched}`

- [ ] **Step 1: 판정 쌍둥이 테스트** — `tests/test_text_match.py` 끝에 추가:

```python
import json
import subprocess

from app.text_match import matches, similarity

_PAIRS = [
    ("en", "i would like a coffee please", "I'd like a coffee, please."),
    ("en", "I would like a coffee please", "I would like a coffee, please."),
    ("en", "could you tell me the way to the station", "Could you tell me the way to the station?"),
    ("en", "could you tell me way station", "Could you tell me the way to the station?"),
    ("en", "", "Hello."),
    ("ja", "すみません 駅はどこですか", "すみません、駅はどこですか？"),
    ("ja", "駅どこ", "すみません、駅はどこですか？"),
    ("ja", "ありがとうございます", "ありがとうございました。"),
]


def test_matches_is_the_twin_of_match_js():
    """Same pairs through both files: the server's verdict is what is stored,
    the browser's is what re-speak shows -- they must never disagree."""
    script = (
        "import('./static/js/match.js').then(m => {"
        f" const pairs = {json.dumps(_PAIRS, ensure_ascii=False)};"
        " console.log(JSON.stringify(pairs.map(([l, s, t]) => [m.similarity(s, t, l), m.matches(s, t, l)])));"
        "});"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True,
                         text=True, encoding="utf-8", check=True).stdout
    js = json.loads(out)
    py = [[similarity(s, t, l), matches(s, t, l)] for l, s, t in _PAIRS]
    for (lang, s, t), (js_sim, js_ok), (py_sim, py_ok) in zip(_PAIRS, js, py):
        assert abs(js_sim - py_sim) < 1e-9, (lang, s, t, js_sim, py_sim)
        assert js_ok == py_ok, (lang, s, t)
    assert any(ok for _, ok in py) and not all(ok for _, ok in py), "pairs must include both verdicts"
```

- [ ] **Step 2: 실패 확인** — `C:/git/Monologue/venv/Scripts/python.exe -m pytest tests/test_text_match.py -q` → ImportError(`matches`).

- [ ] **Step 3: 구현** — `app/text_match.py` 끝에(모듈 docstring의 "twin" 설명에 `similarity`/`matches`도 쌍둥이라는 한 줄 추가):

```python
PASS_THRESHOLD = 0.9


def _tokens(text: str | None, language: str) -> list[str]:
    cleaned = normalize(text)
    if not cleaned:
        return []
    return list(cleaned.replace(" ", "")) if language == "ja" else cleaned.split(" ")


def _edit_distance(a: list[str], b: list[str]) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i]
        for j in range(1, len(b) + 1):
            row.append(min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = row
    return prev[len(b)]


def similarity(spoken: str | None, target: str | None, language: str) -> float:
    """Twin of static/js/match.js's similarity(): words in English, characters in Japanese."""
    a, b = _tokens(spoken, language), _tokens(target, language)
    if not a or not b:
        return 0.0
    return 1 - _edit_distance(a, b) / max(len(a), len(b))


def matches(spoken: str | None, target: str | None, language: str) -> bool:
    return similarity(spoken, target, language) >= PASS_THRESHOLD
```

주의: JS의 `cleaned.replace(/\s/g, '')`는 모든 공백을 지운다. `normalize`가 이미 공백을 한 칸으로 줄였으므로 `replace(" ", "")`와 같다.

- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS. 부수기: `_tokens`의 ja 분기를 `cleaned.split(" ")`로 바꿔 빨개지는지 보고 되돌린다.

- [ ] **Step 5: DB 테스트** — `tests/test_db.py` 끝에:

```python
def test_v7_adds_shadowing_columns(tmp_path, monkeypatch):
    from app import config
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "v7.db")
    from app import db as store
    store.init_db()
    assert store.schema_version() == 7
    sid = store.create_session("en", "script", scenario_id="x", shadowing=True)
    assert store.get_session(sid)["shadowing"] == 1
    assert store.get_session(store.create_session("en", "free"))["shadowing"] == 0
    mid = store.add_message(sid, "user", "hi")
    row = store.get_message(mid)
    assert row["matched"] is None and row["peeked"] is None


def test_save_shadow_line_keeps_one_row_per_index(tmp_path, monkeypatch):
    from app import config
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "s.db")
    from app import db as store
    store.init_db()
    sid = store.create_session("en", "script", scenario_id="x", shadowing=True)
    first = store.save_shadow_line(sid, 2, "i like it", "I like it.", matched=True, peeked=True)
    again = store.save_shadow_line(sid, 2, "i liked it", "I like it.", matched=False, peeked=False)
    other = store.save_shadow_line(sid, 3, "yes", "Yes.", matched=True, peeked=False)
    assert again == first and other != first
    rows = [m for m in store.get_messages(sid) if m["script_index"] == 2]
    assert len(rows) == 1
    r = rows[0]
    assert (r["speaker"], r["text"], r["fixed"], r["matched"]) == ("user", "i liked it", "I like it.", 0)
    assert r["peeked"] == 1, "a line once peeked stays peeked"
    assert r["ok"] is None and r["tag"] is None
```

`schema_version()` 이름이 다르면 `app/db.py:195`의 실제 이름을 쓴다. 기존 테스트 중 `schema_version() == 6`을 단정하는 것이 있으면 7로 고친다(grep `== 6`).

- [ ] **Step 6: 실패 확인** — `-m pytest tests/test_db.py -q -k "v7 or shadow_line"` → FAIL.

- [ ] **Step 7: 구현** — `app/db.py`:

MIGRATIONS 끝에(바로 앞 v6 항목 스타일의 설명 주석과 함께):

```python
    # v6 -> v7: shadowing (docs/superpowers/specs/2026-09-19-monologue-shadowing-
    # design.md, "데이터"). A shadowing session is a script session with a flag;
    # each line attempt is one learner row keyed by script_index, with the verdict
    # and whether the text was peeked at. ok stays NULL: nothing here is graded,
    # so level, accuracy and weak spots never see these rows.
    [
        "ALTER TABLE sessions ADD COLUMN shadowing INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN matched INTEGER",
        "ALTER TABLE messages ADD COLUMN peeked INTEGER",
    ],
```

`create_session`에 `shadowing=False` 인자, INSERT에 `shadowing` 컬럼(`int(bool(shadowing))`).

`add_script_line_message` 아래에:

```python
def save_shadow_line(session_id, index, text, target, matched, peeked) -> int:
    """One shadowing attempt at script line `index`; a retry replaces the text
    and verdict in the same row, so the id -- and the recording attached to it
    -- stays put. UNIQUE(session_id, script_index) makes a second row for the
    index impossible even when two requests race. `peeked` only ever turns on:
    a line whose text was once shown was not shadowed blind, whatever a later
    attempt says."""
    with connect() as conn:
        conn.execute(
            "INSERT INTO messages (session_id, turn, speaker, text, fixed, script_index,"
            " matched, peeked, created_at)"
            " SELECT ?, (SELECT COALESCE(MAX(turn), 0) + 1 FROM messages WHERE session_id = ?),"
            "        'user', ?, ?, ?, ?, ?, ?"
            " ON CONFLICT(session_id, script_index) DO UPDATE SET"
            "   text = excluded.text, matched = excluded.matched,"
            "   peeked = MAX(peeked, excluded.peeked), created_at = excluded.created_at",
            (session_id, session_id, text, target, index, int(matched), int(peeked), _now()))
        return conn.execute(
            "SELECT id FROM messages WHERE session_id = ? AND script_index = ?",
            (session_id, index)).fetchone()[0]
```

SQLite의 `INSERT ... SELECT ... ON CONFLICT`는 파싱 모호성 때문에 SELECT에 `WHERE true`가 필요하다. 테스트가 구문 오류로 실패하면 `"        'user', ?, ?, ?, ?, ?, ? WHERE true"`로 고친다. `created_at` 갱신은 `active_minutes`가 마지막 시도 시각을 보도록 하기 위함.

- [ ] **Step 8: 통과 확인** — 같은 명령 → PASS. 부수기: `MAX(peeked, ...)`를 `excluded.peeked`로 바꿔 빨개지는지.

- [ ] **Step 9: API 테스트** — 새 `tests/test_api_shadow.py`:

```python
"""Shadowing: a script session with a flag, one row per line attempt."""
import pytest
from fastapi.testclient import TestClient

from app import config, db, llm, scenarios, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")

    def no_llm(*a, **k):
        raise AssertionError("shadowing never calls the model")
    monkeypatch.setattr(llm, "chat", no_llm)
    monkeypatch.setattr(llm, "chat_json", no_llm)
    return TestClient(app)


SCRIPT = "standup-meeting-en"


def lines():
    return scenarios.get_scenario(SCRIPT)["lines"]


def start(client, shadowing=True, mode="script", scenario_id=SCRIPT):
    return client.post("/api/sessions", json={"language": "en", "mode": mode,
                                              "scenario_id": scenario_id, "shadowing": shadowing})


def test_a_shadowing_session_is_a_flagged_script_session(client):
    r = start(client)
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "script" and body["shadowing"] is True
    assert len(body["lines"]) == len(lines())
    assert db.get_session(body["session_id"])["shadowing"] == 1


def test_shadowing_is_only_for_script_mode(client):
    assert start(client, mode="free", scenario_id="airport-checkin-en").status_code == 400


def test_a_line_is_judged_by_the_server_and_kept_once(client):
    sid = start(client).json()["session_id"]
    target = lines()[1]["text"]
    ok = client.post(f"/api/sessions/{sid}/shadow-line", json={"index": 1, "text": target, "peeked": False})
    assert ok.status_code == 200 and ok.json()["matched"] is True
    bad = client.post(f"/api/sessions/{sid}/shadow-line", json={"index": 1, "text": "banana", "peeked": False})
    assert bad.json() == {"message_id": ok.json()["message_id"], "matched": False}
    rows = [m for m in db.get_messages(sid) if m["script_index"] == 1]
    assert len(rows) == 1 and rows[0]["text"] == "banana" and rows[0]["fixed"] == target


def test_shadow_line_refusals(client):
    sid = start(client).json()["session_id"]
    post = lambda s, **b: client.post(f"/api/sessions/{s}/shadow-line",
                                      json={"index": 0, "text": "hi", "peeked": False, **b})
    assert post(sid, index=len(lines())).status_code == 400
    assert post(sid, index=-1).status_code == 400
    assert post(sid, text="  ").status_code == 400
    assert post(9999).status_code == 404
    plain = start(client, shadowing=False).json()["session_id"]
    assert post(plain).status_code == 400
    db.end_session(sid, "{}", None)
    assert post(sid).status_code == 409


def test_script_only_routes_refuse_a_shadowing_session(client):
    sid = start(client).json()["session_id"]
    assert client.post("/api/script-turn", json={"session_id": sid, "text": "hi"}).status_code == 400
    assert client.post(f"/api/sessions/{sid}/script-line", json={"index": 0}).status_code == 400
    client.post(f"/api/sessions/{sid}/shadow-line", json={"index": 0, "text": "hi", "peeked": False})
    assert client.delete(f"/api/sessions/{sid}/last-turn").status_code == 400
```

`scenarios.get_scenario("standup-meeting-en")`의 첫 줄 화자와 무관하게 동작해야 한다(쉐도잉은 모든 줄). `db.end_session`의 실제 인자 순서는 `(session_id, report, level)`.

- [ ] **Step 10: 실패 확인** — `-m pytest tests/test_api_shadow.py -q` → FAIL.

- [ ] **Step 11: 구현** — `app/api.py`:

`SessionStart`에 `shadowing: bool = False`. `start_session` 맨 앞(시나리오 검사 전):

```python
    if payload.shadowing and payload.mode != "script":
        raise HTTPException(400, "shadowing is a script session")
```

`db.create_session(..., shadowing=payload.shadowing)`. 스크립트 응답에 `"shadowing": payload.shadowing`.

`script_turn` 뒤에:

```python
class ShadowLine(BaseModel):
    index: int
    text: str
    peeked: bool = False


@router.post("/sessions/{session_id}/shadow-line")
def shadow_line(session_id: int, payload: ShadowLine):
    """One attempt at shadowing script line `index`. The verdict is the
    server's (text_match.matches, the twin of match.js), and a retry replaces
    the attempt in place -- see db.save_shadow_line."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    if not session["shadowing"]:
        raise HTTPException(400, "not a shadowing session")
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    lines = scenario["lines"] if scenario else []
    if payload.index < 0 or payload.index >= len(lines):
        raise HTTPException(400, "line index out of range")
    target = lines[payload.index]["text"]
    matched = text_match.matches(text, target, session["language"])
    message_id = db.save_shadow_line(session_id, payload.index, text, target, matched, payload.peeked)
    return {"message_id": message_id, "matched": matched}
```

`text_match` import 확인(`from app import ... text_match` 또는 기존 방식). `script_turn`의 `mode != "script"` 검사 뒤에 `if session["shadowing"]: raise HTTPException(400, "a shadowing session stores lines through /shadow-line")`. `store_script_line`도 같은 자리에 같은 가드. `undo_last_turn`의 409 검사 뒤에 `if session["shadowing"]: raise HTTPException(400, "shadowing retries a line instead of undoing it")`.

- [ ] **Step 12: 통과 확인** — `-m pytest tests/test_api_shadow.py tests/test_db.py tests/test_text_match.py -q` → PASS. 부수기: `shadow_line`의 `if not session["shadowing"]`를 지워 `test_shadow_line_refusals`가 빨개지는지; `undo_last_turn` 가드를 지워 마지막 테스트가 빨개지는지.

- [ ] **Step 13: 커밋**

```bash
git add app/db.py app/text_match.py app/api.py tests/test_text_match.py tests/test_db.py tests/test_api_shadow.py
git commit -m "feat: shadowing sessions -- a flagged script session, one judged row per line"
```

---

### Task 2: 서버 — 끝내기, 리포트, 목록의 쉐도잉 표시

**Files:**
- Modify: `app/db.py` (새 `shadow_summary`, `history`, `recent_sessions`, `due_reviews`)
- Modify: `app/api.py` (`finish_session`, `session_report`, `session_history_page`, `_recent_row`)
- Test: `tests/test_api_shadow.py`, `tests/test_db.py`

**Interfaces:**
- Consumes: Task 1의 `save_shadow_line`, `shadow-line` 라우트, `shadowing` 컬럼.
- Produces:
  - `db.shadow_summary(session_id) -> {"lines": int, "done": int, "matched": int, "peeked": int, "hard": [{"index", "said", "target", "message_id"}]}` — `lines`는 호출자가 채운다(시나리오 줄 수), `hard`는 `matched = 0 OR peeked = 1`, index 순
  - `POST /sessions/{id}/end`(쉐도잉) 응답: `{"kind": "shadow", "summary": "", "weak_points": [], "expressions": [], "next_focus": "", "level": None, "stats": {...기존 stats..., "minutes"}, "shadow": {lines, done, matched, peeked, hard: [{index, said, target, message_id, audio_key}]}}`
  - `GET /sessions/{id}/report`(쉐도잉): 위와 같은 `kind`/`shadow` + `mode: "script"`, `shadowing: True`, `graded: True`
  - `/sessions/history` 항목, `/stats/home`의 최근 연습 항목, `/review` 항목에 `shadowing: bool`

- [ ] **Step 1: 테스트** — `tests/test_api_shadow.py`에 추가:

```python
from datetime import date, timedelta

from app import api


def shadow_three(client):
    """Line 0 said right blind, line 1 said wrong, line 2 said right after peeking."""
    sid = start(client).json()["session_id"]
    ls = lines()
    say = lambda i, text, peeked=False: client.post(
        f"/api/sessions/{sid}/shadow-line", json={"index": i, "text": text, "peeked": peeked})
    say(0, ls[0]["text"])
    say(1, "completely different words here")
    say(2, ls[2]["text"], peeked=True)
    return sid


def test_ending_a_shadowing_session_counts_and_queues_the_hard_lines(client, monkeypatch):
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 19))
    sid = shadow_three(client)
    r = client.post(f"/api/sessions/{sid}/end")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "shadow" and body["level"] is None
    s = body["shadow"]
    assert (s["lines"], s["done"], s["matched"], s["peeked"]) == (len(lines()), 3, 2, 1)
    assert [h["index"] for h in s["hard"]] == [1, 2]
    assert s["hard"][0]["target"] == lines()[1]["text"] and s["hard"][0]["said"] == "completely different words here"
    assert all("audio_key" in h for h in s["hard"])
    assert db.get_session(sid)["level"] is None
    queued = db.due_reviews("en", date(2026, 9, 20))
    assert sorted(q["fixed"] for q in queued) == sorted([lines()[1]["text"], lines()[2]["text"]])
    assert all(q["shadowing"] for q in queued)
    assert db.due_reviews("en", date(2026, 9, 19)) == [], "queued for tomorrow, not today"


def test_the_report_reads_back_the_same_numbers(client):
    sid = shadow_three(client)
    ended = client.post(f"/api/sessions/{sid}/end").json()
    again = client.get(f"/api/sessions/{sid}/report").json()
    assert again["kind"] == "shadow" and again["shadowing"] is True and again["mode"] == "script"
    assert again["shadow"] == ended["shadow"]


def test_shadowing_leaves_level_accuracy_and_weak_spots_alone(client):
    before = (db.stable_level("en"), db.accuracy_since("en", date(2000, 1, 1)),
              db.home_stats("en")["top_tags"], db.home_stats("en")["fixed_total"])
    client.post(f"/api/sessions/{shadow_three(client)}/end")
    after = (db.stable_level("en"), db.accuracy_since("en", date(2000, 1, 1)),
             db.home_stats("en")["top_tags"], db.home_stats("en")["fixed_total"])
    assert after == before


def test_lists_say_which_sessions_were_shadowing(client):
    sid = shadow_three(client)
    client.post(f"/api/sessions/{sid}/end")
    item = client.get("/api/sessions/history?language=en").json()["items"][0]
    assert item["id"] == sid and item["shadowing"] is True and item["turns"] == 3
    recent = client.get("/api/stats/home?language=en").json()
    rows = recent.get("recent") or recent.get("recent_sessions") or []
    assert rows and rows[0]["shadowing"] is True
```

`accuracy_since`, `home_stats`의 키 이름(`top_tags`, `fixed_total`, 최근 연습 키)은 `app/db.py`·`app/api.py`의 실제 이름에 맞춘다 — 테스트가 KeyError로 실패하면 이름을 확인해 고치고, 단언의 뜻은 바꾸지 않는다. `stats/home`의 최근 연습 키는 `api.home_stats`에서 확인해 하나로 고정한다(위의 `or`는 확인 후 지운다).

- [ ] **Step 2: 실패 확인** — `-m pytest tests/test_api_shadow.py -q` → 새 테스트 FAIL(현재 end는 `llm.chat_json`을 불러 AssertionError → REPORT_UNAVAILABLE 경로, `kind` 없음).

- [ ] **Step 3: 구현** — `app/db.py`:

```python
def shadow_summary(session_id) -> dict:
    """The numbers a shadowing report shows, computed from the stored lines --
    never from the model. `hard` is every line said differently or said after
    peeking at the text: the ones worth another go."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, script_index, text, fixed, matched, peeked FROM messages"
            " WHERE session_id = ? AND speaker = 'user' AND script_index IS NOT NULL"
            " ORDER BY script_index", (session_id,)).fetchall()
    return {
        "done": len(rows),
        "matched": sum(1 for r in rows if r["matched"]),
        "peeked": sum(1 for r in rows if r["peeked"]),
        "hard": [{"index": r["script_index"], "said": r["text"], "target": r["fixed"],
                  "message_id": r["id"]}
                 for r in rows if not r["matched"] or r["peeked"]],
    }
```

`history`의 SELECT에 `s.shadowing`, `recent_sessions`의 SELECT에 `s.shadowing`, `due_reviews`의 SELECT에 `s.shadowing`(`JOIN sessions s ON s.id = m.session_id` 추가). 세 곳 모두 값은 0/1 정수로 나오니 API에서 `bool()`.

`app/api.py`:

```python
def _shadow_report(session) -> dict:
    """Shadowing's report: counts and the lines to try again. No model call and
    no level -- the learner repeated lines they were given, which says nothing
    about the level they would speak at."""
    summary = db.shadow_summary(session["id"])
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    summary["lines"] = len(scenario["lines"]) if scenario else summary["done"]
    for h in summary["hard"]:
        h["audio_key"] = _speak(h["target"], session["language"])
    stats = db.session_stats(session["id"])
    stats["minutes"] = db.active_minutes(session["id"])
    return {"kind": "shadow", "summary": "", "weak_points": [], "expressions": [], "next_focus": "",
            "level": None, "stats": stats, "shadow": summary}
```

`finish_session`에서 409 검사 직후:

```python
    if session["shadowing"]:
        result = _shadow_report(session)
        db.end_session(session_id, json.dumps({"kind": "shadow"}), None)
        tomorrow = _today() + timedelta(days=1)
        for h in result["shadow"]["hard"]:
            db.enqueue_review(h["message_id"], session["language"], tomorrow)
        try:
            _forget_recordings(session_id)
            for stale in db.stale_open_sessions():
                _forget_recordings(stale)
        except Exception:
            pass
        return result
```

(정리 블록은 기존 경로와 같은 이유 — 복사하지 말고 작은 도우미 `_sweep_recordings(session_id)`로 빼서 두 경로가 함께 부른다.)

`session_report`에서 `report`를 읽은 뒤 `if session["shadowing"]: return {**_shadow_report(session), "mode": session["mode"], "shadowing": True, "graded": True}`. `_speak`는 TTS 캐시를 쓰므로 다시 불러도 싸다.

`session_history_page` 항목과 `_recent_row` 반환에 `"shadowing": bool(row.get("shadowing"))`. `/review`가 `due_reviews` 행을 그대로 내보내면 `shadowing`을 `bool`로 바꿔 내보낸다.

- [ ] **Step 4: 통과 확인** — `-m pytest tests/test_api_shadow.py tests/test_db.py tests/test_api_mypage.py tests/test_api_home.py -q`(없는 파일은 빼고, `ls tests | grep -i home`로 확인) → PASS. 부수기: ① `hard` 조건에서 `or r["peeked"]`를 지워 복습 테스트가 빨개지는지 ② `end_session(..., None)`을 `"beginner"`로 바꿔 level 테스트가 빨개지는지.

- [ ] **Step 5: 커밋**

```bash
git add app/db.py app/api.py tests/test_api_shadow.py tests/test_db.py
git commit -m "feat: a shadowing session ends without the model -- counts, hard lines, tomorrow's reviews"
```

---

### Task 3: 화면 — 쉐도잉 세션(홈 카드, #pick, 지금 줄 카드)

**Files:**
- Create: `static/js/shadow.js`, `static/js/shadow.test.js`
- Modify: `static/js/audio.js` (`play`의 속도 옵션), `static/js/session.js` (훅 주입, `startSession`의 `shadowing`, `sendHeard` 분기, `uploadRecordingFor`), `static/js/pick.js` (`openPick('shadow')`, `startFromPick`이 `shadowing` 전달), `static/js/home.js` (재개·최근 테마 시작 시 `state.shadowing = false`), `static/js/main.js` (import `./shadow.js`, 카드 버튼 위임), `static/js/api.js` (`state.shadowing` 기본값 false), `static/index.html`, `static/css/components.css`
- Test: `static/js/shadow.test.js`, `static/js/audio.test.js`, `static/js/pick.test.js`

**Interfaces:**
- Consumes: `POST /api/sessions {…, shadowing: true}` → `{session_id, mode: 'script', shadowing: true, lines: [{speaker, text, audio_key}]}`; `POST /api/sessions/{id}/shadow-line {index, text, peeked}` → `{message_id, matched}`.
- Produces:
  - `audio.play(audioKey, fallbackText, onDone, { rate = 1 } = {})`
  - `session.setShadowHooks({ start(lines), heard(transcript|null), turn(turnState) })` — session.js가 부른다. 기본값은 아무것도 안 하는 함수.
  - `session.uploadRecordingFor(messageId) -> Promise<boolean>` — `state.chunks`를 그 메시지에 올린다(성공 true). 기존 `uploadPendingRecording`은 그대로 둔다.
  - `shadow.js` exports: `startShadow(lines)`, `heard(transcript)`, `onTurn(turnState)`, `replay()`, `replaySlow()`, `peek()`, `retry()`, `nextLine()`, 테스트용 `shadowState()` → `{index, stage, peeked, revealed, saving}`; stage는 `'listen' | 'reveal'`.

화면 구조(`index.html`의 `.conversation-col` 맨 앞, `#conversation` 위):

```html
<!-- Shadowing's one card: the current line, heard first and read after.
     Its min-height is fixed so a stage change never moves the dock. -->
<section id="shadow-card" class="shadow-card" hidden>
  <p class="shadow-count" id="shadow-count"></p>
  <p class="shadow-status" id="shadow-status" aria-live="polite"></p>
  <div class="shadow-text is-invisible" id="shadow-text" aria-hidden="true"></div>
  <div class="shadow-said is-invisible" id="shadow-said" aria-hidden="true">
    <p id="shadow-mine"></p>
    <p id="shadow-verdict"></p>
    <span id="shadow-peeked" class="tag is-invisible">글자 보고 함</span>
  </div>
  <div class="shadow-actions" id="shadow-listen-actions">
    <button type="button" class="btn-stable" data-shadow="replay">다시 듣기</button>
    <button type="button" class="btn-stable" data-shadow="slow">천천히 듣기</button>
    <button type="button" class="btn-stable" data-shadow="peek">글자 보기</button>
  </div>
  <div class="shadow-actions" id="shadow-reveal-actions" hidden>
    <button type="button" class="btn-stable" data-shadow="native">▶ 원어민</button>
    <button type="button" class="btn-stable" data-shadow="mine">▶ 내 발음</button>
    <button type="button" class="btn-stable" data-shadow="retry">다시 하기</button>
    <button type="button" class="btn-stable primary" data-shadow="next">다음 줄 →</button>
  </div>
</section>
```

홈 카드(`#modes`의 스크립트 카드 뒤):

```html
<button type="button" data-mode="shadow" class="mode">
  <span class="n">쉐도잉</span><span class="d">원어민 소리를 듣고 바로 따라 말하기</span>
</button>
```

- [ ] **Step 1: audio 테스트** — `static/js/audio.test.js`에: `play('k', 't', null, { rate: 0.75 })`가 만든 `Audio`의 `playbackRate`가 0.75, 옵션 없이는 1(또는 설정 안 함). 이 파일이 이미 `Audio`를 가짜로 바꾸는 방식을 따른다(파일 안 기존 `play` 테스트를 보고 같은 스텁을 쓴다). 브라우저 음성 대체 경로는 `SpeechSynthesisUtterance.rate`에 같은 값.

- [ ] **Step 2: 실패 확인 → 구현** — `play(audioKey, fallbackText, onDone, { rate = 1 } = {})`: `clip.playbackRate = rate;`(생성 직후), `speakInBrowser(text, onDone, rate = 1)`에서 `u.rate = rate`. 기존 호출부는 그대로. 통과 확인.

- [ ] **Step 3: shadow 테스트** — 새 `static/js/shadow.test.js`. `session.test.js` 머리의 가짜 `SpeechRecognition` 설치와 동적 import 방식을 그대로 따른다(설명 주석 포함). 경로 스텁은 `stubFetch`. 필요한 테스트(각각 한 `test`):

```js
const LINES = [
  { speaker: 'bot', text: 'Morning! Ready for standup?', audio_key: 'a0' },
  { speaker: 'user', text: 'Yes, I am ready.', audio_key: 'a1' },
];
```

1. `startSession({language:'en', mode:'script', scenarioId:'x', shadowing:true})`(서버가 `{session_id:1, mode:'script', shadowing:true, lines: LINES}`) → `#shadow-card` 보임, `#conversation`에 말풍선 0개, `#btn-next`·`#btn-send`·`#text-input`·`#btn-suggest` 숨김, `#shadow-count`가 `1 / 2`, 대본 칸 `li` 2개가 모두 `●●●●●`, `shadowState().stage === 'listen'`, 첫 줄 오디오가 재생 요청됨(가짜 `Audio`의 src에 `a0`).
2. `replaySlow()` → 새로 만든 `Audio.playbackRate === 0.75`. `replay()` → 1.
3. `peek()` → `#shadow-text`가 보이고 원문을 담음, `shadowState().peeked === true`; 이어서 `heard('morning ready for standup')` → `/shadow-line` 본문 `{index:0, text:'morning ready for standup', peeked:true}`.
4. `heard('morning ready for standup')`, 서버 `{message_id: 7, matched: true}` → stage `'reveal'`, `#shadow-mine`이 `내 말: "morning ready for standup"`, `#shadow-verdict`가 `✓ 대본과 같아요`, `#shadow-reveal-actions` 보임·`#shadow-listen-actions` 숨김, 대본 칸 0번 `li`가 원문.
5. 서버 `matched:false` → `✗ 조금 달라요`.
6. `heard(null)` → `/shadow-line` 호출 없음, `#shadow-status`가 `못 알아들었어요. 다시 해보세요`, stage 그대로.
7. `retry()` 후 다시 `heard('x')` → 두 번째 본문도 `index: 0`.
8. `/shadow-line`이 500 → `#notice-text`가 `저장하지 못했어요`, stage `'listen'`, `#shadow-mine`에 방금 말이 남아 있음.
9. 마지막 줄에서 공개 뒤 `[data-shadow="next"]` 글자가 `끝! 리포트 보기`, `nextLine()`이 `/sessions/1/end`를 부른다(`endSession` 경유).
10. `nextLine()`(첫 줄 공개 뒤) → `#shadow-count` `2 / 2`, stage `'listen'`, `#shadow-text`·`#shadow-said`가 `.is-invisible`(자리 유지 — `hidden`이 아님), 두 번째 오디오 재생.
11. `onTurn('listening')` → `#shadow-status` `듣는 중...`; `onTurn('transcribing')` → `받아쓰는 중...`; `onTurn('idle')` → 비움.
12. 쉐도잉이 아닌 스크립트 세션을 이어서 시작하면 `#shadow-card` 숨김, `state.shadowing === false`, `#btn-next` 보임.
13. 저장이 끝나면 `uploadRecordingFor(7)`이 불린다: `state.chunks = ['x']`인 채로 `heard(...)` → `/sessions/1/audio` POST의 `message_id`가 7.

- [ ] **Step 4: 실패 확인** — `node --test --test-force-exit static/js/shadow.test.js` → 모듈 없음.

- [ ] **Step 5: session.js 구현**

```js
/* Shadowing (shadow.js) owns its own line card; session.js only hands it the
   session's lines, each final transcript, and each turn state. Injected, like
   audio.js's handlers, so neither module imports the other. */
let shadowHooks = { start() {}, heard() {}, turn() {} };
export function setShadowHooks(hooks) {
  shadowHooks = { ...shadowHooks, ...hooks };
}
```

- `setTurnState` 끝(`syncControls()` 뒤)에 `if (state.shadowing) shadowHooks.turn(turnState);`
- `sendHeard` 맨 앞:

```js
  // Shadowing judges a line on the server and keeps the attempt in its own
  // card; it never posts a turn. `sending` holds the mic while it saves.
  if (state.shadowing) {
    if (!transcript) {
      discardRecording();
      setTurnState('HEARD_NOTHING');
      shadowHooks.heard(null);
      return;
    }
    setTurnState('HEARD');
    shadowHooks.heard(transcript);
    return;
  }
```

- `startSession({ language, mode, scenarioId, topic, shadowing = false })`: payload에 `shadowing`, 성공 뒤 `state.shadowing = Boolean(data.shadowing)`; `$('shadow-card').hidden = !state.shadowing`; `$('text-input').hidden = state.shadowing`; `if (state.shadowing) shadowHooks.start(data.lines); else if (data.mode === 'script') startScript(data.lines); else { …기존… }`. 쉐도잉에서 `btn-next`·`btn-send`는 숨김.
- 새 export:

```js
/* The learner's recording for one known message -- shadowing knows its row id,
   and a retried line keeps it, so "the last user message" would be wrong. */
export async function uploadRecordingFor(messageId) {
  if (!state.chunks.length) return false;
  const blob = new Blob(state.chunks, { type: 'audio/webm' });
  state.chunks = [];
  try {
    const form = new FormData();
    form.append('message_id', messageId);
    form.append('file', blob, 'clip.webm');
    await api(`/sessions/${state.sessionId}/audio`, { method: 'POST', body: form });
    return true;
  } catch {
    return false;   // a recording never interrupts practice
  }
}
```

`api.js`의 `state`에 `shadowing: false`. `home.js`의 재개 경로(`resumeSession`)와 최근 테마 바로 시작은 `startSession`을 쓰므로 `shadowing` 기본값 false로 충분 — 재개 경로가 `startSession`을 거치지 않으면 거기서 `state.shadowing = false`와 `$('shadow-card').hidden = true`, `$('text-input').hidden = false`.

- [ ] **Step 6: shadow.js 구현** — 핵심 모양(주석은 파일 머리에 "왜 한 장의 카드인가, 왜 판정이 서버인가" 두 줄):

```js
import { $, postJSON, state, notify, setShown } from './api.js';
import { play } from './audio.js';
import { annotate, attachMeaning } from './reading.js';
import { setShadowHooks, endSession, uploadRecordingFor, setTurnState } from './session.js';

const SLOW = 0.75;
const HIDDEN_TEXT = '●●●●●';
let lines = [];
let index = 0;
let stage = 'listen';
let peeked = false;
let saving = false;
let lastMessageId = null;

export function shadowState() {
  return { index, stage, peeked, revealed: stage === 'reveal', saving };
}

export function startShadow(newLines) {
  lines = newLines;
  index = 0;
  $('side-panel').hidden = false;
  $('panel-title').textContent = '쉐도잉';
  const ol = document.createElement('ol');
  lines.forEach((l, i) => {
    const li = document.createElement('li');
    li.dataset.i = String(i);
    const who = document.createElement('b');
    who.textContent = l.speaker === 'bot' ? '봇' : '나';
    const text = document.createElement('span');
    text.className = 'line shadow-hidden';
    text.textContent = HIDDEN_TEXT;
    li.append(who, document.createTextNode(' '), text);
    ol.append(li);
  });
  $('panel-body').replaceChildren(ol);
  showLine();
}

function showLine() {
  const line = lines[index];
  stage = 'listen';
  peeked = false;
  lastMessageId = null;
  $('shadow-count').textContent = `${index + 1} / ${lines.length}`;
  $('shadow-status').textContent = '';
  $('shadow-text').textContent = line.text;
  setShown($('shadow-text'), false);
  setShown($('shadow-said'), false);
  setShown($('shadow-peeked'), false);
  $('shadow-listen-actions').hidden = false;
  $('shadow-reveal-actions').hidden = true;
  $('panel-body').querySelectorAll('li').forEach((li, i) => li.classList.toggle('current', i === index));
  play(line.audio_key, line.text);
}
```

나머지 함수:
- `replay()` → `play(line.audio_key, line.text)`; `replaySlow()` → `play(..., null, { rate: SLOW })`.
- `peek()` → `peeked = true`, `setShown($('shadow-text'), true)`, 일본어면 `annotate([{el: $('shadow-text'), text}])`(한 줄에 한 번만 — 이미 했으면 안 함).
- `heard(transcript)`:
  - `null` → `$('shadow-status').textContent = '못 알아들었어요. 다시 해보세요'`, 끝.
  - 아니면 `saving = true`, `$('shadow-mine').textContent = \`내 말: "${transcript}"\``, `postJSON(\`/sessions/${state.sessionId}/shadow-line\`, {index, text: transcript, peeked})`.
  - 성공 → `setTurnState('REPLY'); setTurnState('AUDIO_DONE');`(마이크를 다시 연다), `lastMessageId = message_id`, `await uploadRecordingFor(message_id)`, `reveal(matched)`.
  - 실패 → `setTurnState('SEND_FAILED')`, `notify('저장하지 못했어요')`, `setShown($('shadow-said'), true)`(내 말은 남긴다), stage `'listen'`.
  - `finally saving = false`.
- `reveal(matched)` → stage `'reveal'`, `#shadow-verdict` 글자와 `good`/`bad` 클래스, `setShown($('shadow-text'), true)`, `setShown($('shadow-said'), true)`, `setShown($('shadow-peeked'), peeked)`, 버튼 묶음 교체, 대본 칸 그 줄을 원문으로(한 번만: `shadow-hidden` 클래스를 지우고 `textContent = line.text`, 일본어 `annotate`, 영어 `attachMeaning`), 마지막 줄이면 `[data-shadow="next"]` 글자 `끝! 리포트 보기`, 아니면 `다음 줄 →`.
- `retry()` → stage `'listen'`으로 되돌리되 원문은 보인 채(`peeked`는 유지, `#shadow-said` 숨김, 버튼 묶음 교체). 마이크는 학습자가 누른다.
- `nextLine()` → 마지막 줄이면 `endSession()`, 아니면 `index += 1; showLine()`.
- `mine()`(▶ 내 발음) → `lastMessageId`가 있으면 `new Audio(\`/api/messages/${lastMessageId}/audio\`).play()`; 없으면 버튼을 `disabled`.
- `onTurn(t)` → `listening`: `듣는 중...`, `transcribing`: `받아쓰는 중...`, 그 밖: 저장 중이 아니면 비움.
- 파일 끝: `setShadowHooks({ start: startShadow, heard, turn: onTurn });`

`main.js`: `import './shadow.js';` 그리고 `#shadow-card`에 클릭 위임 한 번 — `data-shadow` 값별로 `replay/replaySlow/peek/native(=replay)/mine/retry/nextLine`. 저장 중(`shadowState().saving`)에는 무시.

- [ ] **Step 7: pick 연결 + 테스트** — `pick.js`:
  - `MODE_LABELS`에 `shadow: '쉐도잉'`.
  - `openPick(mode)`: `state.shadowing = mode === 'shadow'; state.mode = mode === 'shadow' ? 'script' : mode;` 제목은 원래 `mode`로(`쉐도잉`).
  - `startFromPick`에서 `startSession({... , shadowing: state.shadowing})` — 캡처는 `language`/`mode`와 같은 자리에서 한 번.
  - 스크립트 시작 대기 문구 자리(`STATUS`)에 쉐도잉이면 `음성 준비 중...`.
  - `pick.test.js`: `openPick('shadow')` → `$('pick-mode').textContent === '쉐도잉'`, `state.mode === 'script'`, `state.shadowing === true`; 이어 `openPick('script')` → `state.shadowing === false`; 쉐도잉으로 시작하면 `/api/sessions` 본문에 `shadowing: true`.

- [ ] **Step 8: CSS** — `components.css`, 기존 토큰만:

```css
/* Shadowing's line card: one fixed box whose parts fade in and out in place. */
.shadow-card { min-height: 15rem; display: grid; align-content: start; gap: var(--space-3, 12px);
  padding: var(--space-4, 16px); border: 1px solid var(--line); border-radius: var(--radius, 12px);
  background: var(--surface); }
.shadow-count { color: var(--muted); font-size: .875rem; }
.shadow-status { min-height: 1.5em; color: var(--muted); }
.shadow-text { font-size: 1.25rem; line-height: 1.6; min-height: 2em; }
.shadow-said { min-height: 3.5em; }
#shadow-verdict.good { color: var(--good); }
#shadow-verdict.bad { color: var(--bad); }
.shadow-actions { display: flex; flex-wrap: wrap; gap: var(--space-2, 8px); }
.side-panel .shadow-hidden { color: var(--muted); letter-spacing: .15em; }
```

토큰 이름(`--line`, `--surface`, `--muted`, `--good`, `--bad`, 간격·반경)은 `static/css/tokens.css`(또는 실제 토큰 파일)에서 확인해 있는 것만 쓴다. 없는 것은 가장 가까운 기존 토큰으로. `tests/test_*css*.py`에 CSS 규칙 검사 방식이 있으면 `.shadow-card`의 `min-height`를 고정하는 검사를 하나 추가한다.

- [ ] **Step 9: 통과 확인** — `node --test --test-force-exit static/js/*.test.js` → 전부 PASS(기준 256 + 새 것). 부수기: ① `sendHeard`의 쉐도잉 분기를 지워 테스트 4가 빨개지는지 ② `retry()`가 `index`를 올리게 바꿔 테스트 7이 빨개지는지 ③ `showLine`의 `setShown(..., false)`를 `hidden = true`로 바꿔 테스트 10이 빨개지는지.

- [ ] **Step 10: 커밋**

```bash
git add static/ tests/
git commit -m "feat: shadowing on screen -- a home card, and one line card that is heard, said, then shown"
```

---

### Task 4: 화면 — 쉐도잉 리포트와 목록 표시

**Files:**
- Modify: `static/js/session.js` (`renderReport`), `static/js/mypage.js` (지난 기록 줄, 모드 이름, 복습 카드 라벨, `openReport`), `static/js/home.js` (최근 연습 모드 이름), `static/index.html`(필요하면 리포트 틀)
- Test: `static/js/session.test.js` 또는 새 `static/js/report.test.js`, `static/js/mypage.test.js`, `static/js/home.test.js`

**Interfaces:**
- Consumes: Task 2의 `kind: 'shadow'` 리포트, 목록 항목의 `shadowing`.

- [ ] **Step 1: 테스트**
  - `renderReport({kind:'shadow', stats:{turns:3, minutes:2}, shadow:{lines:16, done:3, matched:2, peeked:1, hard:[{index:1, said:'banana', target:'Yes, I am ready.', message_id:5, audio_key:'k'}]}})`:
    - `#report-headline` `3줄을 따라 말했어요.`
    - `#report-counts` `따라 한 줄 3/16 · 대본과 같음 2 · 글자 보고 함 1`
    - `#report-body`에 `어려웠던 줄` 카드 하나: `banana`(내 말), `Yes, I am ready.`(대본), `▶ 원어민` 버튼(누르면 `k` 재생), 카드 아래 `이 줄들은 내일 복습에 나와요`. `총평`·`부족한 부분`·`외워둘 표현`·`다음엔 이것을` 카드는 없음.
    - `#rep-wrong` `—`, `#rep-turns` `3`, `#rep-minutes` `2`, 누적 약점(`/stats/home`)은 부르지 않고 `#report-weak` 숨김.
  - `hard: []` → `전부 대본대로 따라 했어요 🎉`.
  - 마이페이지 지난 기록: `{mode:'script', shadowing:true, turns:3, …}` → 부제 `따라 한 줄 3 · 쉐도잉`, 모드 이름 `쉐도잉`. 스크립트 줄은 그대로 `말한 문장 3 · 대본`.
  - 마이페이지 복습 카드 `{shadowing:true, text:'banana', fixed:'Yes, I am ready.', tag:null}` → 라벨 `내 말` / `대본`, 꼬리표 `쉐도잉`, 취소선 없음. 일반 카드는 그대로 `내가 한 말` / `고친 문장`.
  - 홈 최근 연습 `{mode:'script', shadowing:true}` → 모드 이름 `쉐도잉`.
  - 마이페이지 `openReport`가 쉐도잉 리포트(`kind:'shadow'`)를 열면 위와 같은 쉐도잉 리포트가 그려진다.

- [ ] **Step 2: 실패 확인** — 해당 node 파일들 → FAIL.

- [ ] **Step 3: 구현**
  - `renderReport(data)` 맨 앞: `if (data.kind === 'shadow') { renderShadowReport(data); return; }`. `renderShadowReport`는 같은 파일의 `reportCard` 옆에 둔다; 어려웠던 줄 행은 기존 `.fix-row` 모양(`p.said` = 내 말, `p.fixed` = 대본)에 `▶ 원어민` 버튼(`play(h.audio_key, h.target)`), 행 목록 뒤 안내 문장. `loadWeakPoints`는 부르지 않고 `$('report-weak').hidden = true`.
  - `mypage.js`: `MODE_NAMES` 조회를 `item.shadowing ? '쉐도잉' : MODE_NAMES[item.mode]`로 바꾸는 작은 도우미 `modeName(item)`를 두고 목록·부제에 쓴다; `historySub`에서 `item.shadowing`이면 `따라 한 줄 ${item.turns} · 쉐도잉`(script 분기보다 먼저). `reviewCard`: `item.shadowing`이면 `said` 라벨 `내 말`, 문장은 `el('span', '', item.text)`(취소선 없음), `fixed` 라벨 `대본`, 태그 칩 자리에 `el('span', 'tag', '쉐도잉')`.
  - `home.js` 최근 연습: 같은 규칙으로 `쉐도잉`.

- [ ] **Step 4: 통과 확인** — `node --test --test-force-exit static/js/*.test.js` → PASS. 부수기: `renderReport`의 `kind` 분기를 지워 리포트 테스트가 빨개지는지.

- [ ] **Step 5: 커밋**

```bash
git add static/
git commit -m "feat: the shadowing report, and 쉐도잉 in the lists and review cards"
```

---

## 컨트롤러 마무리(태스크 아님)

1. 대본 생성을 잠시 멈추고 전체 스위트: pytest `-m "not engine"` + node. 결과 기록 후 생성 재개.
2. 8010(복사한 DB)에서 브라우저 확인: 홈 카드 → #pick 제목 쉐도잉 → 시작 대기 문구 → 카드 단계 전환에 도크가 움직이지 않는지 → 글자 보기/천천히 듣기 → 대본 칸 공개 → 마지막 줄 → 리포트 → 마이페이지 기록·복습 카드.
3. 브랜치 최종 리뷰 → 수정 → 본 DB 백업 → main 머지 → 8000 재시작(v7) → 사용자 마이크 실사용 부탁.
