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
    return TestClient(app)


class ImmediateExecutor:
    def __init__(self):
        self.jobs = []

    def submit(self, fn, *args):
        self.jobs.append(args)
        fn(*args)


def _script(n, theme="hotel", language="en"):
    lines = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"{theme} {n} line {i}."} for i in range(16)]
    db.add_library_scenario({"id": f"lib-{theme}-{language}-{n:02d}", "theme_id": theme, "situation": "체크인",
                             "language": language, "type": "script", "title": f"제목{n}", "lines": lines})
    return lines


def test_themes_lists_twenty_with_readiness(client):
    _script(1)
    db.add_library_scenario({"id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None, "language": "en",
                             "type": "free", "title": "호텔", "goal": "g", "persona_prompt": "p", "max_turns": 16})
    themes = client.get("/api/themes?language=en").json()["themes"]
    assert len(themes) == 20
    hotel = next(t for t in themes if t["id"] == "hotel")
    assert hotel["ready"] == {"free": True, "script": 1}
    assert next(t for t in themes if t["id"] == "shopping")["ready"] == {"free": False, "script": 0}


def test_pick_a_script_and_prepare_its_audio_in_the_background(client, monkeypatch):
    lines = _script(1)
    ex = ImmediateExecutor()
    monkeypatch.setattr(api, "_audio_executor", ex)
    body = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"}).json()
    assert body == {"id": "lib-hotel-en-01", "title": "제목1", "situation": "체크인"}
    assert len(ex.jobs) == 1 and ex.jobs[0][0] == lines
    for line in lines:
        key = tts.cache_key(api.clean_for_tts(line["text"]), "en", api.selected_voice("en"))
        assert tts.cached_path(key).exists()


def test_pick_then_start_uses_the_cached_audio(client, monkeypatch):
    _script(1)
    monkeypatch.setattr(api, "_audio_executor", ImmediateExecutor())
    picked = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"}).json()
    calls = []
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: calls.append(t) or b"RIFFfake")
    r = client.post("/api/sessions", json={"language": "en", "mode": "script", "scenario_id": picked["id"]})
    assert r.status_code == 200 and len(r.json()["lines"]) == 16
    assert calls == []


def test_pick_free_returns_the_theme_setup(client):
    db.add_library_scenario({"id": "lib-hotel-ja-free", "theme_id": "hotel", "situation": None, "language": "ja",
                             "type": "free", "title": "호텔", "goal": "g", "persona_prompt": "p", "max_turns": 16})
    body = client.post("/api/library/pick", json={"language": "ja", "mode": "free", "theme_id": "hotel"}).json()
    assert body["id"] == "lib-hotel-ja-free"


def test_pick_errors(client):
    assert client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "nope"}).status_code == 404
    assert client.post("/api/library/pick", json={"language": "en", "mode": "lesson", "theme_id": "hotel"}).status_code == 400
    r = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"})
    assert r.status_code == 409 and r.json()["detail"] == "이 테마는 아직 준비되지 않았어요"
    assert client.post("/api/library/pick", json={"language": "en", "mode": "free", "theme_id": "hotel"}).status_code == 409


def test_background_audio_failure_is_swallowed(client, monkeypatch):
    _script(1)
    monkeypatch.setattr(api, "_audio_executor", ImmediateExecutor())
    def dead(t, l, v):
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", dead)
    r = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"})
    assert r.status_code == 200


def test_background_audio_failure_is_logged(client, monkeypatch, caplog):
    _script(1)
    monkeypatch.setattr(api, "_audio_executor", ImmediateExecutor())
    def dead(*args):
        raise RuntimeError("boom")
    monkeypatch.setattr(api, "_speak", dead)
    with caplog.at_level("WARNING", logger="app.api"):
        r = client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"})
    assert r.status_code == 200
    assert any(rec.levelname == "WARNING" for rec in caplog.records)


# ---------- the audio warm-up keeps only the latest pick ----------

class HoldingExecutor:
    """Queues jobs as real Futures and runs nothing until told to -- the one
    audio worker busy with something else."""
    def __init__(self):
        from concurrent.futures import Future
        self._Future = Future
        self.jobs = []

    def submit(self, fn, *args):
        future = self._Future()
        self.jobs.append((future, fn, args))
        return future

    def run(self, index):
        future, fn, args = self.jobs[index]
        if future.set_running_or_notify_cancel():
            future.set_result(fn(*args))
            return True
        return False


def _pick(client):
    return client.post("/api/library/pick", json={"language": "en", "mode": "script", "theme_id": "hotel"})


def test_a_new_pick_cancels_the_warm_up_still_waiting_in_the_queue(client, monkeypatch):
    _script(1)
    ex = HoldingExecutor()
    monkeypatch.setattr(api, "_audio_executor", ex)
    for _ in range(3):
        assert _pick(client).status_code == 200
    assert [f.cancelled() for f, _, _ in ex.jobs] == [True, True, False]
    spoken = []
    monkeypatch.setattr(api, "_speak", lambda text, language: spoken.append(text))
    assert ex.run(0) is False and ex.run(2) is True
    assert len(spoken) == 16


def test_a_warm_up_already_running_stops_between_lines_once_a_newer_pick_arrives(client, monkeypatch):
    _script(1)
    ex = HoldingExecutor()
    monkeypatch.setattr(api, "_audio_executor", ex)
    _pick(client)
    spoken = []

    def speak(text, language):
        spoken.append(text)
        if len(spoken) == 2:
            _pick(client)        # the learner clicks another card while line 2 is synthesising
    monkeypatch.setattr(api, "_speak", speak)
    ex.run(0)
    assert len(spoken) == 2, "the stale warm-up kept synthesising a script nobody is about to open"
    spoken.clear()
    monkeypatch.setattr(api, "_speak", lambda text, language: spoken.append(text))
    ex.run(1)
    assert len(spoken) == 16
