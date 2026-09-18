# 마이페이지 (Phase 2 D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레벨 카드, 오늘의 복습(간격 반복), 자주 걸리는 것, 지난 기록을 담은 마이페이지와 홈의 오늘 복습 카드를 만든다.

**Architecture:** `review_queue`(스키마 v6)가 고친 문장을 문장 단위로 들고, `/api/chat`이 넣고 되돌리기가 뺀다. 마이페이지 데이터는 새 라우트들(`/api/stats/mypage`, `/api/review*`, `/api/sessions/history`, `/api/sessions/{id}/report`)이 준다. 화면은 새 `static/js/mypage.js`, 말해보기는 기존 `session.startRespeak`에 결과 콜백을 더해 그대로 쓴다.

**Tech Stack:** FastAPI, SQLite, pytest, 브라우저 ES 모듈 + `node --test`(dom-shim).

**Spec:** `docs/superpowers/specs/2026-09-14-monologue-mypage-design.md`

## Global Constraints

- 작업 위치: 워크트리 `C:/git/Monologue-wt/mypage`, 브랜치 `mypage`. `C:/git/Monologue`는 건드리지 않는다(사용자 서버 + 대본 일괄 생성이 그 DB에 쓰는 중).
- 파이썬 `C:/git/Monologue/venv/Scripts/python.exe`, 워크트리 루트, `-m "not engine"`. engine 테스트 금지(GPU 사용 중).
- 기준선(main `5596d7d`): pytest 565(워크트리 564 + 알려진 `test_kokoro_model_files_are_present` 1), node 164.
- 날짜는 로컬. 복습 `due_date`는 로컬 `YYYY-MM-DD`.
- 레벨 기준: 끝낸 세션 **3**, 발화 **15**. 복습 간격 **1→3→7→14**, **3번** 통과로 익힘, 목록 최대 **20**, 정확도 **최근 30일**, 기록 **20개씩**.
- 문구(그대로): `마이페이지`, `← 홈`, `지금 레벨 `, `최근 세션들에서 가장 많이 나온 판정이에요`, `판정하기엔 아직 일러요`, `세션 <n>/3 · 발화 <m>/15`, `오늘의 복습 <N>개`, `익힌 문장 <K>개`, `내가 한 말`, `고친 문장`, `▸ 설명`, `▶ 듣기`, `🎤 말해보기`, `다음에`, `음성 준비 중...`, `익혔어요 🎉`, `조금 달라요. 내일 다시 볼게요`, `못 알아들었어요. 다시 해보세요`, `오늘 복습할 문장이 없어요`, `대화에서 고친 문장이 여기 모여요`, `문장 정확도 <p>% · 최근 30일 채점된 <n>문장`, `아직 틀린 문장이 없어요`, `<태그>  <n>회`, `말한 문장 <t> · 고친 곳 <w>`, `리포트 보기`, `대화 보기`, `더 보기`, `불러오는 중...`, `← 마이페이지`, `오늘 복습할 문장 <N>개`, `복습하러 가기 →`, `기록 더 보기 →`. 레벨 이름 `초급/중급/고급`, 모드 이름 `자유 상황극/스크립트/수업`.
- 통과 문구: `좋아요! <다음 안내>` -- 다음 안내는 `<interval_d>일 뒤에 다시 볼게요`.
- 새 가드마다 부숴 빨개지는지 확인하고 되돌린다.
- 커밋 메시지 끝:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9
  ```

---

### Task 1: `review_queue`와 넣고 빼기

**Files:**
- Modify: `app/db.py` (MIGRATIONS 끝, `delete_last_turn`, 파일 끝), `app/api.py` (`chat_turn`)
- Test: `tests/test_db.py`, `tests/test_api_chat.py`

**Interfaces:**
- Produces:
  - `db.enqueue_review(message_id: int, language: str, due: date) -> None` (중복 무시)
  - `db.due_reviews(language, today: date, limit=20) -> list[dict]` -- `{id, message_id, text, fixed, correction, tag, created_at, interval_d, passes}`
  - `db.review_counts(language, today: date) -> {"due": int, "mastered": int}`
  - `db.record_review(review_id: int, result: str, today: date) -> dict` -- `{id, passes, interval_d, due_date, mastered}`; 없으면 `KeyError`, 익힌 것이면 `ValueError`, result가 셋 중 하나가 아니면 `ValueError`
  - `db.REVIEW_INTERVALS = (1, 3, 7, 14)`, `db.REVIEW_PASSES_TO_MASTER = 3`

- [ ] **Step 1: 실패하는 테스트** — `tests/test_db.py` 끝:

```python
from datetime import date


def _wrong_turn(store, language="en", mode="free", text="I go there", fixed="I went there."):
    sid = store.create_session(language, mode)
    return store.add_message(sid, "user", text, correction="c", ok=0, fixed=fixed, tag="시제")


def test_v6_creates_review_queue_and_backfills_past_corrections(tmp_path, monkeypatch):
    from app import config
    import sqlite3
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "old.db")
    store = __import__("app.db", fromlist=["db"])
    store.init_db()
    with store.connect() as conn:            # simulate a v5 database with history
        conn.execute("DROP TABLE review_queue")
        conn.execute("PRAGMA user_version = 5")
    wrong = _wrong_turn(store)
    _wrong_turn(store, mode="script")                         # script sessions are skipped
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "fine", ok=1, fixed="fine")  # correct turns are skipped
    store.add_message(sid, "user", "no fix", ok=0, fixed=None)  # nothing to practise
    store.init_db()
    store.init_db()                                            # idempotent
    with store.connect() as conn:
        rows = conn.execute("SELECT message_id, language, due_date FROM review_queue").fetchall()
    assert [(r["message_id"], r["language"]) for r in rows] == [(wrong, "en")]
    assert rows[0]["due_date"] == date.today().isoformat()


def test_enqueue_is_idempotent_and_due_reviews_filter(store):
    a = _wrong_turn(store)
    b = _wrong_turn(store, text="She have", fixed="She has.")
    c = _wrong_turn(store, language="ja", text="行きます", fixed="行きました。")
    store.enqueue_review(a, "en", date(2026, 9, 13))
    store.enqueue_review(a, "en", date(2026, 9, 20))          # ignored
    store.enqueue_review(b, "en", date(2026, 9, 15))          # future
    store.enqueue_review(c, "ja", date(2026, 9, 1))
    due = store.due_reviews("en", date(2026, 9, 14))
    assert [d["message_id"] for d in due] == [a]
    assert due[0]["text"] == "I go there" and due[0]["fixed"] == "I went there." and due[0]["tag"] == "시제"
    assert store.review_counts("en", date(2026, 9, 14)) == {"due": 1, "mastered": 0}


def test_due_reviews_oldest_first_and_capped(store):
    ids = []
    for n in range(25):
        m = _wrong_turn(store, text=f"t{n}", fixed=f"f{n}.")
        store.enqueue_review(m, "en", date(2026, 9, 1 + (n % 5)))
        ids.append(m)
    due = store.due_reviews("en", date(2026, 9, 14))
    assert len(due) == 20
    assert [d["created_at"] <= e["created_at"] or d["id"] < e["id"] for d, e in zip(due, due[1:])]
    dates = [store.get_review(d["id"])["due_date"] for d in due]
    assert dates == sorted(dates)


