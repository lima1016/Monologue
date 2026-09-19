"""기록 지우기: 한 언어(또는 둘 다)의 학습 기록만 지우고, 앱이 쓰는 건 남긴다."""
import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import api, config, db, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    monkeypatch.setattr(api, "_today", lambda: date.today())
    return TestClient(app)


REPORT = json.dumps({"summary": "좋았어요", "weak_points": [], "expressions": [], "next_focus": "x"},
                    ensure_ascii=False)


def _clip(name):
    config.AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    path = config.AUDIO_DIR / name
    path.write_bytes(b"webm")
    return path


def _seed(language):
    """One of everything the learner leaves behind in `language`. Returns the
    recording files so a test can check which survive."""
    files = []
    # A finished free session with a corrected turn (a review card) and a clip.
    sid = db.create_session(language, "free", scenario_id=f"airport-checkin-{language}")
    mid = db.add_message(sid, "user", "I go", correction="설명", ok=0, fixed="I went.", tag="시제")
    db.add_message(sid, "bot", "reply")
    files.append(_clip(f"s{sid}_m{mid}.webm"))
    db.set_message_audio(mid, f"audio/s{sid}_m{mid}.webm")
    db.enqueue_review(mid, language, date.today())
    db.end_session(sid, REPORT, "beginner")
    # An open session nobody finished, with a clip the column never recorded.
    open_sid = db.create_session(language, "free", scenario_id=f"airport-checkin-{language}")
    db.add_message(open_sid, "user", "hello", ok=1)
    files.append(_clip(f"s{open_sid}_m999.webm"))
    # Shadowing.
    sh = db.create_session(language, "script", scenario_id=f"lib-hotel-{language}-01", shadowing=True)
    db.save_shadow_line(sh, 0, "said", "target", True, False)
    db.end_session(sh, REPORT, None)
    # 1분 말하기 with two recorded rounds.
    t = db.create_session(language, "timed", topic="weekend")
    for n in (1, 2):
        files.append(_clip(f"s{t}_r{n}.webm"))
        db.add_round(t, n, 60.0, 80, 1, ["One.", "Two."], f"audio/s{t}_r{n}.webm")
    db.add_message(t, "user", "One.", ok=1)
    db.end_session(t, REPORT, "beginner")
    # Coach note and a finished level test (plus one left unfinished).
    db.save_coach(language, date.today().isoformat(), [{"habit": "h"}])
    test_id = db.create_level_test(language)
    db.finish_level_test(test_id, {"cefr": "B1"}, "intermediate")
    db.create_level_test(language)
    return files


def _keep_seed():
    db.add_library_scenario({"id": "lib-hotel-en-01", "theme_id": "hotel", "situation": "체크인",
                             "language": "en", "type": "script", "title": "Hotel",
                             "lines": [{"speaker": "bot", "text": "Hi"}]})
    db.add_library_scenario({"id": "lib-hotel-ja-01", "theme_id": "hotel", "situation": "체크인",
                             "language": "ja", "type": "script", "title": "ホテル",
                             "lines": [{"speaker": "bot", "text": "こんにちは"}]})
    db.add_user_scenario({"id": "user-en-1", "language": "en", "type": "free", "title": "Mine",
                          "goal": "g", "persona_prompt": "p", "max_turns": 8})
    db.set_setting("voice_en", "af_heart")
    db.set_setting("voice_ja", "8")
    db.set_setting("weekly_goal", "7")


def _count(table, language=None):
    with db.connect() as conn:
        if language is None:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        return conn.execute(f"SELECT COUNT(*) FROM {table} WHERE language = ?", (language,)).fetchone()[0]


def _messages(language):
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM messages m JOIN sessions s ON s.id = m.session_id"
                            " WHERE s.language = ?", (language,)).fetchone()[0]


def _rounds(language):
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM timed_rounds r JOIN sessions s ON s.id = r.session_id"
                            " WHERE s.language = ?", (language,)).fetchone()[0]


EXPECTED = {"sessions": 4, "reports": 3, "reviews": 1, "timed_rounds": 2, "level_tests": 2,
            "coach_notes": 1, "recordings": 4}


def test_summary_counts_each_kind_for_one_language(client):
    _seed("en")
    _seed("ja")
    _seed("ja")
    body = client.get("/api/history/summary?language=en").json()
    assert body == {"language": "en", "counts": EXPECTED}


def test_summary_for_both_adds_the_languages_up(client):
    _seed("en")
    _seed("ja")
    counts = client.get("/api/history/summary?language=all").json()["counts"]
    # coach_notes is one row per language, so two.
    assert counts == {k: v * 2 for k, v in EXPECTED.items()}


def test_summary_of_nothing_is_all_zero(client):
    counts = client.get("/api/history/summary?language=ja").json()["counts"]
    assert set(counts) == set(EXPECTED) and not any(counts.values())


