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


def test_translate_returns_one_korean_line(client, monkeypatch):
    from app import llm
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "어서 오세요")
    res = client.post("/api/translate",
                      json={"language": "ja", "text": "いらっしゃいませ"})
    assert res.status_code == 200
    assert res.json()["meaning"] == "어서 오세요"


def test_translate_is_cached_so_reopening_a_line_is_free(client, monkeypatch):
    """같은 줄을 다시 펼치거나 이어서 하기로 돌아와도 14b를 다시 부르지 않는다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    calls = []

    def counting_chat(messages, **kw):
        calls.append(messages)
        return "어서 오세요"

    monkeypatch.setattr(llm, "chat", counting_chat)
    body = {"language": "ja", "text": "いらっしゃいませ"}
    client.post("/api/translate", json=body)
    client.post("/api/translate", json=body)
    assert len(calls) == 1


def test_translate_says_so_when_the_model_is_down(client, monkeypatch):
    """503이어야 한다. 빈 문자열을 주면 프론트가 '뜻이 없는 줄'로 그려서
    모델이 죽은 것과 뜻이 원래 없는 것이 화면에서 구분되지 않는다."""
    from app import api, llm
    api._cached_translation.cache_clear()

    def boom(messages, **kw):
        raise RuntimeError("ollama is down")

    monkeypatch.setattr(llm, "chat", boom)
    res = client.post("/api/translate", json={"language": "ja", "text": "こんにちは"})
    assert res.status_code == 503


def test_translate_rejects_a_language_that_needs_no_translation(client):
    res = client.post("/api/translate", json={"language": "en", "text": "hello"})
    assert res.status_code == 400