def test_record_review_follows_the_interval_table(store):
    m = _wrong_turn(store)
    store.enqueue_review(m, "en", date(2026, 9, 14))
    rid = store.due_reviews("en", date(2026, 9, 14))[0]["id"]
    today = date(2026, 9, 14)
    r = store.record_review(rid, "pass", today)
    assert (r["passes"], r["interval_d"], r["due_date"], r["mastered"]) == (1, 3, "2026-09-17", False)
    r = store.record_review(rid, "fail", today)
    assert (r["passes"], r["interval_d"], r["due_date"]) == (0, 1, "2026-09-15")
    r = store.record_review(rid, "skip", today)
    assert (r["passes"], r["interval_d"], r["due_date"]) == (0, 1, "2026-09-15")
    store.record_review(rid, "pass", today)                   # 1 -> interval 3
    r = store.record_review(rid, "pass", today)               # 2 -> interval 7
    assert (r["passes"], r["interval_d"]) == (2, 7)
    r = store.record_review(rid, "pass", today)               # 3 -> mastered
    assert r["mastered"] is True and r["passes"] == 3
    assert store.review_counts("en", date(2026, 9, 30)) == {"due": 0, "mastered": 1}
    with pytest.raises(ValueError):
        store.record_review(rid, "pass", today)
    with pytest.raises(KeyError):
        store.record_review(99999, "pass", today)
    other = _wrong_turn(store, text="x", fixed="y.")
    store.enqueue_review(other, "en", today)
    with pytest.raises(ValueError):
        store.record_review(store.due_reviews("en", today)[0]["id"], "maybe", today)


def test_interval_stops_at_fourteen(store, monkeypatch):
    monkeypatch.setattr(store, "REVIEW_PASSES_TO_MASTER", 10)
    m = _wrong_turn(store)
    store.enqueue_review(m, "en", date(2026, 9, 14))
    rid = store.due_reviews("en", date(2026, 9, 14))[0]["id"]
    intervals = [store.record_review(rid, "pass", date(2026, 9, 14))["interval_d"] for _ in range(5)]
    assert intervals == [3, 7, 14, 14, 14]


def test_undo_removes_the_review_of_the_undone_turn(store):
    sid = store.create_session("en", "free")
    m = store.add_message(sid, "user", "I go", ok=0, fixed="I went.")
    store.add_message(sid, "bot", "ok")
    store.enqueue_review(m, "en", date(2026, 9, 14))
    store.delete_last_turn(sid)
    assert store.due_reviews("en", date(2026, 9, 30)) == []
```

(`pytest` import와 `store` 픽스처는 이 파일의 기존 것. `get_review(id)`도 Produces에 더한다: `{id, message_id, language, due_date, interval_d, passes, mastered_at}` 또는 None. 첫 테스트는 이 파일의 기존 마이그레이션 테스트가 v5 DB를 흉내 내는 방식이 따로 있으면 그 방식을 따른다.)

`tests/test_api_chat.py` 끝(기존 `client`, `fake_engines` 픽스처 사용):

```python
def test_a_corrected_turn_is_queued_for_review_tomorrow(client, monkeypatch):
    from datetime import date, timedelta
    from app import api
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 14))
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there"})
    assert db.due_reviews("en", date(2026, 9, 14)) == []
    due = db.due_reviews("en", date(2026, 9, 15))
    assert len(due) == 1 and due[0]["fixed"] == "I went there."


def test_correct_and_neutralised_turns_are_not_queued(client, monkeypatch):
    from datetime import date
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {
        "ok": False, "fixed": "Card, please.", "tag": "어순", "correction": "c", "suggestion": None})
    client.post("/api/chat", json={"session_id": sid, "text": "Card please"})    # punctuation only
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {
        "ok": True, "fixed": "Fine.", "tag": "없음", "correction": "c", "suggestion": None})
    client.post("/api/chat", json={"session_id": sid, "text": "Fine."})
    assert db.due_reviews("en", date(2030, 1, 1)) == []
```

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현**

`app/db.py` `MIGRATIONS` 끝에 v5→v6 단계(스펙의 SQL 세 문장을 한 문자열이나 리스트로; 주석: 스펙 경로, 백필 이유 -- 원래 설계는 테스트 데이터뿐이라 백필하지 않기로 했지만 지금은 진짜 기록이다, 대본 세션은 교정을 비웠으므로 제외).

`delete_last_turn`: `DELETE FROM messages` 앞에 같은 연결에서
```python
        conn.execute(
            "DELETE FROM review_queue WHERE message_id IN"
            " (SELECT id FROM messages WHERE session_id = ? AND turn >= ?)",
            (session_id, last_user["turn"]),
        )
```

파일 끝:

```python
REVIEW_INTERVALS = (1, 3, 7, 14)
REVIEW_PASSES_TO_MASTER = 3


def enqueue_review(message_id, language, due) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO review_queue (message_id, language, due_date, created_at)"
            " VALUES (?, ?, ?, ?)", (message_id, language, due.isoformat(), _now()))


def get_review(review_id):
    with connect() as conn:
        row = conn.execute("SELECT * FROM review_queue WHERE id = ?", (review_id,)).fetchone()
    return dict(row) if row else None


def due_reviews(language, today, limit=20) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT r.id, r.message_id, m.text, m.fixed, m.correction, m.tag, r.created_at,"
            "       r.interval_d, r.passes"
            " FROM review_queue r JOIN messages m ON m.id = r.message_id"
            " WHERE r.language = ? AND r.mastered_at IS NULL AND r.due_date <= ?"
            " ORDER BY r.due_date, r.id LIMIT ?", (language, today.isoformat(), limit)).fetchall()
    return [dict(r) for r in rows]


def review_counts(language, today) -> dict:
    with connect() as conn:
        due = conn.execute(
            "SELECT COUNT(*) FROM review_queue WHERE language = ? AND mastered_at IS NULL AND due_date <= ?",
            (language, today.isoformat())).fetchone()[0]
        mastered = conn.execute(
            "SELECT COUNT(*) FROM review_queue WHERE language = ? AND mastered_at IS NOT NULL",
            (language,)).fetchone()[0]
    return {"due": due, "mastered": mastered}


