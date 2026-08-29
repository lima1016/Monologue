import sqlite3

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


def test_fresh_database_lands_on_the_latest_schema_version(store):
    assert store.schema_version() == len(store.MIGRATIONS)


def test_init_db_is_idempotent(store):
    before = store.schema_version()
    store.init_db()
    store.init_db()
    assert store.schema_version() == before


def test_a_phase1_database_is_stamped_and_then_migrated(tmp_path, monkeypatch):
    """The real monologue.db predates user_version: it sits at 0 with the v1
    schema already applied. Running migrations from 0 must not try to recreate
    what is already there, and must still add the new columns."""
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript(db.SCHEMA)          # Phase 1 schema, no user_version
    conn.execute(
        "INSERT INTO sessions (language, mode, started_at) VALUES ('en','free','t0')"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(db.config, "DB_PATH", path)
    db.init_db()

    assert db.schema_version() == len(db.MIGRATIONS)
    with db.connect() as c:
        cols = {r[1] for r in c.execute("PRAGMA table_info(messages)")}
        assert {"ok", "fixed", "tag"} <= cols
        assert c.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


def test_stamp_phase1_database_marks_existing_schema_as_v1():
    """Exercises _stamp_phase1_database directly. Deleting the stamp entirely
    would not fail the end-to-end legacy test above, because MIGRATIONS[0] is
    idempotent CREATE ... IF NOT EXISTS today — so this test checks the stamp's
    actual effect on user_version rather than an outcome that survives without it."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(db.SCHEMA)

    db._stamp_phase1_database(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1


def test_stamp_phase1_database_leaves_a_fresh_database_at_zero():
    """A brand-new database has no sessions table yet, so there is nothing to
    stamp: it must stay at 0 and go through MIGRATIONS[0] like any other new DB."""
    conn = sqlite3.connect(":memory:")

    db._stamp_phase1_database(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0


def test_add_message_persists_structured_feedback(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "I go store yesterday.",
                      correction="'go'는 과거형이 아닙니다.",
                      suggestion="'I went to the store yesterday.'라고 말하세요.",
                      ok=False, fixed="I went to the store yesterday.", tag="시제")
    row = store.get_messages(sid)[0]
    assert row["ok"] == 0
    assert row["fixed"] == "I went to the store yesterday."
    assert row["tag"] == "시제"


def test_add_message_leaves_feedback_fields_null_when_not_given(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    row = store.get_messages(sid)[0]
    assert row["ok"] is None and row["fixed"] is None and row["tag"] is None


def test_delete_last_turn_removes_the_user_line_and_its_bot_reply(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    store.add_message(sid, "user", "I go store yesterday.", ok=False, tag="시제")
    store.add_message(sid, "bot", "Nice, what did you buy?")

    assert store.delete_last_turn(sid) == (2, [])
    remaining = store.get_messages(sid)
    assert [m["speaker"] for m in remaining] == ["bot"]
    assert remaining[0]["text"] == "Good evening!"


def test_delete_last_turn_leaves_the_opening_line_alone(store):
    """With no user turn yet there is nothing to undo -- the bot's opening is
    not the learner's mistake to erase."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    assert store.delete_last_turn(sid) == (0, [])
    assert len(store.get_messages(sid)) == 1


def test_delete_last_turn_returns_the_deleted_turns_audio_paths(store):
    """Undo runs exactly when recognition mishears, which is often -- the
    caller needs these paths back to unlink the files, or a normal session
    leaves permanently orphaned recordings on disk (db.py does no file
    operations itself)."""
    sid = store.create_session("en", "free")
    mid = store.add_message(sid, "user", "I go store yesterday.")
    store.set_message_audio(mid, "audio/s1_m1.webm")
    store.add_message(sid, "bot", "Nice, what did you buy?")

    assert store.delete_last_turn(sid) == (2, ["audio/s1_m1.webm"])


def test_delete_last_turn_frees_the_turn_numbers_for_reuse(store):
    """messages has UNIQUE(session_id, turn); if delete left a gap the next
    INSERT would collide."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "first")
    store.add_message(sid, "bot", "reply")
    store.delete_last_turn(sid)
    store.add_message(sid, "user", "second")
    store.add_message(sid, "bot", "reply again")
    assert [m["text"] for m in store.get_messages(sid)] == ["second", "reply again"]


def test_clear_session_audio_nulls_the_paths_and_reports_them(store):
    sid = store.create_session("en", "free")
    mid = store.add_message(sid, "user", "hello")
    store.set_message_audio(mid, "audio/s1_m1.webm")
    assert store.clear_session_audio(sid) == ["audio/s1_m1.webm"]
    assert store.get_messages(sid)[0]["audio_path"] is None


def test_clear_session_audio_is_a_no_op_when_nothing_was_recorded(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "typed, not spoken")
    assert store.clear_session_audio(sid) == []


def test_stale_open_sessions_finds_only_old_unfinished_ones(store):
    """`fresh` and `done` must each carry a recording too, or the EXISTS
    clause alone would exclude them and this test would still pass with the
    ended_at filter and the cutoff both deleted -- it needs to be the
    ended_at filter that excludes `done` and the cutoff that excludes
    `fresh`, not the presence of a recording at all."""
    fresh = store.create_session("en", "free")
    old = store.create_session("en", "free")
    done = store.create_session("en", "free")

    fresh_mid = store.add_message(fresh, "user", "hello")
    store.set_message_audio(fresh_mid, "audio/s_fresh.webm")

    old_mid = store.add_message(old, "user", "hello")
    store.set_message_audio(old_mid, "audio/s_old.webm")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (old_mid,))
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (old,))

    done_mid = store.add_message(done, "user", "hello")
    store.set_message_audio(done_mid, "audio/s_done.webm")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (done_mid,))
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (done,))
    store.end_session(done, "report", "beginner")

    assert store.stale_open_sessions(hours=24) == [old]


def test_stale_open_sessions_ignores_sessions_already_swept(store):
    """A session whose recordings were already cleared should not be returned
    again on the next sweep -- it has nothing left to collect."""
    old = store.create_session("en", "free")
    old_mid = store.add_message(old, "user", "hello")
    store.set_message_audio(old_mid, "audio/s_old.webm")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (old_mid,))
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (old,))
    assert store.stale_open_sessions(hours=24) == [old]

    store.clear_session_audio(old)

    assert store.stale_open_sessions(hours=24) == []


def test_stale_sweep_spares_a_long_running_session_that_is_still_active(store):
    """The case the activity-based cutoff exists for: opened days ago, spoken
    into minutes ago. Keying on started_at would sweep this and delete the
    learner's recordings mid-session."""
    sid = store.create_session("en", "free")
    mid = store.add_message(sid, "user", "still going")
    store.set_message_audio(mid, "audio/s1_m1.webm")
    with store.connect() as conn:
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'"
                     " WHERE id = ?", (sid,))
    assert store.stale_open_sessions(hours=24) == []


