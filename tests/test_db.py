import pytest

from app import db


@pytest.fixture()
def store(tmp_path, monkeypatch):
    path = tmp_path / "test.db"
    monkeypatch.setattr(db.config, "DB_PATH", path)
    db.init_db()
    return db


def test_create_session_returns_id_and_roundtrips(store):
    sid = store.create_session("en", "free", scenario_id="airport-checkin-en")
    row = store.get_session(sid)
    assert row["language"] == "en"
    assert row["mode"] == "free"
    assert row["scenario_id"] == "airport-checkin-en"
    assert row["started_at"] is not None
    assert row["ended_at"] is None
    assert row["report"] is None


def test_lesson_session_stores_topic_and_null_scenario(store):
    sid = store.create_session("ja", "lesson", topic="て form")
    row = store.get_session(sid)
    assert row["scenario_id"] is None
    assert row["topic"] == "て form"


def test_messages_keep_insertion_order_and_feedback(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Hi there!")
    store.add_message(
        sid, "user", "I go to store yesterday",
        correction="Use the past tense: I went to the store yesterday.",
        suggestion="More natural: I hit the store yesterday.",
    )
    msgs = store.get_messages(sid)
    assert [m["speaker"] for m in msgs] == ["bot", "user"]
    assert [m["turn"] for m in msgs] == [1, 2]
    assert msgs[1]["correction"].startswith("Use the past tense")
    assert msgs[0]["correction"] is None


def test_turn_numbering_increments_sequentially(store):
    """Verify turn numbering continues to increment correctly (1, 2, 3, ...)."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "First")
    store.add_message(sid, "user", "Second")
    store.add_message(sid, "bot", "Third")
    msgs = store.get_messages(sid)
    assert [m["turn"] for m in msgs] == [1, 2, 3]
    assert [m["text"] for m in msgs] == ["First", "Second", "Third"]


def test_turn_numbering_is_independent_per_session(store):
    """Verify turn numbering restarts per session (not global)."""
    sid1 = store.create_session("en", "free")
    sid2 = store.create_session("en", "free")

    # Add to first session
    store.add_message(sid1, "bot", "Session 1 msg 1")
    store.add_message(sid1, "user", "Session 1 msg 2")

    # Add to second session
    store.add_message(sid2, "bot", "Session 2 msg 1")

    # Add more to first session
    store.add_message(sid1, "bot", "Session 1 msg 3")

    # Add more to second session
    store.add_message(sid2, "user", "Session 2 msg 2")

    msgs1 = store.get_messages(sid1)
    msgs2 = store.get_messages(sid2)

    # Each session should have turns starting at 1
    assert [m["turn"] for m in msgs1] == [1, 2, 3]
    assert [m["turn"] for m in msgs2] == [1, 2]


def test_set_message_audio_attaches_path(store):
    sid = store.create_session("en", "free")
    mid = store.add_message(sid, "user", "Hello")
    store.set_message_audio(mid, "audio/1.webm")
    assert store.get_messages(sid)[0]["audio_path"] == "audio/1.webm"


def test_end_session_records_report_and_level(store):
    sid = store.create_session("en", "free")
    store.end_session(sid, "You did well.", "intermediate")
    row = store.get_session(sid)
    assert row["report"] == "You did well."
    assert row["level"] == "intermediate"
    assert row["ended_at"] is not None


def test_latest_level_defaults_to_beginner_then_follows_last_ended_session(store):
    assert store.latest_level("en") == "beginner"
    first = store.create_session("en", "free")
    store.end_session(first, "r", "intermediate")
    assert store.latest_level("en") == "intermediate"
    second = store.create_session("en", "lesson")
    store.end_session(second, "r", "advanced")
    assert store.latest_level("en") == "advanced"


def test_latest_level_is_scoped_per_language(store):
    sid = store.create_session("en", "free")
    store.end_session(sid, "r", "advanced")
    assert store.latest_level("ja") == "beginner"


def test_unfinished_sessions_do_not_affect_latest_level(store):
    done = store.create_session("en", "free")
    store.end_session(done, "r", "advanced")
    store.create_session("en", "free")  # still open, level is NULL
    assert store.latest_level("en") == "advanced"


def test_settings_get_set_and_default(store):
    assert store.get_setting("voice_en") is None
    assert store.get_setting("voice_en", "am_adam") == "am_adam"
    store.set_setting("voice_en", "af_kore")
    assert store.get_setting("voice_en") == "af_kore"
    store.set_setting("voice_en", "am_fenrir")
    assert store.get_setting("voice_en") == "am_fenrir"


def test_list_sessions_returns_newest_first(store):
    a = store.create_session("en", "free")
    b = store.create_session("ja", "lesson")
    ids = [s["id"] for s in store.list_sessions()]
    assert ids == [b, a]


def test_wal_mode_is_enabled(store):
    with store.connect() as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"