def record_review(review_id, result, today) -> dict:
    """Spaced repetition, one sentence at a time (spec table). pass climbs the
    interval ladder and masters on the third pass; fail starts over; skip only
    moves the card to tomorrow."""
    if result not in ("pass", "fail", "skip"):
        raise ValueError(result)
    with connect() as conn:
        row = conn.execute("SELECT * FROM review_queue WHERE id = ?", (review_id,)).fetchone()
        if row is None:
            raise KeyError(review_id)
        if row["mastered_at"] is not None:
            raise ValueError("already mastered")
        passes, interval, mastered_at = row["passes"], row["interval_d"], None
        if result == "pass":
            passes += 1
            steps = [i for i in REVIEW_INTERVALS if i > interval]
            interval = steps[0] if steps else REVIEW_INTERVALS[-1]
            if passes >= REVIEW_PASSES_TO_MASTER:
                mastered_at = _now()
            due = today + timedelta(days=interval)
        elif result == "fail":
            passes, interval = 0, REVIEW_INTERVALS[0]
            due = today + timedelta(days=1)
        else:
            due = today + timedelta(days=1)
        conn.execute("UPDATE review_queue SET passes = ?, interval_d = ?, due_date = ?, mastered_at = ?"
                     " WHERE id = ?", (passes, interval, due.isoformat(), mastered_at, review_id))
    return {"id": review_id, "passes": passes, "interval_d": interval, "due_date": due.isoformat(),
            "mastered": mastered_at is not None}
```

(`timedelta`가 `app/db.py`에 이미 import돼 있는지 확인. `test_interval_stops_at_fourteen`이 `store.REVIEW_PASSES_TO_MASTER`를 몽키패치하므로 `record_review`는 모듈 전역을 호출 시점에 읽어야 한다 -- 위 코드는 그렇다.)

`app/api.py` `chat_turn`: `db.add_message(... user ...)`의 반환값을 받고, 저장 직후

```python
    if feedback["ok"] is False and feedback["fixed"]:
        # Tomorrow, not today: the learner just saw the fix. Spec: mypage design.
        db.enqueue_review(message_id, language, _today() + timedelta(days=1))
```

(`_today`와 `timedelta`는 홈 대시보드가 이미 api.py에 들여왔다.)

- [ ] **Step 4: GREEN** — 전체 `-m "not engine"`. 스키마 버전을 숫자로 확인하는 기존 테스트가 있으면 `len(MIGRATIONS)` 기준인지 확인.

- [ ] **Step 5: 부수기** — (1) 백필 INSERT의 `s.mode <> 'script'` 삭제: v6 테스트 FAIL. (2) `delete_last_turn`의 review 삭제 제거: undo 테스트 FAIL. (3) `steps[0] if steps else` → `interval * 3`: 간격 테스트 FAIL. (4) chat의 `feedback["ok"] is False` → `not feedback["ok"]`: 중립 테스트 FAIL(중립 턴 ok=True는 통과하므로 대신 ok=None 채점 실패 턴이 들어가는지로 확인 -- 채점 실패는 fixed가 None이라 안 들어가야 한다; 해당 케이스가 테스트에 없으면 부수기 결과를 보고하고 케이스를 추가). 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: a review queue that holds every corrected sentence, one at a time`

---

### Task 2: 마이페이지 API

**Files:**
- Modify: `app/api.py`, `app/db.py`(집계 함수)
- Create: `tests/test_api_mypage.py`

**Interfaces:**
- Consumes: Task 1 전부, `db.stable_level`, `db.session_stats`, `db.active_minutes`, `api._today`, `api._speak`, `api._recent_row`의 제목 규칙.
- Produces: 스펙 "API" 표 그대로. 새 db 함수:
  - `db.level_sample(language) -> {"sessions": int, "utterances": int}` -- 리포트 있는 세션 수, 그 언어 학습자 발화 수(대본 포함)
  - `db.accuracy_since(language, since: date) -> {"correct": int, "graded": int}` -- 대본 세션 제외, `ok` NOT NULL, 로컬 날짜 기준
  - `db.wrong_tag_counts(language) -> list[{"tag","n"}]` -- `없음`·NULL 제외, n DESC, tag
  - `db.history(language, offset, limit) -> list[dict]` -- 리포트 있는 세션, `ended_at DESC, id DESC`, `{id, scenario_id, topic, mode, ended_at, turns, wrong}`

- [ ] **Step 1: 실패하는 테스트** — `tests/test_api_mypage.py`:

