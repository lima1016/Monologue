"""/stats/home's 오늘의 목표 문장 (`target`) and 정확도 (`accuracy`), added for
the desktop home (docs/superpowers/specs/2026-09-19-monologue-desktop-layout-design.md)."""
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
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 14))
    return TestClient(app)


def _say(turns, mode="free"):
    sid = db.create_session("en", mode, scenario_id="airport-checkin-en")
    ids = []
    for text, ok, fixed, tag in turns:
        ids.append(db.add_message(sid, "user", text, correction="설명", ok=ok, fixed=fixed, tag=tag))
        db.add_message(sid, "bot", "reply")
    db.end_session(sid, json.dumps({"summary": "x", "weak_points": [], "expressions": [], "next_focus": "x"}),
                   "beginner")
    return ids


def _home(client):
    return client.get("/api/stats/home", params={"language": "en"}).json()


def test_no_target_until_a_tag_has_come_up_three_times(client):
    _say([("I go", 0, "I went.", "시제"), ("I goed", 0, "I went.", "시제")])
    assert _home(client)["target"] is None


def test_target_is_the_newest_wrong_sentence_of_the_top_tag(client, monkeypatch):
    stamps = iter(f"2026-09-14T00:00:{s:02d}+00:00" for s in range(60))
    monkeypatch.setattr(db, "_now", lambda: next(stamps))
    ids = _say([("I go there", 0, "I went there.", "시제"),
                ("She have", 0, "She has.", "단복수"),
                ("I eat yesterday", 0, "I ate yesterday.", "시제"),
                ("I buy it", 0, "I bought it.", "시제")])
    assert _home(client)["target"] == {"id": ids[3], "tag": "시제", "text": "I buy it", "fixed": "I bought it."}


def test_target_follows_the_top_tag_not_the_newest_mistake(client, monkeypatch):
    stamps = iter(f"2026-09-14T00:00:{s:02d}+00:00" for s in range(60))
    monkeypatch.setattr(db, "_now", lambda: next(stamps))
    _say([("a", 0, "A.", "관사"), ("b", 0, "B.", "관사"), ("c", 0, "C.", "관사"), ("d", 0, "D.", "관사"),
          ("e", 0, "E.", "시제"), ("f", 0, "F.", "시제"), ("g", 0, "G.", "시제")])
    assert _home(client)["target"]["tag"] == "관사"
    assert _home(client)["target"]["fixed"] == "D."


def test_accuracy_is_mypages_window(client):
    _say([("I go", 0, "I went.", "시제"), ("fine", 1, None, "없음"), ("ok", 1, None, "없음"), ("?", None, None, None)])
    _say([("read", 0, "x.", "어순")], mode="script")
    body = _home(client)
    assert body["accuracy"] == {"correct": 2, "graded": 3}
    assert body["accuracy"] == client.get("/api/stats/mypage", params={"language": "en"}).json()["accuracy"]


def test_empty_history_has_no_target_and_nothing_graded(client):
    body = _home(client)
    assert body["target"] is None
    assert body["accuracy"] == {"correct": 0, "graded": 0}


def test_accuracy_counts_the_last_thirty_days_only(client, monkeypatch):
    """_today is 9/14, so the window starts 8/16: 8/10 is out, 8/20 is in."""
    stamps = iter(["2026-08-10T03:00:00+00:00"] * 4 + ["2026-08-20T03:00:00+00:00"] * 4)
    monkeypatch.setattr(db, "_now", lambda: next(stamps))
    _say([("old", 1, None, "없음")])      # create, message, bot reply, end
    _say([("new", 0, "New.", "시제")])
    assert _home(client)["accuracy"] == {"correct": 0, "graded": 1}


def test_no_target_when_the_newest_sentence_has_no_fixed_one(client, monkeypatch):
    """The panel is built around the fixed sentence; nothing to show is no panel."""
    stamps = iter(f"2026-09-14T00:00:{s:02d}+00:00" for s in range(60))
    monkeypatch.setattr(db, "_now", lambda: next(stamps))
    _say([("a", 0, "A.", "시제"), ("b", 0, "B.", "시제"), ("c", 0, "", "시제")])
    assert _home(client)["target"] is None


def test_the_target_sentence_can_be_heard(client):
    """▶ 들어 보기: the fixed sentence of the target's own message, synthesised
    the way a review card's is -- only a learner message's own fixed sentence,
    never text the client sends."""
    ids = _say([("I go", 0, "I went.", "시제"), ("I goes", 0, "I go.", "시제"), ("I eats", 0, "I eat.", "시제")])
    target = _home(client)["target"]
    assert client.post(f"/api/messages/{target['id']}/fixed-audio").json()["audio_key"]
    assert client.post("/api/messages/9999/fixed-audio").status_code == 404
    right = _say([("fine", 1, None, "없음")])[0]
    assert client.post(f"/api/messages/{right}/fixed-audio").json() == {"audio_key": None}


def test_target_audio_is_null_when_tts_is_down(client, monkeypatch):
    ids = _say([("I go", 0, "I went.", "시제")])
    def dead(t, l, v):
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", dead)
    assert client.post(f"/api/messages/{ids[0]}/fixed-audio").json() == {"audio_key": None}
