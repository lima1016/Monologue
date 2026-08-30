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


def test_script_session_returns_all_lines_with_audio(client):
    body = client.post("/api/sessions", json={"language": "en", "mode": "script",
                                              "scenario_id": "standup-meeting-en"}).json()
    lines = body["lines"]
    assert len(lines) == 8
    assert all(l["audio_key"] for l in lines)


def test_a_script_gives_the_learner_their_own_lines_as_audio(client):
    """내 차례 줄을 미리 듣고 따라 읽는 것이 클릭해서 듣기의 목적이다.
    봇 줄에만 음성이 있으면 기능이 반쪽이 된다."""
    res = client.post("/api/sessions", json={
        "language": "en", "mode": "script", "scenario_id": "standup-meeting-en",
    })
    assert res.status_code == 200
    lines = res.json()["lines"]
    assert any(line["speaker"] == "user" for line in lines)
    assert all(line["audio_key"] for line in lines)


def test_lesson_session_stores_topic_and_needs_no_scenario(client):
    body = client.post("/api/sessions", json={"language": "ja", "mode": "lesson",
                                              "topic": "て form"}).json()
    assert db.get_session(body["session_id"])["topic"] == "て form"
    assert body["opening"]


def test_free_session_response_includes_the_scenario_goal(client):
    """The side panel's only content in free mode -- without this it renders a
    labelled heading over nothing."""
    body = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                              "scenario_id": "airport-checkin-en"}).json()
    assert body["goal"]  # airport-checkin-en's goal in data/scenarios.json


def test_a_scenario_from_the_other_language_is_rejected(client):
    """The home screen's language segment stays live while a scenario is being
    generated, so a switch mid-generation could post the new language with the
    old language's scenario id. Nothing downstream would notice: the session is
    stamped with the requested language, and its turns then feed that
    language's stats and level forever. The browser no longer does this, but a
    session bound to one language and stamped with another must be impossible
    by any route, not just avoided by one client."""
    r = client.post("/api/sessions", json={"language": "ja", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "en" in detail and "ja" in detail  # names both sides of the mismatch
    assert db.list_sessions() == []           # and nothing was created


def test_a_matching_language_still_starts(client):
    """The guard above must reject only the mismatch, not the ordinary case."""
    assert client.post("/api/sessions", json={"language": "en", "mode": "free",
                                              "scenario_id": "airport-checkin-en"}
                       ).status_code == 200


def test_a_free_request_naming_a_script_scenario_is_rejected(client):
    """The other axis of the same mismatch, and the one that was left open
    because it was believed to fail loudly. A *built-in* script scenario dies
    on scenario["persona_prompt"] -- a 500, but a 500 after db.create_session
    has already written the row."""
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "standup-meeting-en"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "script" in detail and "free" in detail  # names both sides
    assert db.list_sessions() == []                 # and nothing was created


def test_a_free_request_naming_a_generated_script_scenario_is_rejected(client):
    """This is the one that made the check Important rather than tidy-up: it
    used to return 200. scenarios.from_row materialises persona_prompt for script
    rows too -- NULL for any script the generator never gave one -- and
    prompts.py reads it with a bracket, so the `or`-fallback that defuses
    `goal` never fires. The session was written, the prompt carried the literal
    line "Your character: None", and nothing anywhere said so."""
    db.add_user_scenario({
        "id": "user-script-en", "language": "en", "type": "script",
        "title": "made-up script", "goal": None, "persona_prompt": None,
        "max_turns": None,
        "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hello."}],
    })
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "user-script-en"})
    assert r.status_code == 400
    assert db.list_sessions() == []