```python
import json
from datetime import date

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
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 14))
    return TestClient(app)


def _finished(language="en", mode="free", scenario_id="airport-checkin-en", turns=(), level="beginner", report=None):
    sid = db.create_session(language, mode, scenario_id=scenario_id)
    ids = []
    for text, ok, fixed, tag in turns:
        ids.append(db.add_message(sid, "user", text, correction="설명", ok=ok, fixed=fixed, tag=tag))
        db.add_message(sid, "bot", "reply")
    db.end_session(sid, report if report is not None else json.dumps({"summary": "좋았어요", "weak_points": [],
                                                                     "expressions": [], "next_focus": "x"},
                                                                    ensure_ascii=False), level)
    return sid, ids


def test_level_withheld_until_the_sample_is_big_enough(client):
    _finished(turns=[("a", 1, None, None)] * 5)
    body = client.get("/api/stats/mypage?language=en").json()
    assert body["level"] == {"value": None, "sessions": 1, "utterances": 5,
                             "need_sessions": 3, "need_utterances": 15}


def test_level_shown_once_both_thresholds_are_met(client):
    for _ in range(3):
        _finished(turns=[("a", 1, None, None)] * 5, level="intermediate")
    level = client.get("/api/stats/mypage?language=en").json()["level"]
    assert level["value"] == "intermediate" and level["sessions"] == 3 and level["utterances"] == 15


def test_accuracy_tags_and_review_counts(client):
    _finished(turns=[("I go", 0, "I went.", "시제"), ("She have", 0, "She has.", "단복수"),
                     ("I goed", 0, "I went.", "시제"), ("fine", 1, None, "없음"), ("?", None, None, None)])
    _finished(mode="script", scenario_id="standup-meeting-en", turns=[("read", 0, "x.", "어순")])
    body = client.get("/api/stats/mypage?language=en").json()
    assert body["accuracy"] == {"correct": 1, "graded": 4}
    assert body["tags"][:2] == [{"tag": "시제", "n": 2}, {"tag": "단복수", "n": 1}] or body["tags"][0] == {"tag": "시제", "n": 2}
    assert all(t["tag"] != "없음" for t in body["tags"])
    assert body["review"] == {"due": 0, "mastered": 0}


def test_review_list_result_and_audio(client):
    _, ids = _finished(turns=[("I go", 0, "I went.", "시제")])
    db.enqueue_review(ids[0], "en", date(2026, 9, 14))
    items = client.get("/api/review?language=en").json()["items"]
    assert [(i["text"], i["fixed"], i["tag"]) for i in items] == [("I go", "I went.", "시제")]
    rid = items[0]["id"]
    assert client.post(f"/api/review/{rid}/audio").json()["audio_key"]
    r = client.post(f"/api/review/{rid}/result", json={"result": "pass"}).json()
    assert r["passes"] == 1 and r["due_date"] == "2026-09-17" and r["mastered"] is False
    assert client.get("/api/review?language=en").json()["items"] == []
    assert client.post(f"/api/review/{rid}/result", json={"result": "later"}).status_code == 422
    assert client.post("/api/review/999/result", json={"result": "pass"}).status_code == 404
    assert client.post("/api/review/999/audio").status_code == 404


def test_review_on_a_mastered_sentence_is_409(client):
    _, ids = _finished(turns=[("I go", 0, "I went.", "시제")])
    db.enqueue_review(ids[0], "en", date(2026, 9, 1))
    rid = db.due_reviews("en", date(2026, 9, 14))[0]["id"]
    for _ in range(3):
        client.post(f"/api/review/{rid}/result", json={"result": "pass"})
    assert client.post(f"/api/review/{rid}/result", json={"result": "pass"}).status_code == 409


def test_review_audio_is_null_when_tts_is_down(client, monkeypatch):
    _, ids = _finished(turns=[("I go", 0, "I went.", "시제")])
    db.enqueue_review(ids[0], "en", date(2026, 9, 14))
    rid = db.due_reviews("en", date(2026, 9, 14))[0]["id"]
    def dead(t, l, v):
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", dead)
    assert client.post(f"/api/review/{rid}/audio").json() == {"audio_key": None}


def test_history_pages_newest_first_with_titles_and_counts(client):
    for n in range(23):
        _finished(turns=[("I go", 0, "I went.", "시제"), ("fine", 1, None, "없음")])
    _finished(mode="script", scenario_id="standup-meeting-en", turns=[("read", None, None, None)])
    open_sid = db.create_session("en", "free", scenario_id="airport-checkin-en")   # no report: excluded
    first = client.get("/api/sessions/history?language=en").json()
    assert len(first["items"]) == 20 and first["more"] is True
    assert first["items"][0]["mode"] == "script" and first["items"][0]["title"]
    free = first["items"][1]
    assert (free["turns"], free["wrong"]) == (2, 1)
    rest = client.get("/api/sessions/history?language=en&offset=20").json()
    assert len(rest["items"]) == 4 and rest["more"] is False
    assert all(i["id"] != open_sid for i in first["items"] + rest["items"])


def test_history_is_not_swallowed_by_the_session_id_route(client):
    assert client.get("/api/sessions/history?language=ja").status_code == 200


def test_report_route_json_prose_and_missing(client):
    sid, _ = _finished(turns=[("I go", 0, "I went.", "시제")])
    body = client.get(f"/api/sessions/{sid}/report").json()
    assert body["summary"] == "좋았어요" and body["mode"] == "free"
    assert body["stats"]["turns"] == 1 and body["stats"]["wrong"] == 1 and "minutes" in body["stats"]
    prose, _ = _finished(report="옛날 산문 리포트입니다.")
    assert client.get(f"/api/sessions/{prose}/report").json()["summary"] == "옛날 산문 리포트입니다."
    open_sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    assert client.get(f"/api/sessions/{open_sid}/report").status_code == 404
    assert client.get("/api/sessions/99999/report").status_code == 404


def test_home_stats_carries_todays_review(client):
    _, ids = _finished(turns=[("I go", 0, "I went.", "시제"), ("She have", 0, "She has.", "단복수")])
    for m in ids:
        db.enqueue_review(m, "en", date(2026, 9, 14))
    review = client.get("/api/stats/home?language=en").json()["review"]
    assert review["due"] == 2 and review["first"]["fixed"] == "I went."
    assert client.get("/api/stats/home?language=ja").json()["review"] == {"due": 0, "first": None}
```

(`test_accuracy_tags_and_review_counts`의 태그 단언은 동률 정렬(tag 오름차순)이 확정되면 정확한 리스트 비교로 좁힌다. `db.end_session`이 `ended_at`을 같은 초에 여러 개 찍어도 `id DESC`로 순서가 정해지는지 확인한다.)

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현**

`app/db.py` 끝:

```python
def level_sample(language) -> dict:
    with connect() as conn:
        sessions = conn.execute("SELECT COUNT(*) FROM sessions WHERE language = ? AND report IS NOT NULL",
                                (language,)).fetchone()[0]
        utterances = conn.execute(
            "SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user'", (language,)).fetchone()[0]
    return {"sessions": sessions, "utterances": utterances}


def accuracy_since(language, since) -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(m.ok = 1), 0) correct, COUNT(*) graded"
            " FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND s.mode <> 'script' AND m.speaker = 'user' AND m.ok IS NOT NULL"
            "   AND substr(datetime(m.created_at, 'localtime'), 1, 10) >= ?",
            (language, since.isoformat())).fetchone()
    return {"correct": row["correct"], "graded": row["graded"]}


def wrong_tag_counts(language) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT m.tag, COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user' AND m.ok = 0"
            "   AND m.tag IS NOT NULL AND m.tag <> '없음'"
            " GROUP BY m.tag ORDER BY n DESC, m.tag", (language,)).fetchall()
    return [{"tag": r["tag"], "n": r["n"]} for r in rows]


def history(language, offset, limit) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT s.id, s.scenario_id, s.topic, s.mode, s.ended_at,"
            "  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.speaker = 'user') turns,"
            "  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.speaker = 'user' AND m.ok = 0) wrong"
            " FROM sessions s WHERE s.language = ? AND s.report IS NOT NULL"
            " ORDER BY s.ended_at DESC, s.id DESC LIMIT ? OFFSET ?", (language, limit, offset)).fetchall()
    return [dict(r) for r in rows]
```

`app/api.py` -- `/sessions/history`와 `/sessions/{id}/report`는 **`@router.get("/sessions/{session_id}")`보다 앞에** 둔다(`resumable` 옆):

```python
_LEVEL_NEED_SESSIONS = 3
_LEVEL_NEED_UTTERANCES = 15
_ACCURACY_DAYS = 30
_HISTORY_PAGE = 20


@router.get("/stats/mypage")
def mypage_stats(language: Language):
    today = _today()
    sample = db.level_sample(language)
    enough = sample["sessions"] >= _LEVEL_NEED_SESSIONS and sample["utterances"] >= _LEVEL_NEED_UTTERANCES
    return {
        "level": {"value": db.stable_level(language) if enough else None, **sample,
                  "need_sessions": _LEVEL_NEED_SESSIONS, "need_utterances": _LEVEL_NEED_UTTERANCES},
        "accuracy": db.accuracy_since(language, today - timedelta(days=_ACCURACY_DAYS - 1)),
        "tags": db.wrong_tag_counts(language),
        "review": db.review_counts(language, today),
    }


@router.get("/review")
def review_items(language: Language):
    items = db.due_reviews(language, _today())
    return {"items": [{k: i[k] for k in ("id", "text", "fixed", "correction", "tag", "created_at")} for i in items]}


class ReviewResult(BaseModel):
    result: Literal["pass", "fail", "skip"]


@router.post("/review/{review_id}/result")
def review_result(review_id: int, payload: ReviewResult):
    try:
        return db.record_review(review_id, payload.result, _today())
    except KeyError:
        raise HTTPException(404, "no such review")
    except ValueError:
        raise HTTPException(409, "already mastered")


@router.post("/review/{review_id}/audio")
def review_audio(review_id: int):
    review = db.get_review(review_id)
    if review is None:
        raise HTTPException(404, "no such review")
    message = db.get_message(review["message_id"])
    return {"audio_key": _speak(message["fixed"], review["language"]) if message and message["fixed"] else None}


@router.get("/sessions/history")
def session_history_page(language: Language, offset: int = Query(default=0, ge=0)):
    rows = db.history(language, offset, _HISTORY_PAGE + 1)
    items = []
    for row in rows[:_HISTORY_PAGE]:
        titled = _recent_row({**row, "fixed": row["wrong"]})
        items.append({"id": row["id"], "ended_at": row["ended_at"], "title": titled["title"],
                      "mode": row["mode"], "turns": row["turns"], "wrong": row["wrong"]})
    return {"items": items, "more": len(rows) > _HISTORY_PAGE}


@router.get("/sessions/{session_id}/report")
def session_report(session_id: int):
    session = db.get_session(session_id)
    if session is None or not session["report"]:
        raise HTTPException(404, "no report for this session")
    try:
        report = json.loads(session["report"])
        if not isinstance(report, dict):
            raise ValueError
    except ValueError:
        report = {"summary": session["report"]}
    stats = db.session_stats(session_id)
    stats["minutes"] = db.active_minutes(session_id)
    return {"summary": report.get("summary") or "", "weak_points": report.get("weak_points") or [],
            "expressions": report.get("expressions") or [], "next_focus": report.get("next_focus") or "",
            "level": session["level"], "stats": stats, "mode": session["mode"]}
```

