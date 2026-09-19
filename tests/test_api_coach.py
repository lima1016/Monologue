"""코치 한마디 -- 서버 쪽. 모델은 전부 목(mock)이다."""
import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import api, config, db, llm, tts
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


def _wrong(n, language="en"):
    sid = db.create_session(language, "free", scenario_id="airport-checkin-en")
    for i in range(n):
        db.add_message(sid, "user", f"I go {i}", correction="과거형", ok=0, fixed=f"I went {i}.", tag="시제")
        db.add_message(sid, "bot", "reply")


def _model(monkeypatch, *answers):
    calls = []
    def fake(messages, schema, temperature=0.3):
        calls.append(messages)
        answer = answers[min(len(calls), len(answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(llm, "chat_json", fake)
    return calls


GOOD = {"items": [
    {"habit": "지난 일을 현재형으로 말해요", "tip": "yesterday가 나오면 과거형으로 바꿔요", "example_no": 1},
    {"habit": "문장을 끊지 않고 이어 말해요", "tip": "한 문장 말하고 숨을 쉬어요", "example_no": 2},
]}


def test_too_few_does_not_call_the_model(client, monkeypatch):
    _wrong(4)
    calls = _model(monkeypatch, GOOD)
    body = client.get("/api/mypage/coach?language=en").json()
    assert body == {"status": "too_few", "count": 4, "need": 5}
    assert calls == []


def test_ready_fills_the_example_from_the_real_sentence(client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, GOOD)
    body = client.get("/api/mypage/coach?language=en").json()
    assert body["status"] == "ready" and body["count"] == 6 and body["day"] == date.today().isoformat()
    # rows come newest first: example_no 1 is the newest sentence
    assert body["items"][0] == {"habit": "지난 일을 현재형으로 말해요", "tip": "yesterday가 나오면 과거형으로 바꿔요",
                                "said": "I go 5", "fixed": "I went 5.", "tag": "시제"}
    assert body["items"][1]["said"] == "I go 4"


def test_same_day_is_served_from_the_cache(client, monkeypatch):
    _wrong(6)
    calls = _model(monkeypatch, GOOD)
    first = client.get("/api/mypage/coach?language=en").json()
    second = client.get("/api/mypage/coach?language=en").json()
    assert first == second and len(calls) == 1


def test_an_older_day_is_made_again(client, monkeypatch):
    _wrong(6)
    db.save_coach("en", "2000-01-01", [{"habit": "옛날", "tip": "옛날", "said": "a", "fixed": "b", "tag": None}])
    calls = _model(monkeypatch, GOOD)
    body = client.get("/api/mypage/coach?language=en").json()
    assert len(calls) == 1 and body["items"][0]["habit"] != "옛날"


@pytest.mark.parametrize("bad", [
    {"habit": "过去的事情用现在时", "tip": "改成过去式", "example_no": 1},        # Chinese
    {"habit": "지난 일을 현재형으로 말해요", "tip": "과거형으로", "example_no": 99},  # no such sentence
    {"habit": "지난 일을 현재형으로 말해요", "tip": "과거형으로", "example_no": 0},
    {"habit": "", "tip": "과거형으로", "example_no": 1},
    {"habit": "Use past tense", "tip": "Change the verb", "example_no": 1},         # English, no Hangul
])
def test_a_bad_item_is_dropped(bad, client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, {"items": [bad, GOOD["items"][1]]}, {"items": [bad, GOOD["items"][1]]})
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert [i["habit"] for i in items] == ["문장을 끊지 않고 이어 말해요"]


def test_fewer_than_two_asks_once_more(client, monkeypatch):
    _wrong(6)
    calls = _model(monkeypatch, {"items": [GOOD["items"][0]]}, GOOD)
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert len(calls) == 2 and len(items) == 2


def test_the_same_habit_twice_is_kept_once(client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, {"items": [GOOD["items"][0], GOOD["items"][0], GOOD["items"][1]]})
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert [i["habit"] for i in items] == ["지난 일을 현재형으로 말해요", "문장을 끊지 않고 이어 말해요"]


def test_nothing_usable_is_503_and_not_cached(client, monkeypatch):
    _wrong(6)
    _model(monkeypatch, {"items": []}, {"items": []})
    r = client.get("/api/mypage/coach?language=en")
    assert r.status_code == 503 and r.json()["detail"] == "지금은 코치 한마디를 만들 수 없어요"
    assert db.get_coach("en") is None


def test_a_dead_model_is_503_after_one_call(client, monkeypatch):
    _wrong(6)
    calls = _model(monkeypatch, llm.LLMError("down"))
    assert client.get("/api/mypage/coach?language=en").status_code == 503
    assert len(calls) == 1


def test_languages_are_kept_apart(client, monkeypatch):
    _wrong(6, "en")
    _wrong(2, "ja")
    _model(monkeypatch, GOOD)
    assert client.get("/api/mypage/coach?language=ja").json()["status"] == "too_few"
    assert client.get("/api/mypage/coach?language=en").json()["status"] == "ready"


def test_a_habit_copied_from_the_few_shot_answer_is_dropped(client, monkeypatch):
    from app import prompts
    _wrong(6)
    copied = dict(prompts.COACH_EXAMPLE_OUTPUT["items"][0], example_no=1)
    copied["habit"] = f"  {copied['habit']} "
    _model(monkeypatch, {"items": [copied, GOOD["items"][1]]}, {"items": [copied, GOOD["items"][1]]})
    items = client.get("/api/mypage/coach?language=en").json()["items"]
    assert [i["habit"] for i in items] == ["문장을 끊지 않고 이어 말해요"]
