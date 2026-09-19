"""GET /api/stats/growth -- the 성장 tab's numbers, all counted from stored rows."""
import json
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import api, config, db
from app.main import app

TODAY = date(2026, 9, 16)  # a Wednesday


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    db.init_db()
    monkeypatch.setattr(api, "_today", lambda: TODAY)
    return TestClient(app)


def _stamp(day, hour=12, minute=0, second=0):
    local = datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=datetime.now().astimezone().tzinfo)
    return local.astimezone(timezone.utc).isoformat(timespec="seconds")


def _at(message_id, day, hour=12, minute=0, second=0):
    with db.connect() as conn:
        conn.execute("UPDATE messages SET created_at = ? WHERE id = ?", (_stamp(day, hour, minute, second), message_id))


def _session(day, turns=((None,),), language="en", mode="free", hour=12):
    """One finished session; each turn is (ok,) and is stamped `day` a minute apart."""
    sid = db.create_session(language, mode, scenario_id="airport-checkin-en")
    for i, (ok,) in enumerate(turns):
        mid = db.add_message(sid, "user", f"t{i}", ok=ok)
        _at(mid, day, hour, i)
    db.end_session(sid, json.dumps({"summary": "s"}), "beginner")
    return sid


def _get(client, language="en"):
    return client.get(f"/api/stats/growth?language={language}").json()


def test_empty_shapes_and_lengths(client):
    body = _get(client)
    assert len(body["calendar"]) == 112
    assert body["calendar"][0]["day"] == "2026-06-01"          # a Monday, 15 weeks before this one
    assert date.fromisoformat(body["calendar"][0]["day"]).weekday() == 0
    assert body["calendar"][-1]["day"] == "2026-09-20"         # this week's Sunday: today sits in the last column
    assert body["today"] == "2026-09-16"
    assert all(c["turns"] == 0 for c in body["calendar"])
    assert (body["streak"], body["longest"], body["minutes"]) == (0, 0, 0)
    assert len(body["accuracy"]) == 12
    assert body["accuracy"][0] == {"week": "2026-06-29", "correct": 0, "graded": 0}
    assert body["accuracy"][-1]["week"] == "2026-09-14"
    assert body["timed"] == [] and body["level_tests"] == []


def test_a_day_with_turns_is_counted_on_its_local_date(client):
    _session(TODAY, turns=((1,), (0,), (None,)))
    sid = _session(TODAY - timedelta(days=2), turns=((None,),))
    # just after local midnight: still that local day, even though UTC says the day before
    mid = db.add_message(sid, "user", "early")
    _at(mid, TODAY - timedelta(days=1), hour=0, minute=5)
    cal = {c["day"]: c["turns"] for c in _get(client)["calendar"]}
    assert cal["2026-09-16"] == 3 and cal["2026-09-15"] == 1 and cal["2026-09-14"] == 1
    assert sum(cal.values()) == 5


def test_bot_lines_are_not_turns(client):
    sid = _session(TODAY, turns=((1,),))
    _at(db.add_message(sid, "bot", "reply"), TODAY, 12, 30)
    assert {c["day"]: c["turns"] for c in _get(client)["calendar"]}["2026-09-16"] == 1


def test_streak_and_longest_across_a_gap(client):
    # four days in a row long ago, a gap, then yesterday and the day before
    for back in (30, 29, 28, 27, 2, 1):
        _session(TODAY - timedelta(days=back))
    body = _get(client)
    assert body["streak"] == 2       # not practised yet today: home_stats' one forgiven day
    assert body["longest"] == 4


def test_streak_breaks_after_a_missed_day(client):
    for back in (5, 4, 3):
        _session(TODAY - timedelta(days=back))
    body = _get(client)
    assert (body["streak"], body["longest"]) == (0, 3)


def test_minutes_sum_capped_gaps_and_timed_round_seconds(client):
    sid = db.create_session("en", "free")
    for i, (h, m) in enumerate(((10, 0), (10, 3), (11, 0))):  # 3 min, then a 57 min gap capped at 5
        mid = db.add_message(sid, "user" if i % 2 == 0 else "bot", f"x{i}")
        _at(mid, TODAY, h, m)
    tid = db.create_session("en", "timed", topic="t")
    db.add_round(tid, 1, 60.0, 90, 1, ["a."], None)
    db.add_round(tid, 2, 60.0, 100, 0, ["a."], None)
    assert _get(client)["minutes"] == 3 + 5 + 2