- `db.get_message(message_id)`가 없으면 추가(`SELECT * FROM messages WHERE id = ?`).
- `record_review`의 `ValueError`는 잘못된 result일 때도 나지만, 라우트는 `Literal`로 422가 먼저 걸리므로 409만 남는다.
- `_recent_row`가 받는 행 모양(`id, scenario_id, topic, ended_at, fixed`)을 확인하고 맞춘다.
- `/api/stats/home`에 `review` 추가:

```python
    counts = db.review_counts(language, today)
    first = db.due_reviews(language, today, limit=1)
    stats["review"] = {"due": counts["due"],
                       "first": {"id": first[0]["id"], "fixed": first[0]["fixed"]} if first else None}
```

- [ ] **Step 4: GREEN** — 전체.

- [ ] **Step 5: 부수기** — (1) `enough`에서 `utterances` 조건 삭제: 레벨 보류 테스트 FAIL. (2) `accuracy_since`의 `s.mode <> 'script'` 삭제: 정확도 FAIL. (3) 두 라우트를 `/sessions/{session_id}` 뒤로 옮기기: history 라우트 테스트 FAIL. (4) `session_report`의 산문 분기 삭제: 산문 리포트 FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: the API behind my page -- level, review, weak spots, history and old reports`

---

### Task 3: 마이페이지 화면

**Files:**
- Create: `static/js/mypage.js`, `static/js/mypage.test.js`
- Modify: `static/index.html`, `static/js/main.js`, `static/js/session.js` (`startRespeak` 콜백, 리포트 뒤로 버튼), `static/js/session.test.js`, `static/css/components.css`

**Interfaces:**
- Consumes: Task 2 라우트. `session.startRespeak`, `session.renderReport`, `reading.annotate`/`attachMeaning`(대화 보기의 봇 줄에 읽기 보조는 넣지 않는다 -- 단순 텍스트), `audio.play`, `api.state`/`notify`/`getJSON`/`postJSON`, `router`.
- Produces (`mypage.js`): `openMypage()`, `renderLevel(level)`, `renderReviewList(items, counts)`, `speakReview(item, card)`, `playReview(item, button)`, `skipReview(item, card)`, `renderTags(tags, accuracy)`, `loadHistory({append})`, `openReport(sessionId)`, `openTranscript(sessionId, slot)`.
- `session.startRespeak(target, resultEl, btn, onResult)` -- `onResult(true|false, spoken)` 판정 뒤, `onResult(null, null)` 못 알아들음. 인자 없으면 지금과 같다.

**마크업** (`index.html`):
- 헤더 `#btn-settings` 앞에 `<button id="btn-mypage" class="ghost" type="button">마이페이지</button>`.
- `#pick` 뒤에 `<section id="mypage" hidden>`:
  - `.mypage-head`: `#btn-mypage-home`(`← 홈`), `<h2>마이페이지</h2>`, `#mypage-language-seg`(홈·테마 화면의 seg와 같은 버튼 두 개).
  - `#level-card.panel`: `<p class="label">레벨</p><div id="level-body"></div>`.
  - `#review-section.panel`: `<div class="review-head"><p id="review-count" class="label"></p><span id="review-mastered" class="hint"></span></div><div id="review-list"></div>`.
  - `#weak-section.panel`: `<p class="label">자주 걸리는 것</p><p id="accuracy-line" class="hint" hidden></p><div id="tag-bars"></div>`.
  - `#history-section.panel`: `<p class="label">지난 기록</p><ul id="history-list"></ul><button id="btn-history-more" class="ghost" type="button" hidden>더 보기</button>`.
- `#report`의 `#btn-restart` 앞에 `<button id="btn-report-back" class="ghost" type="button" hidden>← 마이페이지</button>`.

**동작 규칙:**
- `openMypage()`: `router.show('mypage')`, 언어 seg 동기화, 네 섹션에 `불러오는 중...`, 요청 시점 언어를 잡고 `GET /stats/mypage`·`GET /review`·`GET /sessions/history`를 병렬로. 각 응답은 언어가 바뀌었으면 버린다. 한 섹션 실패는 그 섹션에 `불러오지 못했어요`만.
- `renderLevel(level)`: `value`가 있으면 `지금 레벨 <초급|중급|고급>` + `최근 세션들에서 가장 많이 나온 판정이에요`, 없으면 `판정하기엔 아직 일러요` + `세션 ${min(sessions, 3)}/3 · 발화 ${min(utterances, 15)}/15`.

  (스펙의 "목표를 넘으면 실제 수" 대신 목표에서 멈춘다 -- 한쪽만 채운 경우 `세션 5/3`은 어색하다. **Ruling은 컨트롤러 원장에 기록됨.**)
- `renderReviewList(items, {due, mastered})`: `#review-count` = `오늘의 복습 ${items.length}개`, `#review-mastered` = mastered>0이면 `익힌 문장 ${mastered}개`. 카드 `div.review-card[data-id]`:
  - `.said` (`내가 한 말` 라벨 + `<s>`text), `.fixed` (`고친 문장` 라벨 + 굵은 fixed), 태그 칩 `.tag`(없으면 생략), `button.explain`(`▸ 설명`) + 숨은 `.explain-body`(correction).
  - `.actions`: `button.play`(`▶ 듣기`), `button.speak`(`🎤 말해보기`), `button.skip`(`다음에`), `p.review-result`(숨김).
  - 빈 목록: `오늘 복습할 문장이 없어요`, 그리고 `mastered === 0 && due === 0`이면 `대화에서 고친 문장이 여기 모여요`를 덧붙인다.