def test_resetting_english_leaves_japanese_and_the_app_alone(client):
    _keep_seed()
    en_files = _seed("en")
    ja_files = _seed("ja")
    before_ja = client.get("/api/history/summary?language=ja").json()["counts"]

    r = client.post("/api/history/reset", json={"language": "en"})
    assert r.status_code == 200
    assert r.json() == {"language": "en", "deleted": EXPECTED}

    for table in ("sessions", "review_queue", "coach_notes", "level_tests"):
        assert _count(table, "en") == 0, table
    assert _messages("en") == 0 and _rounds("en") == 0
    assert not any(p.exists() for p in en_files)

    assert client.get("/api/history/summary?language=ja").json()["counts"] == before_ja
    assert _messages("ja") > 0 and _rounds("ja") == 2
    assert all(p.exists() for p in ja_files)

    assert _count("library_scenarios") == 2
    assert _count("user_scenarios") == 1
    assert (db.get_setting("voice_en"), db.get_setting("voice_ja"), db.get_setting("weekly_goal")) \
        == ("af_heart", "8", "7")


def test_after_reset_every_screen_reads_empty_for_that_language(client):
    _seed("en")
    client.post("/api/history/reset", json={"language": "en"})
    home = client.get("/api/stats/home?language=en").json()
    assert home["streak"] == 0 and home["week_turns"] == 0 and home["fixed_total"] == 0
    assert home["recent"] == [] and home["has_history"] is False and home["recent_themes"] == []
    assert home["review"] == {"due": 0, "first": None}
    mypage = client.get("/api/stats/mypage?language=en").json()
    assert mypage["level"]["value"] is None and mypage["level"]["test"] is None
    assert mypage["level"]["sessions"] == 0 and mypage["level"]["utterances"] == 0
    assert mypage["accuracy"] == {"correct": 0, "graded": 0}
    assert mypage["tags"] == [] and mypage["review"] == {"due": 0, "mastered": 0, "total": 0}
    growth = client.get("/api/stats/growth?language=en").json()
    assert growth["streak"] == 0 and growth["longest"] == 0 and growth["minutes"] == 0
    assert all(c["turns"] == 0 for c in growth["calendar"])
    assert all(w["graded"] == 0 for w in growth["accuracy"])
    assert growth["level_tests"] == [] and growth["timed"] == []
    assert client.get("/api/sessions/history?language=en").json()["items"] == []
    assert client.get("/api/review?language=en").json()["items"] == []
    assert client.get("/api/level-test/latest?language=en").json()["result"] is None


def test_resetting_both_clears_both(client):
    _keep_seed()
    files = _seed("en") + _seed("ja")
    r = client.post("/api/history/reset", json={"language": "all"})
    assert r.json()["deleted"] == {k: v * 2 for k, v in EXPECTED.items()}
    for table in ("sessions", "messages", "timed_rounds", "review_queue", "coach_notes", "level_tests"):
        assert _count(table) == 0, table
    assert not any(p.exists() for p in files)
    assert _count("library_scenarios") == 2 and _count("user_scenarios") == 1


def test_other_files_in_the_audio_folder_are_left_alone(client):
    _seed("en")
    ja_sid = db.create_session("ja", "free")
    stranger = _clip("notes.txt")
    other = _clip(f"s{ja_sid}_m1.webm")
    client.post("/api/history/reset", json={"language": "en"})
    assert stranger.exists() and other.exists()


def test_reset_drops_cached_suggestions_and_questions(client, monkeypatch):
    cleared = []
    monkeypatch.setattr(api._cached_suggestions, "cache_clear", lambda: cleared.append("suggest"))
    monkeypatch.setattr(api._cached_timed_questions, "cache_clear", lambda: cleared.append("timed"))
    client.post("/api/history/reset", json={"language": "en"})
    assert sorted(cleared) == ["suggest", "timed"]


@pytest.mark.parametrize("language", ["", "EN", "fr", "both", None])
def test_a_language_outside_en_ja_all_is_refused(client, language):
    _seed("en")
    assert client.post("/api/history/reset", json={"language": language}).status_code == 422
    assert client.post("/api/history/reset", json={}).status_code == 422
    assert client.get(f"/api/history/summary?language={language or ''}").status_code == 422
    assert _count("sessions", "en") == 4


def test_a_failure_midway_deletes_nothing(client, monkeypatch):
    """One transaction: if a later DELETE fails, the earlier ones roll back."""
    files = _seed("en")
    real = db._RESET_STATEMENTS
    monkeypatch.setattr(db, "_RESET_STATEMENTS", real[:2] + ("DELETE FROM no_such_table WHERE language IN ({marks})",) + real[2:])
    with pytest.raises(Exception):
        TestClient(app, raise_server_exceptions=True).post("/api/history/reset", json={"language": "en"})
    assert client.get("/api/history/summary?language=en").json()["counts"] == EXPECTED
    assert all(p.exists() for p in files)
