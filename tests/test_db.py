import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from app import db


def _local_stamp(local_date, hour, minute=0):
    """A UTC ISO timestamp, in the same format db._now() writes, for a given
    wall-clock time on `local_date` in this machine's real local timezone.

    Built from the OS's actual UTC offset (not a hardcoded +9) so the test
    stays correct under whatever timezone the machine is set to -- which is
    also what home_stats' SQL ('localtime') and Python (datetime.now()) both
    read from, so this helper and the implementation always agree.
    """
    local_dt = datetime(local_date.year, local_date.month, local_date.day, hour, minute)
    offset = datetime.now().astimezone().utcoffset()
    return (local_dt - offset).replace(tzinfo=timezone.utc).isoformat(timespec="seconds")


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


def _finished(store, language, level):
    sid = store.create_session(language, "free")
    store.end_session(sid, "r", level)
    return sid


def test_stable_level_needs_a_minimum_sample(store):
    """A single session of a few sentences cannot support a verdict. The real
    database showed four consecutive one-turn sessions on the same scenario
    recorded beginner, intermediate, intermediate, beginner."""
    _finished(store, "en", "advanced")
    _finished(store, "en", "advanced")
    assert store.stable_level("en") is None


def test_stable_level_is_the_mode_of_recent_sessions(store):
    for level in ["beginner", "intermediate", "beginner", "beginner"]:
        _finished(store, "en", level)
    assert store.stable_level("en") == "beginner"


def test_stable_level_only_looks_at_the_recent_window(store):
    for level in ["beginner", "beginner", "beginner"]:
        _finished(store, "en", level)
    for level in ["advanced", "advanced", "advanced", "advanced", "advanced"]:
        _finished(store, "en", level)
    assert store.stable_level("en", recent=5) == "advanced"


def test_stable_level_ignores_the_other_language(store):
    for level in ["advanced", "advanced", "advanced"]:
        _finished(store, "ja", level)
    assert store.stable_level("en") is None


def test_stable_level_breaks_a_three_way_tie_toward_the_most_recent(store):
    """min_sessions=3 with three distinct levels is the smallest sample where a
    tie is unavoidable. The mode can't pick a winner, so the most recent of the
    tied levels does."""
    for level in ["beginner", "intermediate", "advanced"]:
        _finished(store, "en", level)
    assert store.stable_level("en") == "advanced"


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


def test_resumable_session_offers_only_the_most_recent_unfinished_one(store):
    old = store.create_session("en", "free", scenario_id="airport-checkin-en")
    store.add_message(old, "user", "hi")
    new = store.create_session("en", "free", scenario_id="restaurant-seating-en")
    store.add_message(new, "user", "hello")
    assert store.resumable_session("en")["id"] == new


def test_a_finished_session_is_not_resumable(store):
    sid = store.create_session("en", "free")
    store.end_session(sid, "r", "beginner")
    assert store.resumable_session("en") is None


def test_a_session_with_no_messages_is_not_worth_resuming(store):
    """A session row with no messages at all. There is nothing to come back to.

    Not what "pressing 시작 and closing the tab" leaves behind, which is what
    this docstring used to say: POST /sessions writes the bot's opening line
    before it returns, so that gesture always leaves a session with one
    message -- see test_a_session_started_and_abandoned_through_the_route
    _is_not_offered (tests/test_api_chat.py:483), which covers that production
    shape and is why resumable_session filters on a *learner* message.

    What does still produce this row: app/api.py calls llm.chat for the opening
    line with no guard before db.add_message, so an Ollama failure 500s to the
    client with the session row already written and empty. Confirmed by making
    llm.chat raise -- the route returns 500 and leaves session 1 holding zero
    messages."""
    store.create_session("en", "free")
    assert store.resumable_session("en") is None


def test_a_script_mode_session_is_not_resumable(store):
    """scriptIndex lives only in the browser and is never persisted, so the
    app has no way to place the learner back where they left off. Everything
    else about this session satisfies resumable_session's other filters --
    unfinished, has messages, within the window -- so only the mode
    exclusion can be what keeps it out."""
    sid = store.create_session("en", "script", scenario_id="standup-en")
    store.add_message(sid, "user", "hi")
    assert store.resumable_session("en") is None


def test_abandon_stale_sessions_closes_them_and_they_stop_being_offered(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "hi")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = '2020-01-01T00:00:00+00:00'")
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00'")
    assert store.abandon_stale_sessions(hours=24) == 1
    assert store.resumable_session("en") is None
    assert store.get_session(sid)["ended_at"] is not None


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