- `playReview(item, button)`: 버튼 disabled + 글자 `음성 준비 중...` → `POST /review/{id}/audio` → `play(audio_key, item.fixed)` → 버튼 원래대로(`finally`). 요청 실패는 `play(null, item.fixed)`(브라우저 음성).
- `speakReview(item, card)`: `startRespeak(item.fixed, resultEl, speakBtn, onResult)`. `onResult`:
  - `null` → `못 알아들었어요. 다시 해보세요`(요청 없음).
  - `true` → `POST /review/{id}/result {pass}` → mastered면 `익혔어요 🎉`, 아니면 `좋아요! ${interval_d}일 뒤에 다시 볼게요` → 1500ms 뒤 카드 제거, `#review-count` 숫자 줄이기(0이면 빈 상태 문구).
  - `false` → `POST … {fail}` → `조금 달라요. 내일 다시 볼게요`(카드 유지).
  - 결과 요청 실패 → `notify('복습 결과를 저장하지 못했어요')`.
  - `startRespeak`가 쓰는 결과 줄(`듣는 중...`/`받아쓰는 중...`/비교 문구)은 그대로 두고, 판정 뒤 위 문구로 **덮어쓴다**.
- `skipReview`: `POST … {skip}` → 카드 제거, 숫자 줄이기.
- `renderTags(tags, accuracy)`: `graded > 0`이면 `#accuracy-line` = `문장 정확도 ${Math.round(correct/graded*100)}% · 최근 30일 채점된 ${graded}문장`. 막대 줄 `div.tag-bar`: `.name`(tag), `.track > .fill`(`style.width = n/max*100 + '%'`), `.n`(`${n}회`). 없으면 `아직 틀린 문장이 없어요`.
- `loadHistory({append})`: offset은 이미 그린 줄 수. 버튼 글자 `불러오는 중...`(append일 때). 줄 `li.history-row[data-id]`: `.main` = `${M월 D일} · ${title} · ${모드이름}`(ended_at 로컬 날짜), `.sub` = 대본이면 `말한 문장 ${turns} · 대본`, 아니면 `말한 문장 ${turns} · 고친 곳 ${wrong}`. 줄을 누르면 그 아래 `div.history-actions`를 열고 닫는다(`리포트 보기`, `대화 보기` 버튼 + `div.history-slot`). `more`면 `#btn-history-more` 보이기.
- `openReport(sessionId)`: slot에 `불러오는 중...` → `GET /sessions/{id}/report` → `state.mode = data.mode`(renderReport가 읽음) → `router.show('report')` → `renderReport(data)` → `#btn-report-back` 보이기. 뒤로 버튼: `router.show('mypage')`, 버튼 숨김. (세션 끝 리포트 경로에서는 `endSession`이 `#btn-report-back`을 숨긴다.)
- `openTranscript(sessionId, slot)`: `불러오는 중...` → `GET /sessions/{id}` → `ul.transcript`: 줄마다 `li.bot`/`li.user`(`봇: `/`나: ` 접두어 없이 클래스로 구분, 텍스트만), user 줄에 `fixed`가 있고 `ok === 0`이면 그 아래 `→ ${fixed}`. 다시 누르면 접힌다.
- `main.js`: `router.register('mypage', 'mypage')`; `#btn-mypage`, `#btn-mypage-home`(→ `router.show('home'); loadHome()`), `#mypage-language-seg`(기존 언어 핸들러 공유, 마이페이지에 있으면 `openMypage()` 다시), `#review-list` 위임(`.play`/`.speak`/`.skip`/`.explain`), `#history-list` 위임, `#btn-history-more`, `#btn-report-back`.
- 세션 중(`state.sessionId`가 살아 있고 세션 화면)에는 헤더 마이페이지 버튼을 숨기지 않는다 -- 대신 마이페이지에서 말해보기는 turnstate가 `idle`일 때만(`startRespeak`가 이미 거절한다). 끝나지 않은 세션은 이어서 하기로 돌아온다(기존).

**CSS** (정의된 토큰만): `.mypage-head`는 `.pick-head`와 같은 줄 모양(좁은 화면 wrap). `#mypage`는 한 칸 세로 스택(`max-width` 홈 본문과 같게). `.review-card`는 `.panel` 안 카드(테두리 `--line`), `.said s`는 `--text-dim`, `.fixed`는 `--text-lg` 굵게, `.review-result.good`/`.bad`는 기존 `.respeak-result` 색. `.tag-bar`는 grid(이름 / 막대 / 횟수), `.fill`은 `--accent`. `.history-row`는 누를 수 있는 줄(hover `--surface-sunken`), `.transcript li.user`는 오른쪽 정렬 느낌(`text-align: right`) 또는 들여쓰기.

- [ ] **Step 1: 실패하는 테스트** — `static/js/mypage.test.js`(home.test.js의 모듈 재import 패턴, `session.test.js`의 가짜 SpeechRecognition 설치 방식을 참고해 `startRespeak`를 몽키패치할 수 없으면 `mypage.js`가 `startRespeak`를 **주입 가능한 의존성**으로 받게 한다: `export function setRespeak(fn)` 테스트 전용 훅 대신 `speakReview(item, card, respeak = startRespeak)` 기본 인자):

