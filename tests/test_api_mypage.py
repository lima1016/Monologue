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


def test_level_waits_for_enough_utterances_not_only_sessions(client):
    for _ in range(3):
        _finished(turns=[("a", 1, None, None)] * 2)
    level = client.get("/api/stats/mypage?language=en").json()["level"]
    assert level["value"] is None and level["sessions"] == 3 and level["utterances"] == 6


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
