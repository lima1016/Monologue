# 홈 대시보드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈에 오늘의 추천 테마, 이번 주(7칸 달력·연속 학습일·목표 진행률), 최근 테마 바로 시작, 대본 준비 상태 줄, 빈 상태를 더한다.

**Architecture:** 서버는 `GET /api/stats/home`에 필드를 더하고(`week`, `recommend`, `recent_themes`, `library`, `has_history`), 목표 설정 라우트를 하나 더한다. 추천 규칙은 `app/library.py`, 날짜·세션 집계는 `app/db.py`. 화면은 `home.js`가 그리고, 시작은 `pick.js`의 새 `startTheme(mode, themeId)`가 테마 화면의 기존 시작 경로(단계 문구 포함)를 그대로 쓴다.

**Tech Stack:** FastAPI, SQLite, pytest, 브라우저 ES 모듈 + `node --test`(dom-shim).

**Spec:** `docs/superpowers/specs/2026-09-14-monologue-home-dashboard-design.md`

## Global Constraints

- 작업 위치: 워크트리 `C:/git/Monologue-wt/home-dashboard`, 브랜치 `home-dashboard`. `C:/git/Monologue`는 건드리지 않는다(사용자 서버 + **대본 일괄 생성이 그 DB에 몇 시간째 쓰는 중**).
- 파이썬 `C:/git/Monologue/venv/Scripts/python.exe`, 워크트리 루트, `-m "not engine"`. **engine 테스트는 돌리지 않는다**(GPU를 생성 작업이 쓰는 중).
- 기준선(main `a75f96c`): pytest 541(워크트리에선 540 + 알려진 `test_kokoro_model_files_are_present` 실패 1), node 145.
- 날짜는 **로컬 시간**(기존 `db.home_stats` docstring과 같은 이유). 주는 **월요일 시작**.
- 목표: 기본 **5**, 범위 **1~14**, 설정 키 `weekly_goal`.
- 추천 0~2개, 최근 테마 최대 **4**, 준비 상태 목표 = `len(themes) * config.LIBRARY_PER_THEME`.
- 문구(그대로): `오늘의 추천`, `스크립트로 시작`, `자유 대화로 시작`, `대본 준비 중`, `또는: `, `아직 안 해본 테마예요`, `오늘도 한 번 더 해볼까요?`, `어제 연습했어요`, `<N>일 전에 마지막으로 했어요`, `새 대본을 준비하고 있어요. 그동안 직접 만들기나 수업으로 연습해 보세요.`, `이번 주`, `연속 <N>일`, `이번 주 <n>/<goal> 세션`, `목표 달성!`, `목표를 저장하지 못했어요`, `최근 테마`, `새 대본 준비 중 · <n>/<target>편`, `첫 연습을 시작해 보세요`, `오늘의 추천 불러오는 중...`, 요일 `월화수목금토일`, 모드 이름 `스크립트`·`자유 상황극`.
- 새 가드마다 일부러 부숴 빨개지는지 확인하고 되돌린다.
- 커밋 메시지 끝:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9
  ```

---

### Task 1: 집계와 추천 규칙

**Files:**
- Modify: `app/db.py` (파일 끝), `app/library.py` (파일 끝)
- Test: `tests/test_db.py`, `tests/test_library.py`

**Interfaces:**
- Produces:
  - `db.practice_days(language, start: date, end: date) -> set[str]` -- 로컬 `YYYY-MM-DD`, 양끝 포함, 학습자 메시지 기준.
  - `db.sessions_completed_since(language, start: date) -> int` -- 그 로컬 날짜 0시 이후 `ended_at`이고 `report IS NOT NULL`.
  - `db.library_sessions(language, limit=50) -> list[dict]` -- `{scenario_id, mode, started_at}`, `scenario_id LIKE 'lib-%'`, `started_at DESC, id DESC`.
  - `db.library_script_count(language) -> int`
  - `db.has_sessions(language) -> bool`
  - `library.theme_of(scenario_id) -> str | None`
  - `library.reason_for(last_day: date | None, today: date) -> str`
  - `library.recommend(language, today: date) -> list[dict]` -- 각 `{theme_id, title, category, situations, reason, ready: {free: bool, script: int}}`.

- [ ] **Step 1: 실패하는 테스트**

`tests/test_db.py` 끝 (`store` 픽스처와 `_now` 몽키패치 방식은 이 파일의 기존 테스트를 따른다):

```python
from datetime import date, datetime, timedelta, timezone


def _utc_iso(local_dt):
    """A naive local datetime written the way _now() writes (UTC ISO)."""
    return local_dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def test_practice_days_are_local_dates_of_learner_messages(store, monkeypatch):
    sid = store.create_session("en", "free")
    other = store.create_session("ja", "free")
    stamps = iter([_utc_iso(datetime(2026, 9, 14, 0, 30)), _utc_iso(datetime(2026, 9, 13, 23, 50)),
                   _utc_iso(datetime(2026, 9, 10, 12, 0)), _utc_iso(datetime(2026, 9, 12, 12, 0))])
    monkeypatch.setattr(store, "_now", lambda: next(stamps))
    store.add_message(sid, "user", "a")
    store.add_message(sid, "user", "b")
    store.add_message(sid, "bot", "c")              # bot lines do not count
    store.add_message(other, "user", "d")           # other language
    assert store.practice_days("en", date(2026, 9, 11), date(2026, 9, 14)) == {"2026-09-14", "2026-09-13"}


