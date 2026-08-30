import json

import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    db.init_db()
    return TestClient(app)


@pytest.fixture()
def session(client):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(sid, "bot", "Hello there!")
    db.add_message(sid, "user", "I go there yesterday", correction="Use past tense.")
    return sid


# A full, well-formed model response used wherever a test isn't specifically
# exercising one field of it.
REPORT_RESULT = {
    "summary": "좋았습니다.",
    "weak_points": ["시제를 자주 틀렸습니다."],
    "expressions": ["I went there"],
    "next_focus": "과거형을 더 연습하세요.",
    "level": "intermediate",
}


def test_ending_a_session_saves_report_and_level(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: dict(REPORT_RESULT))
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["summary"] == "좋았습니다."
    assert body["weak_points"] == ["시제를 자주 틀렸습니다."]
    assert body["expressions"] == ["I went there"]
    assert body["next_focus"] == "과거형을 더 연습하세요."
    assert body["level"] == "intermediate"
    # The counts computed in db.session_stats ride along in the response so
    # the frontend can render them without a second round trip.
    assert body["stats"]["turns"] == 1

    row = db.get_session(session)
    stored = json.loads(row["report"])
    assert stored["summary"] == "좋았습니다."
    assert stored["weak_points"] == ["시제를 자주 틀렸습니다."]
    assert stored["expressions"] == ["I went there"]
    assert stored["next_focus"] == "과거형을 더 연습하세요."
    assert row["level"] == "intermediate"
    assert row["ended_at"] is not None


def test_the_transcript_reaches_the_report_prompt(client, session, monkeypatch):
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return dict(REPORT_RESULT)

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{session}/end")
    assert "I go there yesterday" in seen["text"]
    assert "Use past tense." in seen["text"]


def test_script_mode_report_gets_the_original_script_for_comparison(client, monkeypatch):
    sid = db.create_session("en", "script", scenario_id="standup-meeting-en")
    db.add_message(sid, "user", "I finish the login bug yesterday")
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return dict(REPORT_RESULT)

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{sid}/end")

    assert "The script the learner was reading from" in seen["text"]
    assert "I finished the login bug" in seen["text"]      # the scripted line
    assert "I finish the login bug yesterday" in seen["text"]  # what they said


def test_free_mode_report_does_not_include_a_script_section(client, session, monkeypatch):
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return dict(REPORT_RESULT)

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{session}/end")
    assert "The script the learner was reading from" not in seen["text"]


def test_the_level_the_model_reported_is_stored_on_the_session(client, session, monkeypatch):
    """Stored, not shown: db.stable_level reads these rows back over a window
    of recent sessions to pitch the next one. Asserted straight off the session
    row -- db.latest_level, which this used to go through, had no production
    caller left once stable_level replaced it and has been removed."""
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {**REPORT_RESULT, "level": "advanced"})
    client.post(f"/api/sessions/{session}/end")
    assert db.get_session(session)["level"] == "advanced"


def test_an_invalid_level_from_the_model_falls_back_to_beginner(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {**REPORT_RESULT, "level": "wizard"})
    assert client.post(f"/api/sessions/{session}/end").json()["level"] == "beginner"


def test_a_capitalized_level_is_normalised(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {**REPORT_RESULT, "level": "Advanced"})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["level"] == "advanced"
    row = db.get_session(session)
    assert row["level"] == "advanced"


def test_a_level_with_whitespace_is_normalised(client, session, monkeypatch):
    monkeypatch.setattr(
        "app.api.llm.chat_json",
        lambda messages, schema, **kw: {**REPORT_RESULT, "level": " intermediate "})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["level"] == "intermediate"


def test_a_none_level_falls_back_to_beginner(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {**REPORT_RESULT, "level": None})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["level"] == "beginner"


def test_ending_twice_is_rejected(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: dict(REPORT_RESULT))
    client.post(f"/api/sessions/{session}/end")
    assert client.post(f"/api/sessions/{session}/end").status_code == 409


def test_ending_an_empty_session_still_closes_it(client, monkeypatch):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: dict(REPORT_RESULT))
    assert client.post(f"/api/sessions/{sid}/end").status_code == 200
    assert db.get_session(sid)["ended_at"] is not None


def test_a_report_failure_still_closes_the_session(client, session, monkeypatch):
    """The property that must survive the reshape: a model outage does not
    lose the conversation. The session still closes, and the learner still
    gets a well-formed (if empty) report shape to render, with a Korean
    notice explaining why it's empty."""
    def boom(messages, schema, **kw):
        raise Exception("model down")

    monkeypatch.setattr("app.api.llm.chat_json", boom)
    r = client.post(f"/api/sessions/{session}/end")
    assert r.status_code == 200
    body = r.json()
    assert "리포트" in body["summary"]
    assert body["weak_points"] == []
    assert body["expressions"] == []
    assert body["level"] == "beginner"
    assert "stats" in body
    assert db.get_session(session)["ended_at"] is not None

    row = db.get_session(session)
    stored = json.loads(row["report"])
    assert "리포트" in stored["summary"]


def test_report_stats_include_ungraded_count(client, monkeypatch):
    """The report screen's only cue that a turn was never actually graded --
    without it, a session where every grading call failed reads as flawless
    (wrong == 0) instead of as ungraded."""
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(sid, "bot", "Hello there!")
    db.add_message(sid, "user", "no feedback was obtained")  # ok left NULL
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: dict(REPORT_RESULT))
    body = client.post(f"/api/sessions/{sid}/end").json()
    assert body["stats"]["wrong"] == 0
    assert body["stats"]["ungraded"] == 1


def test_history_lists_sessions_newest_first(client, session):
    later = db.create_session("ja", "lesson", topic="て form")
    ids = [s["id"] for s in client.get("/api/sessions").json()["sessions"]]
    assert ids[0] == later


def test_session_detail_returns_transcript(client, session):
    body = client.get(f"/api/sessions/{session}").json()
    assert body["session"]["id"] == session
    assert [m["speaker"] for m in body["messages"]] == ["bot", "user"]


def test_session_detail_404s_when_missing(client):
    assert client.get("/api/sessions/999").status_code == 404
