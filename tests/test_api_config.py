import pytest
from fastapi.testclient import TestClient

from app import config, db, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    db.init_db()
    return TestClient(app)


def test_health_reports_both_services(client, monkeypatch):
    monkeypatch.setattr("app.api.llm.is_healthy", lambda: True)
    monkeypatch.setattr("app.api.voicevox_backend.is_healthy", lambda: False)
    body = client.get("/api/health").json()
    assert body == {"ollama": True, "voicevox": False}


def test_scenarios_filtered_by_language(client):
    body = client.get("/api/scenarios", params={"language": "ja"}).json()
    assert body["scenarios"]
    assert all("ja" in s["id"] for s in body["scenarios"])


def test_scenarios_filtered_by_mode(client):
    body = client.get("/api/scenarios", params={"language": "en", "mode": "script"}).json()
    assert all(s["type"] == "script" for s in body["scenarios"])


def test_scenarios_rejects_unknown_language(client):
    assert client.get("/api/scenarios", params={"language": "fr"}).status_code == 422


def test_voices_returns_catalog_and_default_when_unset(client):
    body = client.get("/api/voices", params={"language": "en"}).json()
    assert [v["id"] for v in body["voices"]] == [
        "am_adam", "am_fenrir", "af_heart", "af_bella", "af_kore"
    ]
    assert body["selected"] == "am_adam"


def test_selecting_a_voice_persists_it(client):
    assert client.post("/api/voices", json={"language": "en", "voice": "af_kore"}).status_code == 200
    assert client.get("/api/voices", params={"language": "en"}).json()["selected"] == "af_kore"


def test_selecting_a_voice_outside_the_catalog_is_rejected(client):
    r = client.post("/api/voices", json={"language": "en", "voice": "bm_george"})
    assert r.status_code == 400


def test_voice_selection_is_independent_per_language(client):
    client.post("/api/voices", json={"language": "en", "voice": "af_kore"})
    assert client.get("/api/voices", params={"language": "ja"}).json()["selected"] == "21"


def test_preview_returns_wav_audio(client, monkeypatch):
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    r = client.post("/api/tts/preview", json={"language": "en", "voice": "am_adam"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == b"RIFFfake"


def test_preview_reports_failure_clearly(client, monkeypatch):
    def boom(text, language, voice):
        raise tts.TTSError("engine down")

    monkeypatch.setattr(tts, "synthesize", boom)
    r = client.post("/api/tts/preview", json={"language": "en", "voice": "am_adam"})
    assert r.status_code == 503
    assert "engine down" in r.json()["detail"]


def test_generating_a_scenario_stores_it_and_returns_it(client, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json", lambda messages, schema, **kw: {
        "title": "구직 면접", "goal": "경력을 설명하고 질문에 답한다",
        "persona_prompt": "You are a hiring manager interviewing a candidate.",
    })
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "free", "wish": "구직 면접"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "구직 면접"
    assert body["id"].startswith("user-")

    listed = client.get("/api/scenarios?language=en&mode=free").json()["scenarios"]
    assert body["id"] in [s["id"] for s in listed]


def test_a_generated_scenario_that_fails_validation_is_rejected(client, monkeypatch):
    """A local 14b will sometimes return something unusable. Better a clear
    error than a row that explodes when the learner presses 시작."""
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"title": "", "goal": "", "persona_prompt": ""})
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "free", "wish": "구직 면접"})
    assert r.status_code == 422


def test_lesson_mode_cannot_generate_a_scenario(client):
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "lesson", "wish": "past tense"})
    assert r.status_code == 422