```js
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import * as router from './router.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';

let mypage;
let instance = 0;
beforeEach(async () => {
  resetDom();
  ['home', 'pick', 'session', 'report', 'mypage'].forEach((s) => router.register(s, s));
  state.language = 'en';
  mypage = await import(`./mypage.js?instance=${++instance}`);
});

const STATS = (over = {}) => ({
  level: { value: null, sessions: 2, utterances: 9, need_sessions: 3, need_utterances: 15 },
  accuracy: { correct: 18, graded: 25 }, tags: [{ tag: '시제', n: 6 }, { tag: '관사', n: 3 }],
  review: { due: 2, mastered: 1 }, ...over,
});
const ITEMS = [
  { id: 11, text: 'I go there', fixed: 'I went there.', correction: '과거형', tag: '시제', created_at: 'x' },
  { id: 12, text: 'She have', fixed: 'She has.', correction: '수 일치', tag: '단복수', created_at: 'y' },
];
const HISTORY = (n, more = false) => ({ items: Array.from({ length: n }, (_, i) => ({
  id: 100 + i, ended_at: '2026-09-13T05:00:00+00:00', title: `상황 ${i}`, mode: i === 0 ? 'script' : 'free', turns: 8, wrong: 2 })), more });

function routes(extra = {}) {
  const seen = { results: [], audio: [], history: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/stats/mypage')) return extra.stats ? extra.stats(url) : jsonResponse(STATS());
    if (url.startsWith('/api/review?')) return jsonResponse({ items: extra.items ?? ITEMS });
    if (/\/api\/review\/\d+\/result/.test(url)) {
      const body = JSON.parse(options.body);
      seen.results.push([Number(url.split('/')[3]), body.result]);
      return extra.result ? extra.result(body) : jsonResponse({ id: 11, passes: 1, interval_d: 3, due_date: '2026-09-17', mastered: false });
    }
    if (/\/api\/review\/\d+\/audio/.test(url)) { seen.audio.push(url); return jsonResponse({ audio_key: 'k1' }); }
    if (url.startsWith('/api/sessions/history')) { seen.history.push(url); return jsonResponse(extra.history ? extra.history(url) : HISTORY(3)); }
    if (/\/api\/sessions\/\d+\/report/.test(url)) return jsonResponse({ summary: '좋았어요', weak_points: [], expressions: [], next_focus: '', level: 'beginner', mode: 'free', stats: { turns: 3, wrong: 1, minutes: 4, sentences: [] } });
    if (/\/api\/sessions\/\d+$/.test(url)) return jsonResponse({ session: {}, messages: [
      { speaker: 'bot', text: 'Hi.' }, { speaker: 'user', text: 'I go', ok: 0, fixed: 'I went.' }] });
    if (url.startsWith('/api/stats/home')) return jsonResponse({ top_tags: [] });
    return jsonResponse({});
  });
  return seen;
}

test('opening my page shows loading then all four sections', async () => {
  routes();
  const opening = mypage.openMypage();
  assert.equal(router.current(), 'mypage');
  assert.match($('level-body').textContent, /불러오는 중\.\.\./);
  await opening;
  assert.match($('level-body').textContent, /판정하기엔 아직 일러요/);
  assert.match($('level-body').textContent, /세션 2\/3 · 발화 9\/15/);
  assert.equal($('review-count').textContent, '오늘의 복습 2개');
  assert.equal($('review-mastered').textContent, '익힌 문장 1개');
  assert.equal($('accuracy-line').textContent, '문장 정확도 72% · 최근 30일 채점된 25문장');
  assert.equal($('history-list').children.length, 3);
});

test('a level is shown once the sample is big enough', async () => {
  routes({ stats: () => jsonResponse(STATS({ level: { value: 'intermediate', sessions: 5, utterances: 40, need_sessions: 3, need_utterances: 15 } })) });
  await mypage.openMypage();
  assert.match($('level-body').textContent, /지금 레벨 중급/);
});

test('listening prepares audio with visible copy, then plays', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  const btn = card.querySelector ? null : null; // shim: find by class via children walk in helper
  const play = findByClass(card, 'play');
  const playing = mypage.playReview(ITEMS[0], play);
  assert.equal(play.textContent, '음성 준비 중...');
  await playing;
  assert.equal(play.textContent, '▶ 듣기');
  assert.equal(seen.audio.length, 1);
});

test('a passed review saves, says when it comes back, and leaves the list', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (target, resultEl, btn, onResult) => onResult(true, 'I went there'));
  assert.deepEqual(seen.results, [[11, 'pass']]);
  assert.match(findByClass(card, 'review-result').textContent, /좋아요! 3일 뒤에 다시 볼게요/);
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal($('review-list').children.length, 1);
  assert.equal($('review-count').textContent, '오늘의 복습 1개');
});

test('the third pass says it is mastered', async () => {
  routes({ result: () => jsonResponse({ id: 11, passes: 3, interval_d: 14, due_date: 'z', mastered: true }) });
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(true, 'x'));
  assert.match(findByClass(card, 'review-result').textContent, /익혔어요 🎉/);
});

test('a failed review saves fail and keeps the card; hearing nothing saves nothing', async () => {
  const seen = routes();
  await mypage.openMypage();
  const card = $('review-list').children[0];
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(false, 'I go'));
  assert.deepEqual(seen.results, [[11, 'fail']]);
  assert.match(findByClass(card, 'review-result').textContent, /조금 달라요\. 내일 다시 볼게요/);
  await mypage.speakReview(ITEMS[0], card, (t, r, b, onResult) => onResult(null, null));
  assert.equal(seen.results.length, 1);
  assert.match(findByClass(card, 'review-result').textContent, /못 알아들었어요/);
  assert.equal($('review-list').children.length, 2);
});

test('다음에 skips, and an empty list explains itself', async () => {
  const seen = routes({ items: [ITEMS[0]] });
  await mypage.openMypage();
  await mypage.skipReview(ITEMS[0], $('review-list').children[0]);
  assert.deepEqual(seen.results, [[11, 'skip']]);
  assert.match($('review-list').textContent + collectText($('review-list')), /오늘 복습할 문장이 없어요/);
});

test('tag bars scale to the largest count; no tags says so', async () => {
  routes();
  await mypage.openMypage();
  const bars = $('tag-bars').children;
  assert.equal(findByClass(bars[0], 'fill').style.width, '100%');
  assert.equal(findByClass(bars[1], 'fill').style.width, '50%');
  assert.equal(findByClass(bars[1], 'n').textContent, '3회');
  routes({ stats: () => jsonResponse(STATS({ tags: [], accuracy: { correct: 0, graded: 0 } })) });
  await mypage.openMypage();
  assert.match(collectText($('tag-bars')), /아직 틀린 문장이 없어요/);
  assert.equal($('accuracy-line').hidden, true);
});

test('history rows, 더 보기 appends, and the button hides when there is no more', async () => {
  const seen = routes({ history: (url) => (url.includes('offset=20') ? HISTORY(2) : HISTORY(20, true)) });
  await mypage.openMypage();
  assert.equal($('btn-history-more').hidden, false);
  assert.match(collectText($('history-list').children[0]), /말한 문장 8 · 대본/);
  assert.match(collectText($('history-list').children[1]), /말한 문장 8 · 고친 곳 2/);
  await mypage.loadHistory({ append: true });
  assert.ok(seen.history[1].includes('offset=20'));
  assert.equal($('history-list').children.length, 22);
  assert.equal($('btn-history-more').hidden, true);
});

test('opening a report shows the report screen with a way back', async () => {
  routes();
  await mypage.openMypage();
  await mypage.openReport(100);
  assert.equal(router.current(), 'report');
  assert.equal($('btn-report-back').hidden, false);
  assert.equal(state.mode, 'free');
});

test('a transcript lists both sides and the fix under my line', async () => {
  routes();
  await mypage.openMypage();
  const slot = document.createElement('div');
  await mypage.openTranscript(100, slot);
  assert.match(collectText(slot), /Hi\./);
  assert.match(collectText(slot), /→ I went\./);
});

test('a stale response for another language is dropped', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  routes({ stats: async (url) => { if (url.includes('language=en')) { await held; } return jsonResponse(STATS({ level: { value: url.includes('ja') ? 'advanced' : 'beginner', sessions: 9, utterances: 99, need_sessions: 3, need_utterances: 15 } })); } });
  const first = mypage.openMypage();
  state.language = 'ja';
  await mypage.openMypage();
  release();
  await first;
  assert.match($('level-body').textContent, /고급/);
});

function findByClass(el, cls) {
  if (el.classList && el.classList.contains(cls)) return el;
  for (const c of el.children || []) { const hit = findByClass(c, cls); if (hit) return hit; }
  return null;
}
function collectText(el) {
  return (el.textContent || '') + (el.children || []).map(collectText).join(' ');
}
```

