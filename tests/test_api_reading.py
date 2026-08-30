import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    return TestClient(app)


def test_reading_returns_one_entry_per_text_in_order(client):
    """줄 하나가 아니라 그리는 줄 전부를 한 번에 받는다. 대본 8줄이면 요청 하나다."""
    res = client.post("/api/reading",
                      json={"language": "ja", "texts": ["寿司", "ここ"]})
    assert res.status_code == 200
    readings = res.json()["readings"]
    assert len(readings) == 2
    assert readings[0][0]["parts"] == [{"text": "寿司", "ruby": "すし"}]
    assert readings[1][0]["parts"] == [{"text": "ここ", "ruby": None}]


def test_reading_rejects_a_language_that_has_no_reading_problem(client):
    """영어에는 읽기 보조가 없다. 조용히 빈 배열을 주면 프론트의 버그가
    '보조가 원래 안 붙는 언어'처럼 보여 숨는다."""
    res = client.post("/api/reading", json={"language": "en", "texts": ["hello"]})
    assert res.status_code == 400


def test_reading_of_an_empty_list_is_an_empty_list(client):
    res = client.post("/api/reading", json={"language": "ja", "texts": []})
    assert res.status_code == 200
    assert res.json()["readings"] == []
