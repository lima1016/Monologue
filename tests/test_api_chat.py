import io

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
    return TestClient(app)


@pytest.fixture(autouse=True)
def fake_engines(monkeypatch):
    # Captures the schema each call to chat_json received, so tests can check
    # that the session's language actually reached feedback_schema() -- a
    # hardcoded feedback_schema("en") in app/api.py would pass every other
    # test here while silently disabling the Japanese tag vocabulary.
    calls = {}

    def fake_chat(messages, **kw):
        # The opening line and a mid-conversation reply must differ, or the TTS cache
        # dedupes them by content hash and the reply never reaches the engine — which
        # would silently hide the failure path test_chat_still_succeeds_when_tts_fails
        # exists to check. A real model never returns byte-identical text for both.
        if messages[-1]["content"].startswith("Start the conversation"):
            return "Good morning! Checking in today?"
        return "Sure, right this way!"

    def fake_chat_json(messages, schema, **kw):
        calls["schema"] = schema
        return {
            "ok": False,
            "fixed": "I went there.",
            "tag": "시제",
            "correction": "'go'는 과거형이 아닙니다.",
            "suggestion": "'I went there.'라고 말하세요.",
        }

    monkeypatch.setattr("app.api.llm.chat", fake_chat)
    monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    return calls


def test_free_session_starts_and_returns_an_opening_line(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    body = r.json()
    assert body["session_id"] > 0
    assert body["opening"]
    assert body["opening_audio"]
    assert db.get_messages(body["session_id"])[0]["speaker"] == "bot"


def test_script_session_returns_all_lines_with_audio_for_bot_lines(client):
    body = client.post("/api/sessions", json={"language": "en", "mode": "script",
                                              "scenario_id": "standup-meeting-en"}).json()
    lines = body["lines"]
    assert len(lines) == 8
    assert all(l["audio_key"] for l in lines if l["speaker"] == "bot")
    assert all(l["audio_key"] is None for l in lines if l["speaker"] == "user")


def test_lesson_session_stores_topic_and_needs_no_scenario(client):
    body = client.post("/api/sessions", json={"language": "ja", "mode": "lesson",
                                              "topic": "て form"}).json()
    assert db.get_session(body["session_id"])["topic"] == "て form"
    assert body["opening"]


def test_free_session_without_scenario_is_rejected(client):
    assert client.post("/api/sessions", json={"language": "en", "mode": "free"}).status_code == 400


def test_session_with_unknown_scenario_is_rejected(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "nope"})
    assert r.status_code == 404


