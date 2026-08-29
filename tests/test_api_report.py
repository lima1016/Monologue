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


def test_ending_a_session_saves_report_and_level(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "좋았습니다.",
                                                        "level": "intermediate"})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body == {"report": "좋았습니다.", "level": "intermediate"}

    row = db.get_session(session)
    assert row["report"] == "좋았습니다."
    assert row["level"] == "intermediate"
    assert row["ended_at"] is not None


def test_the_transcript_reaches_the_report_prompt(client, session, monkeypatch):
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return {"report": "r", "level": "beginner"}

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
        return {"report": "r", "level": "beginner"}

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{sid}/end")

    assert "The script the learner was reading from" in seen["text"]
    assert "I finished the login bug" in seen["text"]      # the scripted line
    assert "I finish the login bug yesterday" in seen["text"]  # what they said


def test_free_mode_report_does_not_include_a_script_section(client, session, monkeypatch):
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return {"report": "r", "level": "beginner"}

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{session}/end")
    assert "The script the learner was reading from" not in seen["text"]


def test_the_new_level_drives_the_next_session(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "advanced"})
    client.post(f"/api/sessions/{session}/end")
    assert db.latest_level("en") == "advanced"


def test_an_invalid_level_from_the_model_falls_back_to_beginner(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "wizard"})
    assert client.post(f"/api/sessions/{session}/end").json()["level"] == "beginner"


def test_a_capitalized_level_is_normalised(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "Advanced"})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["level"] == "advanced"
    row = db.get_session(session)
    assert row["level"] == "advanced"


def test_a_level_with_whitespace_is_normalised(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": " intermediate "})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["level"] == "intermediate"


def test_a_none_level_falls_back_to_beginner(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": None})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body["level"] == "beginner"


def test_ending_twice_is_rejected(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "beginner"})
    client.post(f"/api/sessions/{session}/end")
    assert client.post(f"/api/sessions/{session}/end").status_code == 409


def test_ending_an_empty_session_still_closes_it(client, monkeypatch):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "beginner"})
    assert client.post(f"/api/sessions/{sid}/end").status_code == 200
    assert db.get_session(sid)["ended_at"] is not None


def test_a_report_failure_still_closes_the_session(client, session, monkeypatch):
    def boom(messages, schema, **kw):
        raise Exception("model down")

    monkeypatch.setattr("app.api.llm.chat_json", boom)
    r = client.post(f"/api/sessions/{session}/end")
    assert r.status_code == 200
    assert "리포트" in r.json()["report"]
    assert db.get_session(session)["ended_at"] is not None


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