(`listening prepares audio` 테스트의 쓸모없는 `btn` 줄은 지운다. dom-shim에서 `textContent`가 자식을 모으지 않으므로 `collectText`를 쓴다. 헬퍼가 home.test.js에 이미 비슷한 게 있으면 그 이름을 따른다.)

`static/js/session.test.js`에 추가(가짜 SpeechRecognition이 이미 이 파일에 설치돼 있다):

```js
test('startRespeak reports the verdict to an onResult callback', async () => {
  resetDom();
  state.language = 'en';
  const results = [];
  stubFetch(async (url) => (url === '/api/transcribe' ? jsonResponse({ text: 'I went there.' }) : jsonResponse({})));
  const btn = document.createElement('button');
  const resultEl = document.createElement('p');
  session.startRespeak('I went there.', resultEl, btn, (good, spoken) => results.push([good, spoken]));
  rec.onstart();
  rec.onresult(respeakFinal('I went there'));
  rec.onend();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(results, [[true, 'I went there.']]);
});
```

(이 파일의 기존 respeak 테스트가 `startRecording`/녹음 Promise를 어떻게 흉내 내는지 보고, Whisper 경로가 녹음 없이 브라우저 문장으로 가면 `spoken`이 `'I went there'`가 된다 -- 실제 값에 맞춘다. 실패·못 알아들음 케이스도 하나씩.)

- [ ] **Step 2: RED 확인.**
- [ ] **Step 3: 구현** — 위 규칙대로.
- [ ] **Step 4: GREEN** — node 전체, pytest `tests/test_css_tokens.py tests/test_pick_css.py tests/test_brand.py`, `main.test.js`의 id 검사.
- [ ] **Step 5: 부수기** — (1) `speakReview`의 `null` 분기에서 요청 보내게: 못 알아들음 FAIL. (2) 통과 뒤 카드 제거 삭제: pass 테스트 FAIL. (3) `loadHistory` offset을 0 고정: 더 보기 FAIL. (4) 늦은 응답 언어 비교 삭제: stale FAIL. (5) `startRespeak`의 `onResult` 호출 삭제: session.test FAIL. 되돌리고 GREEN.
- [ ] **Step 6: 커밋** — 기능 단위로 나눠서(`feat: my page shows level, weak spots and history`, `feat: review corrected sentences by saying them again`, `style: my page`).

---

### Task 4: 홈 오늘 복습 카드와 들어가는 길

**Files:**
- Modify: `static/index.html`, `static/js/home.js`, `static/js/main.js`, `static/js/home.test.js`, `static/css/components.css`

**Interfaces:**
- Consumes: `/api/stats/home`의 `review: {due, first: {id, fixed} | null}`, `POST /api/review/{id}/audio`, `mypage.openMypage`, `audio.play`.
- Produces: `home.renderReviewHome(review)`, `home.playReviewHome()`.

**마크업:** `#today-alt` 뒤, `#recommend` 앞에

```html
<div id="review-home" class="panel review-home" hidden>
  <p id="review-home-count" class="label"></p>
  <p id="review-home-first" class="review-home-first"></p>
  <div class="review-home-actions">
    <button id="review-home-play" class="ghost" type="button">▶ 듣기</button>
    <button id="review-home-go" class="ghost" type="button">복습하러 가기 →</button>
  </div>
</div>
```

이번 주 카드(`#week-card`) 안 맨 아래에 `<button id="week-more" class="ghost link" type="button">기록 더 보기 →</button>`.

**동작:** `loadHome`이 `renderReviewHome(stats.review)`: `due > 0 && first`면 보이고 `#review-home-count` = `오늘 복습할 문장 ${due}개`, `#review-home-first` = first.fixed; 아니면 숨김(요청 전·실패 시에도 숨김). `playReviewHome()`: `#review-home-play` 글자 `음성 준비 중...` + disabled → `POST /review/{first.id}/audio` → `play(key, fixed)` → 원래대로. `#review-home-go`, `#week-more`, 헤더 `#btn-mypage` → `openMypage()`(main.js; home.js는 mypage.js를 import하지 않는다 -- 순환 방지). 좁은 화면 순서: 추천 → 또는 → **오늘 복습** → 이어서 하기 → 이번 주 → …(`order` 값 조정).

- [ ] **Step 1: 실패하는 테스트** (`home.test.js`, 기존 `PAYLOAD`/`homeRoutes` 헬퍼):

```js
test('the review card shows today\'s count and first sentence, and hides at zero', async () => {
  homeRoutes(PAYLOAD({ review: { due: 3, first: { id: 11, fixed: 'I went there.' } } }));
  await home.loadHome();
  assert.equal($('review-home').hidden, false);
  assert.equal($('review-home-count').textContent, '오늘 복습할 문장 3개');
  assert.equal($('review-home-first').textContent, 'I went there.');
  homeRoutes(PAYLOAD({ review: { due: 0, first: null } }));
  await home.loadHome();
  assert.equal($('review-home').hidden, true);
});

test('listening on the home review card shows the preparing copy', async () => {
  const played = [];
  homeRoutes(PAYLOAD({ review: { due: 1, first: { id: 11, fixed: 'I went there.' } } }), {});
  stubFetch(async (url) => {
    if (url === '/api/review/11/audio') { played.push(url); return jsonResponse({ audio_key: 'k' }); }
    if (url.startsWith('/api/stats/home')) return jsonResponse(PAYLOAD({ review: { due: 1, first: { id: 11, fixed: 'I went there.' } } }));
    return jsonResponse({ session: null });
  });
  await home.loadHome();
  const p = home.playReviewHome();
  assert.equal($('review-home-play').textContent, '음성 준비 중...');
  await p;
  assert.equal($('review-home-play').textContent, '▶ 듣기');
  assert.deepEqual(played, ['/api/review/11/audio']);
});
```

(`PAYLOAD`에 `review`가 없던 기존 테스트는 카드가 숨어 있어야 한다 -- 기본값 없이도 통과하는지 확인.)

- [ ] **Step 2: RED.** **Step 3: 구현.** **Step 4: GREEN** (node 전체, CSS pytest). **Step 5: 부수기** — `due > 0` 조건 삭제: 0 테스트 FAIL; 준비 문구 삭제: 듣기 테스트 FAIL. 되돌리고 GREEN.
- [ ] **Step 6: 커밋** — `feat: today's review on the home screen, and ways into my page`

---

## 운영 (컨트롤러)

1. 8010(DB 스냅샷)으로 브라우저 확인: 헤더 → 마이페이지, 레벨·복습·막대·기록, 듣기, 리포트 보기·뒤로, 대화 보기, 홈 복습 카드, 400px.
2. 말해보기는 마이크가 필요하다 -- 자동화로 확인하지 못하는 부분은 사용자에게 실제로 한 번 해 달라고 부탁한다.
3. main 머지 전 본 DB 백업(스키마 v6 + 백필). 머지 → 8000 재시작(생성 작업은 계속).
