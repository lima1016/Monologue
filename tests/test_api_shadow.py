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
