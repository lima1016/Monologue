import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    db.init_db()
    return TestClient(app)


def test_index_page_always_revalidates(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


def test_static_module_always_revalidates(client):
    response = client.get("/js/main.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


def test_api_route_is_not_forced_to_revalidate(client, monkeypatch):
    # /api/health touches real services by default; keep it fast and local.
    monkeypatch.setattr("app.api.llm.is_healthy", lambda: True)
    monkeypatch.setattr("app.api.voicevox_backend.is_healthy", lambda: False)
    monkeypatch.setattr("app.api.stt.status", lambda: "ready")

    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers.get("cache-control") != "no-cache"
