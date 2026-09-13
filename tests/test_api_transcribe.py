import pytest
from fastapi.testclient import TestClient

from app import api, config, stt
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    return TestClient(app)


def post(client, language="en", data=b"webm"):
    return client.post("/api/transcribe", data={"language": language},
                       files={"file": ("clip.webm", data, "audio/webm")})


def test_returns_the_whisper_text(client, monkeypatch):
    seen = []
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: seen.append((audio, language)) or "I went there.")
    res = post(client, "en", b"abc")
    assert res.status_code == 200
    assert res.json() == {"text": "I went there."}
    assert seen == [(b"abc", "en")]


def test_silence_comes_back_as_an_empty_string(client, monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: "")
    assert post(client).json() == {"text": ""}


def test_503_while_the_model_is_not_ready(client, monkeypatch):
    def not_ready(audio, language):
        raise stt.SttUnavailable("loading")
    monkeypatch.setattr(stt, "transcribe", not_ready)
    assert post(client).status_code == 503


def test_503_when_transcription_itself_fails(client, monkeypatch):
    def boom(audio, language):
        raise RuntimeError("cuda out of memory")
    monkeypatch.setattr(stt, "transcribe", boom)
    assert post(client).status_code == 503


def test_an_unknown_language_is_refused(client, monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: "x")
    assert post(client, "ko").status_code == 422


def test_an_oversized_upload_is_refused(client, monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: "x")
    monkeypatch.setattr(api, "_MAX_TRANSCRIBE_BYTES", 10)
    assert post(client, "en", b"x" * 11).status_code == 413