def test_chat_stores_both_turns_with_feedback_on_the_user_turn(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there yesterday"}).json()

    assert body["bot_reply"] == "Sure, right this way!"
    assert body["correction"] == "'go'는 과거형이 아닙니다."
    assert body["suggestion"] == "'I went there.'라고 말하세요."
    assert body["audio_key"]

    msgs = db.get_messages(sid)
    user_turn = [m for m in msgs if m["speaker"] == "user"][0]
    assert user_turn["text"] == "I go there yesterday"
    assert user_turn["correction"] == "'go'는 과거형이 아닙니다."
    assert msgs[-1]["speaker"] == "bot"
    assert msgs[-1]["correction"] is None


def test_chat_on_a_finished_session_is_rejected(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    db.end_session(sid, "done", "beginner")
    r = client.post("/api/chat", json={"session_id": sid, "text": "hello"})
    assert r.status_code == 409


def test_chat_on_an_unknown_session_is_rejected(client):
    assert client.post("/api/chat", json={"session_id": 999, "text": "hi"}).status_code == 404


def test_chat_with_blank_text_is_rejected(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    assert client.post("/api/chat", json={"session_id": sid, "text": "   "}).status_code == 400


def test_chat_still_succeeds_when_tts_fails(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]

    def boom(text, language, voice):
        raise tts.TTSError("engine down")

    monkeypatch.setattr(tts, "synthesize", boom)
    body = client.post("/api/chat", json={"session_id": sid, "text": "hello"}).json()
    assert body["bot_reply"]
    assert body["audio_key"] is None  # frontend falls back to browser speech


def test_chat_still_succeeds_when_cache_write_fails(client, monkeypatch):
    """A disk problem while caching the reply's audio must degrade the same way an engine
    failure does: the turn still completes and the browser falls back to its own speech,
    rather than the request 500ing."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(tts.os, "replace", boom)
    r = client.post("/api/chat", json={"session_id": sid, "text": "hello"})
    assert r.status_code == 200
    body = r.json()
    assert body["bot_reply"]
    assert body["audio_key"] is None


def test_repeated_reply_text_reuses_cached_audio(client, monkeypatch):
    """Pins the caching behaviour discovered while debugging the TTS-failure test above:
    tts.synthesize_to_cache dedupes by content hash, so a second reply with byte-identical
    text is served from the cache instead of hitting the engine again."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]

    calls = []

    def counting_synth(text, language, voice):
        calls.append(text)
        return b"RIFFfake"

    monkeypatch.setattr(tts, "synthesize", counting_synth)

    first = client.post("/api/chat", json={"session_id": sid, "text": "hello"}).json()
    second = client.post("/api/chat", json={"session_id": sid, "text": "how are you"}).json()

    assert first["bot_reply"] == second["bot_reply"] == "Sure, right this way!"
    assert first["audio_key"] and second["audio_key"]
    assert first["audio_key"] == second["audio_key"]
    assert len(calls) == 1


def test_chat_returns_and_stores_structured_feedback(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    sid = r.json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there."}).json()

    assert body["ok"] is False
    assert body["fixed"] == "I went there."
    assert body["tag"] == "시제"

    stored = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    assert stored["ok"] == 0
    assert stored["tag"] == "시제"


def test_chat_for_a_japanese_session_uses_the_japanese_tag_vocabulary(client, fake_engines):
    """Guards the single most valuable thing Phase 2A added: per-language tag
    vocabularies. A hardcoded feedback_schema("en") in app/api.py would pass
    every other test in this file while silently sending English-only tags
    (with no 조사 slot) for Japanese sessions too."""
    sid = client.post("/api/sessions", json={"language": "ja", "mode": "lesson",
                                              "topic": "て form"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "きのう、レストランに行きます。"})

    schema = fake_engines["schema"]
    tag_enum = schema["properties"]["tag"]["enum"]
    assert "조사" in tag_enum
    assert "전치사" not in tag_enum


def test_chat_survives_a_feedback_failure(client, monkeypatch):
    """A feedback failure must never cost the learner their turn -- the bot
    still replies and the message is still recorded, just without feedback."""
    def boom(messages, schema, **kw):
        raise RuntimeError("model is down")
    monkeypatch.setattr("app.api.llm.chat_json", boom)

    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    sid = r.json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there."}).json()

    assert body["bot_reply"]
    assert body["ok"] is None and body["tag"] is None
    assert body["correction"] is None
    assert body["suggestion"] is None
    assert body["fixed"] is None


def test_chat_survives_a_non_dict_feedback_response(client, monkeypatch):
    """chat_json guarantees the reply parsed as JSON, not that it parsed as an
    *object* -- a stray array (or string/number) must degrade the same
    graceful way a raised exception does, not propagate an AttributeError
    out of _feedback and 500 the whole turn."""
    monkeypatch.setattr("app.api.llm.chat_json", lambda messages, schema, **kw: ["oops"])

    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    sid = r.json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there."}).json()

    assert body["bot_reply"]
    assert body["ok"] is None and body["tag"] is None
    assert body["correction"] is None
    assert body["suggestion"] is None
    assert body["fixed"] is None


def test_audio_endpoint_serves_cached_wav(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    key = client.post("/api/chat", json={"session_id": sid, "text": "hi"}).json()["audio_key"]
    r = client.get(f"/api/audio/{key}.wav")
    assert r.status_code == 200
    assert r.content == b"RIFFfake"


def test_audio_endpoint_404s_on_unknown_key(client):
    assert client.get("/api/audio/deadbeef.wav").status_code == 404


def test_undo_last_turn_removes_it_and_lets_the_next_turn_take_its_place(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})

    r = client.delete(f"/api/sessions/{sid}/last-turn")
    assert r.status_code == 200
    assert r.json()["deleted"] == 2

    client.post("/api/chat", json={"session_id": sid, "text": "I went there."})
    texts = [m["text"] for m in db.get_messages(sid) if m["speaker"] == "user"]
    assert texts == ["I went there."]


def test_undo_on_an_unknown_session_is_a_404(client):
    assert client.delete("/api/sessions/9999/last-turn").status_code == 404


def test_recorded_audio_upload_attaches_to_the_message(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "hello"})
    message_id = [m for m in db.get_messages(sid) if m["speaker"] == "user"][0]["id"]

    r = client.post(
        f"/api/sessions/{sid}/audio",
        data={"message_id": str(message_id)},
        files={"file": ("clip.webm", io.BytesIO(b"webmdata"), "audio/webm")},
    )
    assert r.status_code == 200
    stored = [m for m in db.get_messages(sid) if m["id"] == message_id][0]["audio_path"]
    assert stored.endswith(".webm")
    assert (config.AUDIO_DIR / stored.split("/")[-1]).read_bytes() == b"webmdata"