def test_home_stats_counts_this_weeks_turns_and_total_fixes(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "a", ok=False, fixed="A", tag="시제")
    store.add_message(sid, "user", "b", ok=True, tag="없음")
    store.add_message(sid, "bot", "reply")
    stats = store.home_stats("en")
    assert stats["week_turns"] == 2      # bot lines are not the learner speaking
    assert stats["fixed_total"] == 1


def test_home_stats_has_no_top_tag_before_there_is_evidence(store):
    """A weakness ranked off one or two mistakes is a guess dressed as a fact."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "a", ok=False, fixed="A", tag="시제")
    assert store.home_stats("en")["top_tag"] is None


def test_home_stats_reports_a_tag_once_it_has_appeared_three_times(store):
    sid = store.create_session("en", "free")
    for text in ("a", "b", "c"):
        store.add_message(sid, "user", text, ok=False, fixed=text.upper(), tag="시제")
    assert store.home_stats("en")["top_tag"] == "시제"


def test_home_stats_streak_counts_consecutive_days_ending_today(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "today")
    assert store.home_stats("en")["streak"] == 1


def test_home_stats_streak_survives_an_unfinished_today_if_yesterday_was_practised(store):
    """A ten-day streak must not read as zero just because the learner has not
    spoken yet today -- that number sits on the screen where they decide
    whether to practise at all, so it has to survive an unfinished day."""
    sid = store.create_session("en", "free")
    yesterday = datetime.now().date() - timedelta(days=1)
    mid = store.add_message(sid, "user", "yesterday")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = ? WHERE id = ?",
                     (_local_stamp(yesterday, 12), mid))
    assert store.home_stats("en")["streak"] == 1


def test_home_stats_streak_is_zero_when_last_practice_was_two_days_ago(store):
    sid = store.create_session("en", "free")
    two_days_ago = datetime.now().date() - timedelta(days=2)
    mid = store.add_message(sid, "user", "old")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = ? WHERE id = ?",
                     (_local_stamp(two_days_ago, 12), mid))
    assert store.home_stats("en")["streak"] == 0


def test_home_stats_streak_counts_a_consecutive_run_ending_yesterday(store):
    sid = store.create_session("en", "free")
    today = datetime.now().date()
    for days_back in (1, 2, 3):
        mid = store.add_message(sid, "user", f"day-{days_back}")
        with store.connect() as conn:
            conn.execute("UPDATE messages SET created_at = ? WHERE id = ?",
                         (_local_stamp(today - timedelta(days=days_back), 12), mid))
    assert store.home_stats("en")["streak"] == 3


def test_home_stats_streak_counts_one_korean_day_across_a_utc_midnight(store):
    """One practice day that straddles UTC midnight (e.g. 00:30 and 23:30 KST,
    which fall on two different UTC calendar dates) must count as a single
    streak day, not two -- otherwise the streak snaps or inflates at 9am KST
    every day, since that is UTC midnight."""
    sid = store.create_session("en", "free")
    today = datetime.now().date()
    early = store.add_message(sid, "user", "early")
    late = store.add_message(sid, "user", "late")
    with store.connect() as conn:
        conn.execute("UPDATE messages SET created_at = ? WHERE id = ?",
                     (_local_stamp(today, 0, 30), early))
        conn.execute("UPDATE messages SET created_at = ? WHERE id = ?",
                     (_local_stamp(today, 23, 30), late))
    assert store.home_stats("en")["streak"] == 1


FREE_SCENARIO = {
    "id": "user-interview-1", "language": "en", "type": "free",
    "title": "구직 면접", "goal": "경력을 설명하고 질문에 답한다",
    "persona_prompt": "You are a hiring manager.", "max_turns": 8,
}


def test_user_scenario_round_trips_in_the_catalogue_shape(store):
    store.add_user_scenario(FREE_SCENARIO)
    got = store.get_user_scenario("user-interview-1")
    assert got == {**FREE_SCENARIO, "lines": None}


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


def test_a_stored_scenario_reads_back_in_the_catalogue_shape(store):
    """A generated scenario must be indistinguishable from a built-in one --
    data/scenarios.json entries carry no used_count, and nothing counts uses,
    so neither does this."""
    store.add_user_scenario(FREE_SCENARIO)
    assert "used_count" not in store.get_user_scenario("user-interview-1")
