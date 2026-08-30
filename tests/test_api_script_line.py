"""POST /api/sessions/{id}/script-line.

Script mode's own /sessions response never stores anything -- the learner has
not seen a single line yet at that point. Without this route the database
never learns what the learner was actually shown, which is exactly what left
a real learner's session full of bot lines nobody ever saw or heard.
"""
from concurrent.futures import ThreadPoolExecutor

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


def test_script_line_stores_the_bots_line_exactly(client):
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r.status_code == 200

    msgs = db.get_messages(sid)
    assert len(msgs) == 1
    assert msgs[0]["speaker"] == "bot"
    assert msgs[0]["text"] == "Morning! Ready for standup?"


def test_script_line_is_idempotent_for_a_repeated_index(client):
    """A refresh or a retried request must not double the record -- that is
    exactly the kind of fiction this fix exists to stop."""
    sid = start_script_session(client)
    client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r.status_code == 200

    msgs = db.get_messages(sid)
    assert len(msgs) == 1
    assert msgs[0]["text"] == "Morning! Ready for standup?"


def test_script_line_rejects_a_learner_line_index(client):
    """Index 1 in standup-meeting-en is the learner's line -- this route only
    ever stores what the bot showed the learner, never their own line."""
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 1})
    assert r.status_code == 400
    assert db.get_messages(sid) == []


def test_script_line_rejects_an_out_of_range_index(client):
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 99})
    assert r.status_code == 400
    assert db.get_messages(sid) == []


def test_script_line_rejects_a_negative_index(client):
    sid = start_script_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": -1})
    assert r.status_code == 400


def test_script_line_rejects_a_non_script_session(client):
    sid = start_free_session(client)
    r = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r.status_code == 400
    # only the free session's own opening message, untouched
    assert len(db.get_messages(sid)) == 1


def test_script_line_on_an_unknown_session_is_a_404(client):
    assert client.post("/api/sessions/9999/script-line", json={"index": 0}).status_code == 404


# ---------- identity-based idempotency ----------
#
# A prior version of this guard compared payload.index against
# len(db.get_messages(session_id)) -- "how many messages exist", not "was
# this index stored". That happens to track an in-order, gapless sequence of
# calls, but nothing about the client's call pattern actually guarantees one:
# a network retry can interleave with the next line's own call, and nothing
# stops two requests racing each other. These three probes are the ones that
# broke the old guard; each must produce exactly one row per script index.

def test_script_line_survives_an_interleaved_sequence_with_a_repeated_index(client):
    """0, 0, 2, 0, 2, 4, 2 -- indices 0 and 2 are each sent three times,
    interleaved rather than back to back. Exactly one row per distinct index
    (0, 2, 4), never a duplicate."""
    sid = start_script_session(client)
    for index in [0, 0, 2, 0, 2, 4, 2]:
        r = client.post(f"/api/sessions/{sid}/script-line", json={"index": index})
        assert r.status_code == 200

    msgs = [m for m in db.get_messages(sid) if m["speaker"] == "bot"]
    assert len(msgs) == 3
    by_index = {m["script_index"]: m["text"] for m in msgs}
    assert by_index == {
        0: "Morning! Ready for standup?",
        2: "Cool. What did you work on yesterday?",
        4: "Nice. Anything blocking you?",
    }


def test_script_line_out_of_order_does_not_drop_the_later_index(client):
    """Index 4 arrives before index 0. A count-based guard reads the single
    stored message as "index 0 already covered" and silently drops it -- the
    line the learner was actually shown then never lands in the record. Both
    must be stored, since neither was actually a repeat of the other."""
    sid = start_script_session(client)
    r1 = client.post(f"/api/sessions/{sid}/script-line", json={"index": 4})
    r2 = client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["stored"] is True
    assert r2.json()["stored"] is True, "a gap must not make a later index look already-stored"

    msgs = [m for m in db.get_messages(sid) if m["speaker"] == "bot"]
    assert len(msgs) == 2
    by_index = {m["script_index"]: m["text"] for m in msgs}
    assert by_index == {
        0: "Morning! Ready for standup?",
        4: "Nice. Anything blocking you?",
    }


def test_script_line_under_concurrent_requests_stores_exactly_one_row(client):
    """8 threads post the same index at once. FastAPI dispatches a sync route
    through a threadpool, so this is a genuine race, not a simulated one -- a
    read-then-write check (read the count, then decide, then insert) can let
    two threads both pass the read before either writes. Only a constraint
    the database itself enforces closes that window."""
    sid = start_script_session(client)

    def post():
        return client.post(f"/api/sessions/{sid}/script-line", json={"index": 0})

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda _: post(), range(8)))

    assert all(r.status_code == 200 for r in responses)
    msgs = [m for m in db.get_messages(sid) if m["speaker"] == "bot"]
    assert len(msgs) == 1, f"expected exactly one row for index 0, got {len(msgs)}"
    assert msgs[0]["text"] == "Morning! Ready for standup?"
    # Exactly one of the 8 responses actually stored it; the rest observed
    # the row already existing.
    assert sum(1 for r in responses if r.json()["stored"]) == 1