def test_a_script_request_naming_a_free_scenario_is_rejected(client):
    """The third shape: this one died on scenario["lines"], again only after
    the session row existed."""
    r = client.post("/api/sessions", json={"language": "en", "mode": "script",
                                           "scenario_id": "airport-checkin-en"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "free" in detail and "script" in detail
    assert db.list_sessions() == []


def test_a_matching_mode_still_starts(client):
    """The guard above must reject only the mismatch, not the ordinary case --
    both directions, since script and free take different code paths after it."""
    assert client.post("/api/sessions", json={"language": "en", "mode": "script",
                                              "scenario_id": "standup-meeting-en"}
                       ).status_code == 200
    assert client.post("/api/sessions", json={"language": "en", "mode": "free",
                                              "scenario_id": "airport-checkin-en"}
                       ).status_code == 200


def test_lesson_session_response_has_no_goal(client):
    """Lesson mode has no scenario to draw a goal from -- the frontend falls
    back to the learner's own typed topic instead."""
    body = client.post("/api/sessions", json={"language": "ja", "mode": "lesson",
                                              "topic": "て form"}).json()
    assert body.get("goal") is None


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


# A real learner's session: browser speech recognition returns no punctuation,
# so the model "corrects" a perfectly correct sentence by adding commas and a
# period. Comparing what was said against `fixed` after static/js/match.js's
# normalize()-equivalent shows the words never changed -- these pairs must
# not be recorded as the learner's mistake. static/js/match.js's own
# normalize() is exercised by tests/test_text_match.py; these are the exact
# strings from that learner's stored data.
PUNCTUATION_ONLY_PAIRS = [
    ("I finished the login bug and started on the report screen",
     "I finished the login bug and started on the report screen."),
    ("Yeah give me a sec okay I'm ready",
     "Yeah, give me a sec, okay? I'm ready."),
    ("Card please", "Card, please."),
    ("i went there", "I went there."),  # casing only
]

# Genuinely different corrections from the same learner's data -- these must
# keep counting as mistakes.
GENUINELY_DIFFERENT_PAIRS = [
    ("Will do thanks", "I will do it, thanks."),
    ("Not really I might need a review on the pool recastulator",
     "Not really, I might need a review of the pool recirculator."),
]


def test_chat_neutralizes_punctuation_only_corrections(client, monkeypatch):
    """The words never changed -- only punctuation and casing did. That is an
    artifact of browser speech recognition (which returns neither), not the
    learner's mistake, so it must not be stored as one."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    for spoken, fixed in PUNCTUATION_ONLY_PAIRS:
        def fake_chat_json(messages, schema, fixed=fixed, **kw):
            return {"ok": False, "fixed": fixed, "tag": "어순",
                    "correction": "어순이 잘못되었습니다.", "suggestion": "이렇게도 말할 수 있어요."}
        monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

        body = client.post("/api/chat", json={"session_id": sid, "text": spoken}).json()
        assert body["ok"] is True, (spoken, fixed, body)
        assert body["fixed"] is None, (spoken, fixed)
        assert body["tag"] is None, (spoken, fixed)
        assert body["correction"] is None, (spoken, fixed)
        # suggestion is not a correction -- it's "a native speaker might also
        # say it this way", worth keeping even when the sentence was fine.
        assert body["suggestion"] == "이렇게도 말할 수 있어요."


def test_chat_neutralizes_a_punctuation_only_japanese_correction(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "ja", "mode": "lesson",
                                              "topic": "greetings"}).json()["session_id"]

    def fake_chat_json(messages, schema, **kw):
        return {"ok": False, "fixed": "おはようございます。", "tag": "활용",
                "correction": "활용이 잘못되었습니다.", "suggestion": "제안"}
    monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

    body = client.post("/api/chat", json={"session_id": sid, "text": "おはようございます"}).json()
    assert body["ok"] is True
    assert body["fixed"] is None
    assert body["tag"] is None
    assert body["correction"] is None


def test_chat_does_not_neutralize_a_genuinely_different_correction(client, monkeypatch):
    """The guard above must not swallow real mistakes -- only ones that
    normalize to the same text."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    for spoken, fixed in GENUINELY_DIFFERENT_PAIRS:
        def fake_chat_json(messages, schema, fixed=fixed, **kw):
            return {"ok": False, "fixed": fixed, "tag": "어순",
                    "correction": "어순이 잘못되었습니다.", "suggestion": "제안"}
        monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

        body = client.post("/api/chat", json={"session_id": sid, "text": spoken}).json()
        assert body["ok"] is False, (spoken, fixed)
        assert body["fixed"] == fixed, (spoken, fixed)
        assert body["tag"] == "어순", (spoken, fixed)
        assert body["correction"] == "어순이 잘못되었습니다.", (spoken, fixed)


def test_chat_does_not_neutralize_when_fixed_is_none(client, monkeypatch):
    """Nothing to compare against -- leave ok=False alone rather than treat a
    missing `fixed` as a match."""
    def fake_chat_json(messages, schema, **kw):
        return {"ok": False, "fixed": None, "tag": "어순",
                "correction": "어순이 잘못되었습니다.", "suggestion": None}
    monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "Card please"}).json()
    assert body["ok"] is False
    assert body["fixed"] is None
    assert body["tag"] == "어순"
    assert body["correction"] == "어순이 잘못되었습니다."


