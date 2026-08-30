"""POST /api/script-turn.

Script mode currently rides /chat, the free-conversation route: it invents a
bot reply with the LLM and grades the learner's line as if they had composed
it. Neither is true in script mode -- the learner read a line that was
already written, so there is no bot reply to invent and nothing of theirs to
grade. This route records the learner's line without either.
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


def test_script_turn_never_calls_the_llm(client, monkeypatch):
    """The proof, not a call-count assertion: a raising stub cannot pass for
    the wrong reason. Script mode's bot reply already exists in the script --
    nothing here should ever reach for the model."""
    def boom(*args, **kwargs):
        raise AssertionError("llm.chat must not be called for a script turn")
    monkeypatch.setattr("app.api.llm.chat", boom)
    monkeypatch.setattr("app.api.llm.chat_json", boom)

    sid = start_script_session(client)
    r = client.post("/api/script-turn", json={
        "session_id": sid, "text": "Yeah, give me a sec. Okay, I'm ready.",
    })
    assert r.status_code == 200


def test_script_turn_stores_the_learners_line_with_no_grading_fields(client, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("llm must not be called")
    monkeypatch.setattr("app.api.llm.chat", boom)
    monkeypatch.setattr("app.api.llm.chat_json", boom)

    sid = start_script_session(client)
    client.post("/api/script-turn", json={
        "session_id": sid, "text": "Yeah give me a sec okay I'm ready",
    })

    msgs = db.get_messages(sid)
    assert len(msgs) == 1
    stored = msgs[0]
    assert stored["speaker"] == "user"
    assert stored["text"] == "Yeah give me a sec okay I'm ready"
    assert stored["ok"] is None
    assert stored["fixed"] is None
    assert stored["tag"] is None
    assert stored["correction"] is None
    assert stored["suggestion"] is None


def test_script_turn_on_an_unknown_session_is_a_404(client):
    assert client.post("/api/script-turn",
                       json={"session_id": 9999, "text": "hi"}).status_code == 404


def test_script_turn_on_a_finished_session_is_rejected(client):
    sid = start_script_session(client)
    db.end_session(sid, "done", "beginner")
    r = client.post("/api/script-turn", json={"session_id": sid, "text": "hi"})
    assert r.status_code == 409


def test_script_turn_with_blank_text_is_rejected(client):
    sid = start_script_session(client)
    r = client.post("/api/script-turn", json={"session_id": sid, "text": "   "})
    assert r.status_code == 400


def test_script_turn_on_a_free_session_is_rejected(client):
    """Free mode keeps using /chat -- this route is for script sessions only."""
    sid = start_free_session(client)
    r = client.post("/api/script-turn", json={"session_id": sid, "text": "hello"})
    assert r.status_code == 400


def test_free_mode_chat_is_unaffected(client, monkeypatch):
    """Regression: free mode must keep going through /chat, LLM call and all."""
    monkeypatch.setattr("app.api.llm.chat", lambda *a, **kw: "Sure, right this way!")
    monkeypatch.setattr("app.api.llm.chat_json", lambda *a, **kw: {
        "ok": True, "fixed": None, "tag": "없음", "correction": None, "suggestion": None,
    })
    sid = start_free_session(client)
    r = client.post("/api/chat", json={"session_id": sid, "text": "Hi there"})
    assert r.status_code == 200
    assert r.json()["bot_reply"] == "Sure, right this way!"