def test_session_stats_counts_only_the_learners_wrong_turns(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    store.add_message(sid, "user", "I go store yesterday.", ok=False,
                      fixed="I went to the store yesterday.", tag="시제")
    store.add_message(sid, "user", "She have two cat.", ok=False,
                      fixed="She has two cats.", tag="단복수")
    store.add_message(sid, "user", "My father is a doctor.", ok=True,
                      fixed="My father is a doctor.", tag="없음")

    stats = store.session_stats(sid)
    assert stats["turns"] == 3
    assert stats["wrong"] == 2
    assert stats["tags"] == {"시제": 1, "단복수": 1}
    assert [s["fixed"] for s in stats["sentences"]] == [
        "I went to the store yesterday.", "She has two cats."]


def test_session_stats_ignores_turns_that_never_got_feedback(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "no feedback was obtained")
    stats = store.session_stats(sid)
    assert stats["turns"] == 1 and stats["wrong"] == 0 and stats["tags"] == {}
    assert stats["ungraded"] == 1


def test_session_stats_counts_ungraded_separately_from_wrong(store):
    """The property the report screen depends on: a turn whose grading call
    failed (ok is NULL) must not silently disappear into `wrong == 0`, or a
    session where every grading call failed reads as flawless."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "no feedback was obtained")
    store.add_message(sid, "user", "I go store yesterday.", ok=False,
                      fixed="I went to the store yesterday.", tag="시제")
    store.add_message(sid, "user", "My father is a doctor.", ok=True,
                      fixed="My father is a doctor.", tag="없음")

    stats = store.session_stats(sid)
    assert stats["turns"] == 3
    assert stats["wrong"] == 1
    assert stats["ungraded"] == 1


FREE_SCENARIO = {
    "id": "user-interview-1", "language": "en", "type": "free",
    "title": "구직 면접", "goal": "경력을 설명하고 질문에 답한다",
    "persona_prompt": "You are a hiring manager.", "max_turns": 8,
}


def test_user_scenario_round_trips_in_the_catalogue_shape(store):
    store.add_user_scenario(FREE_SCENARIO)
    got = store.get_user_scenario("user-interview-1")
    assert got == {**FREE_SCENARIO, "lines": None, "used_count": 0}


def test_user_scenarios_are_filtered_by_language_and_kind(store):
    store.add_user_scenario(FREE_SCENARIO)
    store.add_user_scenario({**FREE_SCENARIO, "id": "user-ja-1", "language": "ja"})
    assert [s["id"] for s in store.user_scenarios("en")] == ["user-interview-1"]
    assert [s["id"] for s in store.user_scenarios("en", "script")] == []


def test_script_scenario_round_trips_its_lines(store):
    script = {"id": "user-standup-1", "language": "en", "type": "script",
              "title": "스탠드업", "goal": None,
              "lines": [{"speaker": "bot", "text": "Morning!"},
                        {"speaker": "user", "text": "Morning."}]}
    store.add_user_scenario(script)
    assert store.get_user_scenario("user-standup-1")["lines"] == script["lines"]


def test_touch_counts_uses(store):
    store.add_user_scenario(FREE_SCENARIO)
    store.touch_user_scenario("user-interview-1")
    store.touch_user_scenario("user-interview-1")
    assert store.get_user_scenario("user-interview-1")["used_count"] == 2
