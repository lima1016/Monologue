"""POST /api/sessions/{id}/script-line.

Script mode's own /sessions response never stores anything -- the learner has
not seen a single line yet at that point. Without this route the database
never learns what the learner was actually shown, which is exactly what left
a real learner's session full of bot lines nobody ever saw or heard.
"""
import pytest
from fastapi.testclient import TestClient

from app import config, db, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    return TestClient(app)


def start_script_session(client, scenario_id="standup-meeting-en", language="en"):
    return client.post("/api/sessions", json={
        "language": language, "mode": "script", "scenario_id": scenario_id,
    }).json()["session_id"]


def start_free_session(client):
    return client.post("/api/sessions", json={
        "language": "en", "mode": "free", "scenario_id": "airport-checkin-en",
    }).json()["session_id"]


def test_script_line_stores_the_bots_line_exactly(client):
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r.status_code == 200

    msgs = db.get_messages(sid)
    assert len(msgs) == 1
    assert msgs[0]["speaker"] == "bot"
    assert msgs[0]["text"] == "Morning! Ready for standup?"


def test_script_line_is_idempotent_for_a_repeated_index(client):
    """A refresh or a retried request must not double the record -- that is
    exactly the kind of fiction this fix exists to stop."""
    sid = start_script_session(client)
    client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r.status_code == 200

    msgs = db.get_messages(sid)
    assert len(msgs) == 1
    assert msgs[0]["text"] == "Morning! Ready for standup?"


def test_script_line_rejects_a_learner_line_index(client):
    """Index 1 in standup-meeting-en is the learner's line -- this route only
    ever stores what the bot showed the learner, never their own line."""
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 1})
    assert r.status_code == 400
    assert db.get_messages(sid) == []


def test_script_line_rejects_an_out_of_range_index(client):
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 99})
    assert r.status_code == 400
    assert db.get_messages(sid) == []


def test_script_line_rejects_a_negative_index(client):
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": -1})
    assert r.status_code == 400


def test_script_line_rejects_a_non_script_session(client):
    sid = start_free_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r.status_code == 400
    # only the free session's own opening message, untouched
    assert len(db.get_messages(sid)) == 1


def test_script_line_on_an_unknown_session_is_a_404(client):
    assert client.post("/api/sessions/9999/script-line", json={"index": 0}).status_code == 404