def test_chat_leaves_an_ok_true_response_untouched(client, monkeypatch):
    def fake_chat_json(messages, schema, **kw):
        return {"ok": True, "fixed": None, "tag": "없음",
                "correction": None, "suggestion": "제안"}
    monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "Card, please."}).json()
    assert body["ok"] is True
    assert body["tag"] == "없음"
    assert body["suggestion"] == "제안"


def test_chat_survives_a_non_string_fixed_value(client, monkeypatch):
    """The schema makes this unlikely, but if a model hiccup ever yields a
    non-string `fixed`, normalize(fixed) must not be allowed to raise into
    _feedback's outer except and discard a tag/correction the model actually
    gave. A non-string `fixed` should just skip neutralisation -- the
    optimisation fails, not the whole turn's feedback."""
    def fake_chat_json(messages, schema, **kw):
        return {"ok": False, "fixed": 42, "tag": "시제",
                "correction": "설명", "suggestion": "제안"}
    monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there."}).json()
    assert body["ok"] is False
    assert body["tag"] == "시제"
    assert body["correction"] == "설명"
    assert body["suggestion"] == "제안"


def test_chat_stores_a_neutralized_punctuation_only_correction_correctly(client, monkeypatch):
    """The point of this fix is what lands in the database, not just the HTTP
    response -- ok/tag/correction feed home_stats, the top_tag recommendation,
    and the end-of-session report. A test that only checks the response body
    would miss a bug where the route neutralizes the reply but still stores
    the model's original ok=0."""
    def fake_chat_json(messages, schema, **kw):
        return {"ok": False,
                "fixed": "I finished the login bug and started on the report screen.",
                "tag": "어순", "correction": "어순이 잘못되었습니다.", "suggestion": None}
    monkeypatch.setattr("app.api.llm.chat_json", fake_chat_json)

    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={
        "session_id": sid,
        "text": "I finished the login bug and started on the report screen",
    })

    stored = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    assert stored["ok"] == 1
    assert stored["tag"] is None
    assert stored["correction"] is None


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