def test_accuracy_buckets_by_local_week_and_leaves_empty_weeks_zero(client):
    _session(date(2026, 9, 14), turns=((1,), (1,), (0,)))               # this Monday
    _session(date(2026, 9, 20 - 7), turns=((0,),))                      # last Sunday -> last week
    _session(date(2026, 9, 1), turns=((1,), (None,)))                   # ungraded turn doesn't count
    _session(date(2026, 6, 28), turns=((1,),))                          # the day before the 12-week window
    acc = {a["week"]: (a["correct"], a["graded"]) for a in _get(client)["accuracy"]}
    assert acc["2026-09-14"] == (2, 3)
    assert acc["2026-09-07"] == (0, 1)
    assert acc["2026-08-31"] == (1, 1)
    assert acc["2026-08-24"] == (0, 0)
    assert sum(g for _, g in acc.values()) == 5


def test_script_sessions_count_as_turns_but_not_toward_accuracy(client):
    _session(TODAY, turns=((0,), (1,)), mode="script")
    body = _get(client)
    assert {c["day"]: c["turns"] for c in body["calendar"]}["2026-09-16"] == 2
    assert all(a["graded"] == 0 for a in body["accuracy"])


def _timed(words, seconds, pauses, finished=True, language="en", extra_round=None):
    sid = db.create_session(language, "timed", topic="t")
    db.add_round(sid, 1, seconds, words, pauses, ["a."], None)
    if extra_round:
        db.add_round(sid, 2, *extra_round, ["a."], None)
    if finished:
        db.end_session(sid, json.dumps({"kind": "timed"}), "beginner")
    return sid


def test_timed_is_round_one_of_finished_sessions_oldest_first(client):
    a = _timed(90, 60.0, 2, extra_round=(30.0, 200, 0))
    _timed(50, 30.0, 0, finished=False)
    b = _timed(40, 30.0, 1)
    rows = _get(client)["timed"]
    assert [(r["session_id"], r["wpm"], r["long_pauses"], r["words"]) for r in rows] == [(a, 90, 2, 90), (b, 80, 1, 40)]
    assert rows[0]["day"] == datetime.now().date().isoformat()


def test_timed_keeps_the_newest_twenty(client):
    ids = [_timed(10 + i, 60.0, 0) for i in range(22)]
    rows = _get(client)["timed"]
    assert [r["session_id"] for r in rows] == ids[2:]


def _level_test(cefr, step, language="en", finished_at="2026-09-10T03:00:00+00:00"):
    from app import leveltest
    tid = db.create_level_test(language)
    result = {"cefr": cefr, "step": step, **leveltest.conversions(cefr, step, language)}
    db.finish_level_test(tid, result, leveltest.app_level(cefr))
    with db.connect() as conn:
        conn.execute("UPDATE level_tests SET finished_at = ?, result_json = json_set(result_json, '$.finished_at', ?)"
                     " WHERE id = ?", (finished_at, finished_at, tid))
    return tid


def test_level_tests_newest_first_with_conversions(client):
    _level_test("A2", "상위", finished_at="2026-08-01T03:00:00+00:00")
    _level_test("B1", "상위", finished_at="2026-09-10T03:00:00+00:00")
    db.create_level_test("en")  # started, never finished
    tests = _get(client)["level_tests"]
    assert tests == [
        {"finished_at": "2026-09-10T03:00:00+00:00", "cefr": "B1", "step": "상위", "ielts": "4.5–5.0",
         "toefl": {"band": "3.5", "old": "18–19"}, "jf": None},
        {"finished_at": "2026-08-01T03:00:00+00:00", "cefr": "A2", "step": "상위", "ielts": "4.0 미만",
         "toefl": {"band": "2.5", "old": "13–15"}, "jf": None},
    ]


def test_japanese_level_test_carries_jf_only(client):
    _level_test("B1", "하위", language="ja")
    (t,) = _get(client, "ja")["level_tests"]
    assert (t["jf"], t["ielts"], t["toefl"]) == ("JF 스탠다드 B1", None, None)


def test_languages_are_kept_apart(client):
    _session(TODAY, turns=((1,), (1,)), language="ja")   # a minute apart: 1 minute of practice
    _timed(60, 60.0, 0, language="ja")
    _level_test("B1", "상위", language="ja")
    body = _get(client, "en")
    assert all(c["turns"] == 0 for c in body["calendar"])
    assert (body["streak"], body["longest"], body["minutes"]) == (0, 0, 0)
    assert all(a["graded"] == 0 for a in body["accuracy"])
    assert body["timed"] == [] and body["level_tests"] == []
    ja = _get(client, "ja")
    assert ja["streak"] == 1 and len(ja["timed"]) == 1 and len(ja["level_tests"]) == 1


def test_level_tests_are_not_practice_turns(client):
    _level_test("B1", "상위")
    body = _get(client)
    assert all(c["turns"] == 0 for c in body["calendar"]) and body["streak"] == 0