def test_sessions_completed_since_counts_reported_sessions_from_that_local_midnight(store, monkeypatch):
    ids = [store.create_session("en", "free") for _ in range(3)] + [store.create_session("ja", "free")]
    stamps = iter([_utc_iso(datetime(2026, 9, 14, 0, 5)), _utc_iso(datetime(2026, 9, 13, 23, 55)),
                   _utc_iso(datetime(2026, 9, 15, 9, 0)), _utc_iso(datetime(2026, 9, 15, 9, 0))])
    monkeypatch.setattr(store, "_now", lambda: next(stamps))
    for sid in ids:
        store.end_session(sid, "{}", "beginner")
    abandoned = store.create_session("en", "free")   # no report
    with store.connect() as conn:
        conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (_utc_iso(datetime(2026, 9, 15, 10, 0)), abandoned))
    assert store.sessions_completed_since("en", date(2026, 9, 14)) == 2


def test_library_sessions_recent_first_and_only_library_ids(store, monkeypatch):
    stamps = iter(["2026-09-10T00:00:00+00:00", "2026-09-12T00:00:00+00:00", "2026-09-11T00:00:00+00:00"])
    monkeypatch.setattr(store, "_now", lambda: next(stamps))
    store.create_session("en", "script", scenario_id="lib-hotel-en-01")
    store.create_session("en", "free", scenario_id="lib-cafe-restaurant-en-free")
    store.create_session("en", "free", scenario_id="restaurant-seating-en")
    rows = store.library_sessions("en")
    assert [r["scenario_id"] for r in rows] == ["lib-cafe-restaurant-en-free", "lib-hotel-en-01"]
    assert rows[0]["mode"] == "free"