def test_undo_last_turn_deletes_the_recording_from_disk(client):
    """Undo is used exactly when recognition mishears, which is often -- if
    the file survives, a normal session leaves permanently orphaned
    recordings on disk, the one outcome the learner traded recordings away
    to avoid."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    client.post(f"/api/sessions/{sid}/audio", data={"message_id": msg["id"]},
                files={"file": ("clip.webm", io.BytesIO(b"bytes"), "audio/webm")})
    stored_path = config.AUDIO_DIR / f"s{sid}_m{msg['id']}.webm"
    assert stored_path.exists()

    client.delete(f"/api/sessions/{sid}/last-turn")

    assert not stored_path.exists()


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


def test_uploaded_recording_can_be_played_back(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")

    client.post(f"/api/sessions/{sid}/audio",
                data={"message_id": msg["id"]},
                files={"file": ("clip.webm", io.BytesIO(b"webm-bytes"), "audio/webm")})

    r = client.get(f"/api/messages/{msg['id']}/audio")
    assert r.status_code == 200
    assert r.content == b"webm-bytes"
    assert r.headers["content-type"].startswith("audio/webm")


def test_playback_is_404_when_nothing_was_recorded(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    assert client.get(f"/api/messages/{msg['id']}/audio").status_code == 404


def test_upload_recording_after_session_ended_is_rejected(client):
    """/end runs _forget_recordings synchronously, and a slow sendText already
    in flight when /end lands keeps going -- awaiting uploadPendingRecording
    after the reply. Without this guard that upload writes the file and sets
    audio_path *after* the sweep already ran, and nothing ever collects it:
    the sweep skips ended sessions and a second /end 409s. Matches /chat and
    /last-turn, which already reject an ended session this way."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    client.post(f"/api/sessions/{sid}/end")

    r = client.post(f"/api/sessions/{sid}/audio", data={"message_id": msg["id"]},
                    files={"file": ("clip.webm", io.BytesIO(b"bytes"), "audio/webm")})
    assert r.status_code == 409


def test_ending_a_session_removes_its_recordings(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    client.post(f"/api/sessions/{sid}/audio", data={"message_id": msg["id"]},
                files={"file": ("clip.webm", io.BytesIO(b"bytes"), "audio/webm")})
    assert client.get(f"/api/messages/{msg['id']}/audio").status_code == 200

    client.post(f"/api/sessions/{sid}/end")

    assert client.get(f"/api/messages/{msg['id']}/audio").status_code == 404
    assert next(m for m in db.get_messages(sid) if m["speaker"] == "user")["audio_path"] is None


def test_resumable_is_not_swallowed_by_the_session_id_route(client):
    assert client.get("/api/sessions/resumable?language=en").status_code == 200


def test_resumable_reports_the_scenarios_goal(client):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(sid, "user", "hi")
    r = client.get("/api/sessions/resumable?language=en")
    assert r.json()["session"]["goal"] == "체크인하고 좌석을 배정받는다"


def test_resumable_goal_is_none_without_a_scenario(client):
    sid = db.create_session("en", "free")
    db.add_message(sid, "user", "hi")
    r = client.get("/api/sessions/resumable?language=en")
    assert r.json()["session"]["goal"] is None


def test_a_session_started_and_abandoned_through_the_route_is_not_offered(client):
    """Pressing 시작 and closing the tab. POST /sessions writes the bot's
    opening line before it returns, so this session already has a message --
    which is why resumable_session filters on a *learner* message rather than
    on any message at all. Built through the real route on purpose: the
    equivalent db-level test constructs its fixture with create_session, which
    never writes that opening line, so it would pass either way."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    assert db.get_messages(sid)                      # the bot's opening is there
    assert db.resumable_session("en") is None
    assert client.get("/api/sessions/resumable?language=en").json()["session"] is None

    # ...and once the learner actually says something, it is worth resuming.
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    assert client.get("/api/sessions/resumable?language=en").json()["session"]["id"] == sid


def test_resumable_sweep_deletes_a_stale_sessions_recording_before_closing_it(client):
    """db.abandon_stale_sessions stamps ended_at on a strict superset of what
    db.stale_open_sessions finds (same cutoff, minus the audio restriction).
    Once ended_at is stamped, stale_open_sessions' `ended_at IS NULL` filter
    can never see that session again -- so GET /sessions/resumable must sweep
    the recording off disk *before* closing the session, or the file is
    orphaned forever. This project deletes a session's recordings once it is
    over; a session closed with its audio still on disk breaks that."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")

    clip = config.AUDIO_DIR / f"s{sid}_m{msg['id']}.webm"
    clip.write_bytes(b"stale-bytes")
    db.set_message_audio(msg["id"], f"audio/{clip.name}")

    with db.connect() as conn:
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE session_id = ?", (sid,))
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (sid,))

    r = client.get("/api/sessions/resumable?language=en")
    assert r.status_code == 200

    assert db.get_session(sid)["ended_at"] is not None
    assert not clip.exists()
