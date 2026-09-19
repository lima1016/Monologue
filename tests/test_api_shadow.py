"""Shadowing: a script session with a flag, one row per line attempt."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import api, config, db, llm, scenarios, tts
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


def shadow_three(client):
    """Line 0 said right blind, line 1 said wrong, line 2 said right after peeking."""
    sid = start(client).json()["session_id"]
    ls = lines()
    say = lambda i, text, peeked=False: client.post(
        f"/api/sessions/{sid}/shadow-line", json={"index": i, "text": text, "peeked": peeked})
    say(0, ls[0]["text"])
    say(1, "completely different words here")
    say(2, ls[2]["text"], peeked=True)
    return sid


def test_ending_a_shadowing_session_counts_and_queues_the_hard_lines(client, monkeypatch):
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 19))
    sid = shadow_three(client)
    r = client.post(f"/api/sessions/{sid}/end")
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "shadow" and body["level"] is None
    s = body["shadow"]
    assert (s["lines"], s["done"], s["matched"], s["peeked"]) == (len(lines()), 3, 2, 1)
    assert [h["index"] for h in s["hard"]] == [1, 2]
    assert s["hard"][0]["target"] == lines()[1]["text"] and s["hard"][0]["said"] == "completely different words here"
    assert all("audio_key" in h for h in s["hard"])
    assert db.get_session(sid)["level"] is None
    queued = db.due_reviews("en", date(2026, 9, 20))
    assert sorted(q["fixed"] for q in queued) == sorted([lines()[1]["text"], lines()[2]["text"]])
    assert all(q["shadowing"] for q in queued)
    assert db.due_reviews("en", date(2026, 9, 19)) == [], "queued for tomorrow, not today"


def test_the_report_reads_back_the_same_numbers(client):
    sid = shadow_three(client)
    ended = client.post(f"/api/sessions/{sid}/end").json()
    again = client.get(f"/api/sessions/{sid}/report").json()
    assert again["kind"] == "shadow" and again["shadowing"] is True and again["mode"] == "script"
    assert again["shadow"] == ended["shadow"]


def test_shadowing_leaves_level_accuracy_and_weak_spots_alone(client):
    before = (db.stable_level("en"), db.accuracy_since("en", date(2000, 1, 1)),
              db.home_stats("en")["top_tags"], db.home_stats("en")["fixed_total"])
    client.post(f"/api/sessions/{shadow_three(client)}/end")
    after = (db.stable_level("en"), db.accuracy_since("en", date(2000, 1, 1)),
             db.home_stats("en")["top_tags"], db.home_stats("en")["fixed_total"])
    assert after == before


def test_lists_say_which_sessions_were_shadowing(client):
    sid = shadow_three(client)
    client.post(f"/api/sessions/{sid}/end")
    item = client.get("/api/sessions/history?language=en").json()["items"][0]
    assert item["id"] == sid and item["shadowing"] is True and item["turns"] == 3
    recent = client.get("/api/stats/home?language=en").json()
    rows = recent["recent"]
    assert rows and rows[0]["shadowing"] is True


def test_home_stats_recent_themes_say_which_theme_was_shadowing(client):
    """The home screen's 최근 테마 cards (`_recent_themes`) also need the flag:
    a shadowing session is stored with mode "script" (SCRIPT above is not a
    lib- scenario, so `shadow_three` never reaches this list -- this needs
    its own library scenario). Not ended: library_sessions/recent_themes read
    straight off `sessions` the moment it is created, matching
    test_api_config.py's test_home_stats_recommend_recent_themes_library_and_history."""
    db.add_library_scenario({"id": "lib-hotel-en-01", "theme_id": "hotel", "situation": "s", "language": "en",
                             "type": "script", "title": "t",
                             "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})
    db.create_session("en", "script", scenario_id="lib-hotel-en-01", shadowing=True)
    body = client.get("/api/stats/home?language=en").json()
    assert body["recent_themes"] == [{"theme_id": "hotel", "title": "호텔", "mode": "script", "shadowing": True}]