def test_library_script_count_and_has_sessions(store):
    assert store.library_script_count("en") == 0 and store.has_sessions("en") is False
    store.add_library_scenario({"id": "lib-hotel-en-01", "theme_id": "hotel", "situation": "s", "language": "en",
                                "type": "script", "title": "t",
                                "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})
    store.add_library_scenario({"id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None, "language": "en",
                                "type": "free", "title": "t", "goal": "g", "persona_prompt": "p", "max_turns": 16})
    store.create_session("ja", "lesson")
    assert store.library_script_count("en") == 1
    assert store.has_sessions("en") is False and store.has_sessions("ja") is True
```

(`store.create_session`이 `started_at`에 `_now()`를 쓰는지, `end_session`이 `ended_at`에 `_now()`를 쓰는지 `app/db.py`에서 확인하고, 스탬프 순서를 실제 호출 순서에 맞춘다. 맞추느라 바꾼 것은 보고서에 적는다.)

`tests/test_library.py` 끝 (`store` 픽스처는 이 파일에 이미 있다):

```python
from datetime import date


def test_theme_of():
    assert library.theme_of("lib-cafe-restaurant-ja-07") == "cafe-restaurant"
    assert library.theme_of("lib-hotel-en-free") == "hotel"
    assert library.theme_of("restaurant-seating-en") is None
    assert library.theme_of("user-abc123") is None
    assert library.theme_of(None) is None


def test_reason_for():
    today = date(2026, 9, 14)
    assert library.reason_for(None, today) == "아직 안 해본 테마예요"
    assert library.reason_for(date(2026, 9, 14), today) == "오늘도 한 번 더 해볼까요?"
    assert library.reason_for(date(2026, 9, 13), today) == "어제 연습했어요"
    assert library.reason_for(date(2026, 9, 9), today) == "5일 전에 마지막으로 했어요"


def _ready(store, theme, language="en", scripts=1, free=False):
    for n in range(1, scripts + 1):
        store.add_library_scenario({"id": f"lib-{theme}-{language}-{n:02d}", "theme_id": theme, "situation": "s",
                                    "language": language, "type": "script", "title": "t",
                                    "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})
    if free:
        store.add_library_scenario({"id": f"lib-{theme}-{language}-free", "theme_id": theme, "situation": None,
                                    "language": language, "type": "free", "title": "t", "goal": "g",
                                    "persona_prompt": "p", "max_turns": 16})


def _played(store, monkeypatch, scenario_id, stamp, mode="script"):
    monkeypatch.setattr(db, "_now", lambda: stamp)
    store.create_session(scenario_id.split("-")[-2], mode, scenario_id=scenario_id)


def test_recommend_empty_library_is_empty(store):
    assert library.recommend("en", date(2026, 9, 14)) == []


def test_recommend_only_ready_themes_and_carries_theme_fields(store):
    _ready(store, "hotel", scripts=2, free=True)
    recs = library.recommend("en", date(2026, 9, 14))
    assert len(recs) == 1
    r = recs[0]
    assert (r["theme_id"], r["title"], r["category"]) == ("hotel", "호텔", "travel")
    assert r["situations"][0] == "체크인"
    assert r["ready"] == {"free": True, "script": 2}
    assert r["reason"] == "아직 안 해본 테마예요"


def test_recommend_prefers_themes_never_played(store, monkeypatch):
    for theme in ("hotel", "cafe-restaurant", "meetings"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-hotel-en-01", "2026-09-01T03:00:00+00:00")
    _played(store, monkeypatch, "lib-meetings-en-01", "2026-09-02T03:00:00+00:00")
    assert library.recommend("en", date(2026, 9, 14))[0]["theme_id"] == "cafe-restaurant"


def test_when_everything_was_played_recommend_the_older_half(store, monkeypatch):
    for theme in ("hotel", "shopping", "meetings", "interview"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-hotel-en-01", "2026-09-01T03:00:00+00:00")
    _played(store, monkeypatch, "lib-shopping-en-01", "2026-09-02T03:00:00+00:00")
    _played(store, monkeypatch, "lib-meetings-en-01", "2026-09-12T03:00:00+00:00")
    _played(store, monkeypatch, "lib-interview-en-01", "2026-09-13T03:00:00+00:00")
    first = library.recommend("en", date(2026, 9, 14))[0]
    assert first["theme_id"] in {"hotel", "shopping"}
    assert first["reason"].endswith("일 전에 마지막으로 했어요")


def test_recommend_avoids_the_category_just_practised_when_it_can(store, monkeypatch):
    for theme in ("meetings", "interview", "hotel"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-standup-en-01", "2026-09-13T03:00:00+00:00")   # business, not ready but played
    for seed_day in range(1, 20):
        first = library.recommend("en", date(2026, 9, seed_day))[0]
        assert first["category"] == "travel", seed_day


def test_recommend_is_stable_within_a_day(store):
    for theme in ("hotel", "shopping", "meetings", "interview", "hobbies", "first-meeting"):
        _ready(store, theme)
    day = date(2026, 9, 14)
    assert library.recommend("en", day) == library.recommend("en", day)
    days = {library.recommend("en", date(2026, 9, d))[0]["theme_id"] for d in range(1, 29)}
    assert len(days) > 1, "the pick should vary across days"


def test_the_alternative_comes_from_another_category_when_possible(store):
    for theme in ("hotel", "airport-flight", "meetings"):
        _ready(store, theme)
    for d in range(1, 15):
        recs = library.recommend("en", date(2026, 9, d))
        assert len(recs) == 2
        assert recs[0]["theme_id"] != recs[1]["theme_id"]
        if recs[0]["category"] == "travel":
            assert recs[1]["category"] == "business"
```

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현**

`app/db.py` 파일 끝:

```python
def practice_days(language, start, end) -> set:
    """Local dates (YYYY-MM-DD) in [start, end] on which the learner spoke.
    Local time for the same reason home_stats uses it (see its docstring)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT substr(datetime(m.created_at, 'localtime'), 1, 10) d"
            " FROM messages m JOIN sessions s ON s.id = m.session_id"
            " WHERE s.language = ? AND m.speaker = 'user'"
            "   AND substr(datetime(m.created_at, 'localtime'), 1, 10) BETWEEN ? AND ?",
            (language, start.isoformat(), end.isoformat())).fetchall()
    return {r[0] for r in rows}


def sessions_completed_since(language, start) -> int:
    """Sessions finished with a report on or after local midnight of `start`."""
    with connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE language = ? AND report IS NOT NULL"
            " AND ended_at IS NOT NULL AND datetime(ended_at, 'localtime') >= ?",
            (language, f"{start.isoformat()} 00:00:00")).fetchone()[0]


def library_sessions(language, limit=50) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT scenario_id, mode, started_at FROM sessions"
            " WHERE language = ? AND scenario_id LIKE 'lib-%'"
            " ORDER BY started_at DESC, id DESC LIMIT ?", (language, limit)).fetchall()
    return [dict(r) for r in rows]


def library_script_count(language) -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM library_scenarios WHERE language = ? AND type = 'script'",
                            (language,)).fetchone()[0]


def has_sessions(language) -> bool:
    with connect() as conn:
        return conn.execute("SELECT 1 FROM sessions WHERE language = ? LIMIT 1", (language,)).fetchone() is not None
```

`app/library.py` 파일 끝 (`from datetime import date, datetime`를 import에 더한다):

```python
def theme_of(scenario_id):
    """`lib-<theme>-<language>-<nn|free>` -> theme. Theme ids contain dashes, so
    cut the last two pieces off rather than splitting from the left."""
    if not isinstance(scenario_id, str) or not scenario_id.startswith("lib-"):
        return None
    parts = scenario_id[4:].rsplit("-", 2)
    return parts[0] if len(parts) == 3 else None


def reason_for(last_day, today) -> str:
    if last_day is None:
        return "아직 안 해본 테마예요"
    days = (today - last_day).days
    if days <= 0:
        return "오늘도 한 번 더 해볼까요?"
    if days == 1:
        return "어제 연습했어요"
    return f"{days}일 전에 마지막으로 했어요"


def _local_day(iso):
    return datetime.fromisoformat(iso).astimezone().date()


def recommend(language, today) -> list:
    """오늘의 추천: 준비된 테마 중 안 해본 것, 없으면 오래된 앞쪽 절반. 방금 한
    분류는 다른 후보가 있으면 피한다. 같은 날에는 같은 결과 -- 새로고침마다
    바뀌면 '아까 그거'를 다시 찾을 수 없다."""
    ready = []
    for theme in load_themes():
        scripts = len(db.library_scenarios(language, theme["id"], "script"))
        free = free_setup(language, theme["id"]) is not None
        if scripts or free:
            ready.append((theme, {"free": free, "script": scripts}))
    if not ready:
        return []
    last = {}
    recent_category = None
    for row in db.library_sessions(language, limit=500):
        theme_id = theme_of(row["scenario_id"])
        if theme_id is None:
            continue
        if recent_category is None:
            t = get_theme(theme_id)
            recent_category = t["category"] if t else None
        last.setdefault(theme_id, _local_day(row["started_at"]))
    rng = random.Random(f"{today.isoformat()}:{language}")

    def pool(items):
        fresh = [x for x in items if x[0]["id"] not in last]
        if fresh:
            return fresh
        ordered = sorted(items, key=lambda x: (last[x[0]["id"]], x[0]["id"]))
        return ordered[:max(1, len(ordered) // 2)]

    def pick(items, avoid):
        preferred = [x for x in items if x[0]["category"] != avoid]
        choices = pool(preferred) if preferred else pool(items)
        return rng.choice(sorted(choices, key=lambda x: x[0]["id"]))

    first = pick(ready, recent_category)
    rest = [x for x in ready if x[0]["id"] != first[0]["id"]]
    out = [first]
    if rest:
        out.append(pick(rest, first[0]["category"]))
    return [{"theme_id": t["id"], "title": t["title"], "category": t["category"],
             "situations": list(t["situations"]), "reason": reason_for(last.get(t["id"]), today),
             "ready": r} for t, r in out]
```

- [ ] **Step 4: GREEN** — 전체 `-m "not engine"`.

- [ ] **Step 5: 부수기** — (1) `pool`의 `fresh` 분기 삭제: `prefers_themes_never_played` FAIL. (2) `preferred` 무시(`choices = pool(items)`): `avoids_the_category` FAIL. (3) `rng = random.Random()`(시드 없음): `stable_within_a_day` FAIL. (4) `theme_of`를 `split("-")[1]`로: `test_theme_of` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: count this week, remember recent themes, and pick today's theme`

---

### Task 2: `/api/stats/home` 새 필드와 목표 설정

**Files:**
- Modify: `app/api.py` (`home_stats` 라우트, 새 라우트)
- Test: `tests/test_api_config.py` (기존 `test_home_stats_*` 옆)

**Interfaces:**
- Consumes: Task 1 전부, `library.load_themes`, `db.get_setting`/`set_setting`, `config.LIBRARY_PER_THEME`.
- Produces: 스펙 "API" 절의 JSON 모양 그대로. `POST /api/settings/weekly-goal {goal}` → `{goal}`.
- `api._today()` -- `datetime.now().date()` (테스트가 몽키패치).

- [ ] **Step 1: 실패하는 테스트** (`tests/test_api_config.py`, 이 파일의 `client` 픽스처를 쓴다)

```python
from datetime import date


def test_home_stats_week_is_monday_to_sunday_with_today_marked(client, monkeypatch):
    from app import api
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 16))   # Wednesday
    week = client.get("/api/stats/home?language=en").json()["week"]
    assert [d["label"] for d in week["days"]] == list("월화수목금토일")
    assert week["days"][0]["date"] == "2026-09-14"
    assert [d["today"] for d in week["days"]] == [False, False, True, False, False, False, False]
    assert [d["future"] for d in week["days"]] == [False, False, False, True, True, True, True]
    assert week["goal"] == 5 and week["sessions"] == 0


def test_weekly_goal_is_saved_and_bounded(client):
    assert client.post("/api/settings/weekly-goal", json={"goal": 7}).json() == {"goal": 7}
    assert client.get("/api/stats/home?language=ja").json()["week"]["goal"] == 7
    assert client.post("/api/settings/weekly-goal", json={"goal": 0}).status_code == 422
    assert client.post("/api/settings/weekly-goal", json={"goal": 15}).status_code == 422


def test_home_stats_recommend_recent_themes_library_and_history(client, monkeypatch):
    from app import api, db
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 14))
    body = client.get("/api/stats/home?language=en").json()
    assert body["recommend"] == [] and body["recent_themes"] == []
    assert body["library"] == {"scripts": 0, "target": 20 * 30}
    assert body["has_history"] is False
    for theme in ("hotel", "meetings", "cafe-restaurant", "shopping", "hobbies"):
        db.add_library_scenario({"id": f"lib-{theme}-en-01", "theme_id": theme, "situation": "s", "language": "en",
                                 "type": "script", "title": "t",
                                 "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})
    for sid in ("lib-hotel-en-01", "lib-meetings-en-01", "lib-hotel-en-01", "lib-cafe-restaurant-en-01",
                "lib-shopping-en-01", "lib-hobbies-en-01"):
        db.create_session("en", "script", scenario_id=sid)
    body = client.get("/api/stats/home?language=en").json()
    assert body["has_history"] is True
    assert body["library"]["scripts"] == 5
    assert 1 <= len(body["recommend"]) <= 2
    themes = [r["theme_id"] for r in body["recent_themes"]]
    assert len(themes) == 4 and len(set(themes)) == 4
    assert body["recent_themes"][0] == {"theme_id": "hobbies", "title": "취미·관심사", "mode": "script"}
```

(마지막 테스트의 세션 순서는 `create_session`이 같은 초에 여러 개 생기면 `started_at` 동률 → `id DESC`로 정렬되는 것에 기댄다. 그렇지 않으면 `_now`를 몽키패치해 초를 다르게 준다.)

- [ ] **Step 2: RED 확인.**

- [ ] **Step 3: 구현** — `app/api.py`:

```python
from datetime import date, datetime, timedelta   # (파일 맨 위 import로)

_WEEKDAY_LABELS = "월화수목금토일"
_WEEKLY_GOAL_KEY = "weekly_goal"
_WEEKLY_GOAL_DEFAULT = 5
_RECENT_THEMES = 4


def _today() -> date:
    # Local, like db.home_stats -- the learner's week starts at their Monday midnight.
    return datetime.now().date()


def _weekly_goal() -> int:
    try:
        goal = int(db.get_setting(_WEEKLY_GOAL_KEY, _WEEKLY_GOAL_DEFAULT))
    except (TypeError, ValueError):
        return _WEEKLY_GOAL_DEFAULT
    return goal if 1 <= goal <= 14 else _WEEKLY_GOAL_DEFAULT


def _week(language, today):
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    practiced = db.practice_days(language, monday, sunday)
    days = []
    for i in range(7):
        d = monday + timedelta(days=i)
        days.append({"date": d.isoformat(), "label": _WEEKDAY_LABELS[i], "practiced": d.isoformat() in practiced,
                     "today": d == today, "future": d > today})
    return {"days": days, "sessions": db.sessions_completed_since(language, monday), "goal": _weekly_goal()}


def _recent_themes(language):
    out, seen = [], set()
    for row in db.library_sessions(language):
        theme_id = library.theme_of(row["scenario_id"])
        theme = library.get_theme(theme_id) if theme_id else None
        if theme is None or theme_id in seen:
            continue
        seen.add(theme_id)
        out.append({"theme_id": theme_id, "title": theme["title"], "mode": row["mode"]})
        if len(out) == _RECENT_THEMES:
            break
    return out
```

`home_stats` 라우트:

```python
@router.get("/stats/home")
def home_stats(language: Language):
    stats = db.home_stats(language)
    stats["recent"] = [_recent_row(r) for r in db.recent_sessions(language)]
    today = _today()
    stats["has_history"] = db.has_sessions(language)
    stats["week"] = _week(language, today)
    stats["recommend"] = library.recommend(language, today)
    stats["recent_themes"] = _recent_themes(language)
    stats["library"] = {"scripts": db.library_script_count(language),
                        "target": len(library.load_themes()) * config.LIBRARY_PER_THEME}
    return stats


class WeeklyGoal(BaseModel):
    goal: int = Field(ge=1, le=14)


@router.post("/settings/weekly-goal")
def set_weekly_goal(payload: WeeklyGoal):
    db.set_setting(_WEEKLY_GOAL_KEY, str(payload.goal))
    return {"goal": payload.goal}
```

(`from pydantic import BaseModel, Field`.)

- [ ] **Step 4: GREEN** — 전체.

- [ ] **Step 5: 부수기** — (1) `monday = today`(주 시작 무시): `monday_to_sunday` FAIL. (2) `if theme is None or theme_id in seen` → `if theme is None`: `recent_themes` 중복 FAIL. (3) `Field(ge=1, le=14)` 제거: `bounded` FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: the home payload carries this week, today's pick, recent themes and library progress`

---

### Task 3: 홈 화면

**Files:**
- Modify: `static/index.html`, `static/js/home.js`, `static/js/pick.js`, `static/js/main.js`, `static/css/components.css`, `static/js/home.test.js`, `static/js/pick.test.js`

**Interfaces:**
- Consumes: Task 2의 `/api/stats/home` 모양, `POST /api/settings/weekly-goal`, `pick.js`의 `openPick`, `selectCategory`, `selectTheme`, `startFromPick`, `home.js`의 `isBusy`.
- Produces:
  - `pick.startTheme(mode, themeId): Promise<void>`
  - `home.js`: `renderToday(recommend)`, `renderWeek(week, streak)`, `renderRecentThemes(items)`, `renderLibraryProgress(library)`, `changeGoal(delta)`, `swapToday()` (export — 테스트가 직접 부른다; `swapToday`는 `또는:` 클릭이 부른다)

**마크업** (`#home` 안, 기존 요소 재배치):

```html
<section id="home">
  <div class="home-main">
    <p class="home-date" id="home-date"></p>
    <div class="home-head">
      <h2 id="home-greeting">오늘은 뭘 연습할까요?</h2>
      <span class="seg" id="language-seg">...기존 그대로...</span>
    </div>
    <div id="today-card" class="today-card">
      <p class="label">오늘의 추천</p>
      <div id="today-body"></div>
    </div>
    <p id="today-alt" class="today-alt" hidden></p>
    <p id="recommend" class="recommend" hidden></p>
    <div class="modes" id="modes">...기존 그대로...</div>
    <div id="recent-themes-wrap" hidden>
      <p class="label">최근 테마</p>
      <div id="recent-themes" class="recent-themes"></div>
    </div>
    <p id="library-progress" class="hint" hidden></p>
  </div>
  <aside class="home-aside">
    <div id="resume-card" hidden>...기존 그대로...</div>
    <div class="panel" id="week-card" hidden>
      <p class="label">이번 주</p>
      <div id="week-days" class="week-days"></div>
      <p id="week-streak" class="hint" hidden></p>
      <p id="week-progress"></p>
      <div class="week-bar"><div id="week-bar"></div></div>
      <div class="goal">
        <button id="goal-minus" type="button" class="ghost" aria-label="목표 줄이기">−</button>
        <span>목표 <b id="goal-value"></b> 세션</span>
        <button id="goal-plus" type="button" class="ghost" aria-label="목표 늘리기">+</button>
      </div>
    </div>
  </aside>
</section>
```

`#home-stats`, `#stat-*`, `#home-recent`, `#recent-list`와 그것을 그리는 코드(`renderRecent`)는 삭제한다. `relativeDay`는 다른 곳이 쓰면 남기고, 아무도 안 쓰면 테스트와 함께 지운다(보고서에 적음).

**동작 규칙:**
- `loadHome()`:
  - 요청 전: `#today-body`에 `.thinking` 점 + `오늘의 추천 불러오는 중...`, `#today-alt`·`#recommend`·`#week-card`·`#recent-themes-wrap`·`#library-progress`·`#resume-card` 숨김(기존 규칙).
  - 요청 시점 언어를 잡고 응답 때 달라졌으면 버린다(기존).
  - 성공: `#home-greeting` = `has_history ? '오늘은 뭘 연습할까요?' : '첫 연습을 시작해 보세요'`; `renderToday(recommend)`; 약점 줄(기존 로직); `has_history`면 `renderWeek(week, streak)`·`renderRecentThemes(recent_themes)`, 아니면 둘 다 숨김; `renderLibraryProgress(library)`; 이어서 하기(기존); `syncAside()`는 `#resume-card`·`#week-card` 기준.
  - 실패: `#today-card` 숨김(모드 카드는 그대로), 나머지 숨김, `syncAside()`.
- `renderToday(recs)`:
  - `recs`가 비었으면 `#today-body` = `새 대본을 준비하고 있어요. 그동안 직접 만들기나 수업으로 연습해 보세요.`, `#today-alt` 숨김.
  - 아니면 `current = recs[0]`, `alt = recs[1]`. 본문: `.today-title`(title), `.today-situations`(situations 앞 3개 ` · `), `.today-reason`(reason), 버튼 `button[data-mode="script"]` `스크립트로 시작`(ready.script 0이면 disabled + 버튼 옆 `대본 준비 중`), `button[data-mode="free"]` `자유 대화로 시작`(ready.free false면 disabled + `대본 준비 중`). 버튼 클릭 → `startTheme(mode, current.theme_id)`.
  - `alt`가 있으면 `#today-alt` = `또는: <alt.title> →`, 클릭하면 `current`와 `alt`를 맞바꿔 다시 그린다(요청 없음, 시작 없음).
- `renderWeek(week, streak)`: `#week-days`에 칸 7개(`span.day`, `.practiced`/`.today`/`.future` 클래스, 안에 요일 글자와 점). `#week-streak` = `연속 ${streak}일`(0이면 숨김). `#week-progress` = `이번 주 ${n}/${goal} 세션` + (n ≥ goal이면 ` · 목표 달성!`). `#week-bar` 폭 = `${Math.min(n/goal,1)*100}%`. `#goal-value` = goal. `#goal-minus` disabled at 1, `#goal-plus` disabled at 14.
- `changeGoal(delta)`: 새 값을 1~14로 자르고, 같으면 아무것도 안 함. 화면을 바로 새 값으로 다시 그림 → `POST /settings/weekly-goal` → 실패하면 이전 값으로 다시 그리고 `notify('목표를 저장하지 못했어요')`. 저장 중에는 두 버튼 disabled.
- `renderRecentThemes(items)`: 0개면 `#recent-themes-wrap` 숨김. 카드 `button.recent-theme[data-theme][data-mode]` 안에 `.t`(title), `.m`(`스크립트`/`자유 상황극`). 클릭 → `startTheme(mode, theme_id)`.
- `renderLibraryProgress({scripts, target})`: `scripts < target`이면 `새 대본 준비 중 · ${scripts}/${target}편` 보이기, 아니면 숨김.
- `pick.startTheme(mode, themeId)`: `isBusy()`면 return. `await openPick(mode)`; 테마 목록에서 그 테마를 찾아 `selectCategory(theme.category)` → `await selectTheme(themeId)` → `await startFromPick()`. 테마가 목록에 없거나 준비 안 됐으면 `notify('이 테마는 아직 준비되지 않았어요')` 하고 테마 화면에 머문다.
- `main.js`: 클릭 위임은 `#today-body`, `#today-alt`, `#recent-themes`, `#goal-minus`, `#goal-plus`에 연결한다(home.js가 요소에 직접 리스너를 달면 main.js는 건드리지 않아도 된다 -- 기존 코드 스타일을 따르고 보고서에 적는다).

**CSS** (`components.css`, 정의된 토큰만):
- `.today-card`: 기존 `.panel`보다 강조(배경 `--accent-soft` 계열 또는 테두리 `--accent`), 버튼 줄 `display:flex; gap; flex-wrap:wrap`.
- `.today-title` 크게(`--text-xl`), `.today-situations`·`.today-reason` `--text-sm` `--text-dim`.
- `.week-days`: `display:grid; grid-template-columns: repeat(7, 1fr)`, `.day` 가운데 정렬, 점 `8px` 원(연습함 `--accent`, 안 함 `--line`), `.today` 테두리, `.future` 흐리게.
- `.week-bar`: 높이 6px, 배경 `--line`, 안쪽 `--accent`, 둥글게.
- `.recent-themes`: `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`, 카드는 `.theme-card`와 같은 모양.
- 좁은 화면(`max-width: 720px`): `#home`을 한 줄 grid로 두고 `order` 또는 `grid-template-areas`로 스펙의 순서(추천 → 이어서 하기 → 이번 주 → 약점 줄 → 모드 → 최근 테마 → 준비 상태 줄). `.home-main`/`.home-aside`가 `display: contents`가 되어야 순서를 섞을 수 있다 -- 그 방식이 기존 `no-aside` 규칙과 충돌하지 않는지 확인한다.

- [ ] **Step 1: 실패하는 테스트**

`static/js/home.test.js`(기존 `beforeEach` 재import 방식)에 추가하고, 삭제된 요소(`#home-stats`, `#home-recent`)를 쓰는 기존 테스트는 새 요소 기준으로 바꾸거나 지운다(보고서에 목록).

```js
const PAYLOAD = (over = {}) => ({
  streak: 2, week_turns: 10, fixed_total: 3, top_tags: [], recent: [],
  has_history: true,
  week: { sessions: 3, goal: 5, days: [
    { date: '2026-09-14', label: '월', practiced: true, today: false, future: false },
    { date: '2026-09-15', label: '화', practiced: false, today: false, future: false },
    { date: '2026-09-16', label: '수', practiced: true, today: true, future: false },
    { date: '2026-09-17', label: '목', practiced: false, today: false, future: true },
    { date: '2026-09-18', label: '금', practiced: false, today: false, future: true },
    { date: '2026-09-19', label: '토', practiced: false, today: false, future: true },
    { date: '2026-09-20', label: '일', practiced: false, today: false, future: true },
  ] },
  recommend: [
    { theme_id: 'hotel', title: '호텔', category: 'travel', situations: ['체크인', '방 문제 알리기', '짐 맡기기', '체크아웃 연장'], reason: '아직 안 해본 테마예요', ready: { free: true, script: 3 } },
    { theme_id: 'meetings', title: '회의', category: 'business', situations: ['의견 말하기'], reason: '어제 연습했어요', ready: { free: false, script: 3 } },
  ],
  recent_themes: [{ theme_id: 'cafe-restaurant', title: '카페·음식점 주문', mode: 'script' }],
  library: { scripts: 312, target: 600 },
  ...over,
});

function homeRoutes(payload, extra = {}) {
  const seen = { goals: [] };
  stubFetch(async (url, options = {}) => {
    if (url.startsWith('/api/sessions/resumable')) return jsonResponse({ session: null });
    if (url.startsWith('/api/stats/home')) return extra.stats ? extra.stats(url) : jsonResponse(payload);
    if (url === '/api/settings/weekly-goal') {
      seen.goals.push(JSON.parse(options.body).goal);
      return extra.goal ? extra.goal() : jsonResponse({ goal: JSON.parse(options.body).goal });
    }
    return jsonResponse({});
  });
  return seen;
}

test('while home loads the recommendation slot says so', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async () => { await held; return jsonResponse(PAYLOAD()); } });
  const loading = home.loadHome();
  await new Promise((r) => setTimeout(r, 0));
  assert.match($('today-body').textContent, /오늘의 추천 불러오는 중\.\.\./);
  release();
  await loading;
  assert.match($('today-body').textContent, /호텔/);
});

test("today's card shows the reason, disables a mode that is not ready, and swaps with the alternative", async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  assert.match($('today-body').textContent, /아직 안 해본 테마예요/);
  assert.match($('today-body').textContent, /체크인 · 방 문제 알리기 · 짐 맡기기/);
  assert.equal($('today-alt').textContent, '또는: 회의 →');
  home.swapToday();
  assert.match($('today-body').textContent, /회의/);
  const free = $('today-body').children.flatMap((c) => c.children || []).find((b) => b.dataset && b.dataset.mode === 'free');
  assert.equal(free.disabled, true);
});

test('an empty library says scripts are being prepared', async () => {
  homeRoutes(PAYLOAD({ recommend: [] }));
  await home.loadHome();
  assert.match($('today-body').textContent, /새 대본을 준비하고 있어요/);
  assert.equal($('today-alt').hidden, true);
});

test('a first-time learner gets the welcome and no week or recent themes', async () => {
  homeRoutes(PAYLOAD({ has_history: false, recent_themes: [] }));
  await home.loadHome();
  assert.equal($('home-greeting').textContent, '첫 연습을 시작해 보세요');
  assert.equal($('week-card').hidden, true);
  assert.equal($('recent-themes-wrap').hidden, true);
});

test('the week card: seven days, streak, progress and bar', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  const days = $('week-days').children;
  assert.equal(days.length, 7);
  assert.ok(days[0].classList.contains('practiced'));
  assert.ok(days[2].classList.contains('today'));
  assert.ok(days[3].classList.contains('future'));
  assert.equal($('week-streak').textContent, '연속 2일');
  assert.equal($('week-progress').textContent, '이번 주 3/5 세션');
  assert.equal($('week-bar').style.width, '60%');
});

test('reaching the goal says so, and a zero streak hides its line', async () => {
  const p = PAYLOAD({ streak: 0 });
  p.week.sessions = 6;
  homeRoutes(p);
  await home.loadHome();
  assert.equal($('week-progress').textContent, '이번 주 6/5 세션 · 목표 달성!');
  assert.equal($('week-bar').style.width, '100%');
  assert.equal($('week-streak').hidden, true);
});

test('the goal changes at once, is saved, stops at the bounds, and rolls back on failure', async () => {
  const seen = homeRoutes(PAYLOAD());
  await home.loadHome();
  await home.changeGoal(+1);
  assert.equal($('goal-value').textContent, '6');
  assert.deepEqual(seen.goals, [6]);

  const p = PAYLOAD(); p.week.goal = 14;
  homeRoutes(p); await home.loadHome();
  assert.equal($('goal-plus').disabled, true);

  homeRoutes(PAYLOAD(), { goal: () => jsonResponse({ detail: 'x' }, { ok: false, status: 500 }) });
  await home.loadHome();
  await home.changeGoal(-1);
  assert.equal($('goal-value').textContent, '5');
  assert.match($('notice').textContent, /목표를 저장하지 못했어요/);
});

test('recent themes render up to four and library progress shows only while incomplete', async () => {
  homeRoutes(PAYLOAD());
  await home.loadHome();
  assert.equal($('recent-themes').children.length, 1);
  assert.equal($('library-progress').textContent, '새 대본 준비 중 · 312/600편');
  homeRoutes(PAYLOAD({ library: { scripts: 600, target: 600 } }));
  await home.loadHome();
  assert.equal($('library-progress').hidden, true);
});

test('a stale response for another language is not painted', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  homeRoutes(null, { stats: async (url) => {
    if (url.includes('language=en')) { await held; return jsonResponse(PAYLOAD()); }
    return jsonResponse(PAYLOAD({ recommend: [{ ...PAYLOAD().recommend[1] }] }));
  } });
  state.language = 'en';
  const first = home.loadHome();
  state.language = 'ja';
  await home.loadHome();
  release();
  await first;
  assert.match($('today-body').textContent, /회의/);
});
```

(`swapToday`는 `또는:` 클릭이 부르는 export. dom-shim에서 `style`이 없으면 `El`에 `style = {}`가 있는지 확인하고, 없으면 shim이 아니라 테스트에서 `.style` 대신 `dataset.width` 같은 우회를 쓰지 말고 **shim에 `style` 객체를 추가**한다(작은 변경, 보고서에 적음).)

`static/js/pick.test.js`에 추가:

```js
test('startTheme opens the mode, selects the theme in its own tab, and starts with visible steps', async () => {
  const seen = routes();
  await pick.startTheme('script', 'hotel');
  assert.equal(state.mode, 'script');
  assert.equal(seen.picks[0].theme_id, 'hotel');
  assert.equal(seen.sessions[0].scenario_id, 'lib-hotel-en-07');
  assert.deepEqual(seen.statuses, ['음성 준비 중...']);
});

test('startTheme does nothing while a start is already running', async () => {
  const seen = routes();
  home.setBusy(true);
  await pick.startTheme('script', 'hotel');
  home.setBusy(false);
  assert.equal(seen.picks.length, 0);
});

test('startTheme on a theme that is not ready says so and stays on the pick screen', async () => {
  const seen = routes();
  await pick.startTheme('script', 'shopping');
  assert.equal(seen.sessions.length, 0);
  assert.match($('notice').textContent, /이 테마는 아직 준비되지 않았어요/);
  assert.equal(router.current(), 'pick');
});
```

(`routes()`와 `THEMES`는 pick.test.js의 기존 헬퍼. `home` import 이름·`setBusy` 경로는 그 파일의 기존 가드 테스트를 따른다.)

- [ ] **Step 2: RED 확인** — `node --test --test-force-exit static/js/home.test.js static/js/pick.test.js`.

- [ ] **Step 3: 구현** — 위 규칙대로.

- [ ] **Step 4: GREEN** — node 전체, pytest `tests/test_css_tokens.py tests/test_pick_css.py tests/test_brand.py`.

- [ ] **Step 5: 부수기** — (1) `loadHome`의 언어 비교 삭제: stale 테스트 FAIL. (2) `changeGoal` 실패 시 되돌림 삭제: 목표 테스트 FAIL. (3) `startTheme`의 `isBusy` 가드 삭제: 해당 테스트 FAIL. (4) `renderLibraryProgress` 조건을 항상 보이게: 진행 줄 테스트 FAIL. 되돌리고 GREEN.

- [ ] **Step 6: 커밋** — `feat: a home that suggests today's theme, shows the week, and starts recent themes in one press`

---

## 운영 (컨트롤러)

1. 브라우저 확인은 워크트리를 **8010**으로(DB 복사본 -- 생성 중인 본 DB를 복사해도 된다: 읽기 전용 스냅샷) 띄워 데스크톱과 좁은 창(400px) 둘 다.
2. main 머지 → 8000 재시작. **생성 작업은 서버와 별도 프로세스라 재시작해도 계속 돈다**(재시작 전 `build_library.log`가 계속 늘어나는지 확인).
