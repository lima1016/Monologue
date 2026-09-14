"""💡 뭐라고 하지? -- 서버 쪽. 모델은 전부 목(mock)이다."""
import pytest
from fastapi.testclient import TestClient

from app import api, config, db, llm, tts
from app.main import app


def _r(text, meaning="뜻"):
    return {"text": text, "meaning": meaning}


def test_valid_replies_keeps_good_lines_in_order():
    out = api._valid_replies([_r("Sure, sounds good!"), _r("Can we do Friday?")], "en", "Lunch tomorrow?")
    assert out == [{"text": "Sure, sounds good!", "meaning": "뜻"},
                   {"text": "Can we do Friday?", "meaning": "뜻"}]


@pytest.mark.parametrize("language,text", [
    ("en", "네, 좋아요"),                 # Korean instead of the target language
    ("en", "Sure 좋아요"),                # any Hangul at all
    ("ja", "我明天很忙"),                  # kanji with no kana -- could be Chinese
    ("ja", "はい、좋아요"),
    ("en", "1234 !!"),                   # no letters
    ("en", "one two three four five six seven eight nine ten eleven twelve thirteen"),  # 13 words
    ("ja", "あ" * 31),                   # 31 chars
    ("en", ""),
    ("en", "   "),
    ("en", "Sure, 没问题!"),              # CJK ideograph leaking into an English reply
    ("en", "こんにちは, sure!"),           # kana leaking into an English reply
    ("ja", "はい (hai)"),                 # romaji gloss in parentheses -- forbidden
    ("ja", "OKです"),                     # Latin letters in a Japanese reply
    ("ja", "（はい）"),                   # full-width brackets are still brackets
])
def test_valid_replies_drops_a_line_that_cannot_be_said(language, text):
    assert api._valid_replies([_r(text)], language, "bot line") == []


def test_valid_replies_measures_japanese_length_without_punctuation():
    text = "あ" * 30 + "。、！"
    assert [r["text"] for r in api._valid_replies([_r(text)], "ja", "x")] == [text]


def test_valid_replies_allows_exactly_twelve_english_words():
    text = "one two three four five six seven eight nine ten eleven twelve"
    assert len(api._valid_replies([_r(text)], "en", "x")) == 1


def test_valid_replies_takes_only_the_first_line_of_text():
    out = api._valid_replies([_r("Sure!\n(This means yes.)")], "en", "x")
    assert out[0]["text"] == "Sure!"


def test_valid_replies_drops_duplicates_and_the_bots_own_line():
    out = api._valid_replies(
        [_r("Sure!"), _r("sure"), _r("Lunch tomorrow?"), _r("Maybe later.")],
        "en", "Lunch tomorrow",
    )
    assert [r["text"] for r in out] == ["Sure!", "Maybe later."]


def test_valid_replies_caps_at_three():
    out = api._valid_replies([_r("A one."), _r("B two."), _r("C three."), _r("D four.")], "en", "x")
    assert len(out) == 3


def test_valid_replies_merges_with_what_was_already_kept():
    kept = [{"text": "Sure!", "meaning": "좋아요"}]
    out = api._valid_replies([_r("sure"), _r("Not today.")], "en", "x", kept)
    assert out == [{"text": "Sure!", "meaning": "좋아요"}, {"text": "Not today.", "meaning": "뜻"}]


@pytest.mark.parametrize("raw", [None, "nope", [None, 3, "x"], [{"text": 5}], [{"meaning": "뜻"}]])
def test_valid_replies_survives_malformed_model_output(raw):
    assert api._valid_replies(raw, "en", "x") == []


def test_valid_replies_keeps_a_missing_or_non_string_meaning_as_none():
    out = api._valid_replies([{"text": "Sure!"}, {"text": "Nope.", "meaning": 3}], "en", "x")
    assert [r["meaning"] for r in out] == [None, None]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    api._cached_suggestions.cache_clear()
    api._cached_translation.cache_clear()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "Good morning! Window or aisle?")
    return TestClient(app)


class Model:
    """Queue of chat_json answers; records every call."""
    def __init__(self, monkeypatch, *answers):
        self.answers = list(answers)
        self.calls = []
        monkeypatch.setattr(llm, "chat_json", self)

    def __call__(self, messages, schema, **kw):
        self.calls.append({"messages": messages, "schema": schema, **kw})
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


GOOD = {"replies": [_r("Window, please.", "창가로 주세요."),
                    _r("Aisle is fine.", "통로도 괜찮아요."),
                    _r("Is there an exit row?", "비상구 좌석 있나요?")]}


def _free(client, language="en", scenario="airport-checkin-en"):
    return client.post("/api/sessions", json={"language": language, "mode": "free",
                                              "scenario_id": scenario}).json()["session_id"]


def test_generate_asks_the_model_warmly_and_returns_what_passed(monkeypatch):
    model = Model(monkeypatch, GOOD)
    out = api._generate_suggestions("en", "Window or aisle?")
    assert [r["text"] for r in out] == ["Window, please.", "Aisle is fine.", "Is there an exit row?"]
    assert out[0]["meaning"] == "창가로 주세요."
    assert model.calls[0]["temperature"] == 0.7
    assert model.calls[0]["schema"] == api.prompts.suggest_schema()


def test_generate_retries_once_when_fewer_than_two_pass_and_merges(monkeypatch):
    model = Model(monkeypatch,
                  {"replies": [_r("Window, please."), _r("네 창가요")]},
                  {"replies": [_r("window please"), _r("Aisle is fine.")]})
    out = api._generate_suggestions("en", "Window or aisle?")
    assert len(model.calls) == 2
    assert [r["text"] for r in out] == ["Window, please.", "Aisle is fine."]


def test_generate_shows_a_single_survivor_after_the_retry(monkeypatch):
    Model(monkeypatch, {"replies": [_r("Window, please.")]}, {"replies": []})
    assert [r["text"] for r in api._generate_suggestions("en", "x")] == ["Window, please."]


def test_generate_gives_up_when_nothing_passes(monkeypatch):
    model = Model(monkeypatch, {"replies": [_r("네")]}, {"replies": [_r("아니요")]})
    with pytest.raises(api._NoSuggestions):
        api._generate_suggestions("en", "x")
    assert len(model.calls) == 2


def test_generate_does_not_retry_a_dead_model(monkeypatch):
    """모델이 죽었으면 두 번째 호출은 타임아웃을 한 번 더 기다리게 할 뿐이다."""
    model = Model(monkeypatch, llm.LLMError("down"))
    with pytest.raises(api._NoSuggestions):
        api._generate_suggestions("en", "x")
    assert len(model.calls) == 1


def test_a_meaning_that_is_not_korean_is_translated_again(monkeypatch):
    Model(monkeypatch, {"replies": [_r("Window, please.", "靠窗的座位"), _r("Aisle is fine.", "통로도 괜찮아요.")]})
    asked = []
    monkeypatch.setattr(api, "_cached_translation", lambda lang, text: asked.append(text) or "창가로 주세요.")
    out = api._generate_suggestions("en", "x")
    assert asked == ["Window, please."]
    assert [r["meaning"] for r in out] == ["창가로 주세요.", "통로도 괜찮아요."]


def test_a_meaning_that_cannot_be_recovered_is_none(monkeypatch):
    Model(monkeypatch, {"replies": [_r("Window, please.", ""), _r("Aisle is fine.", None)]})
    monkeypatch.setattr(api, "_cached_translation", lambda lang, text: None)
    assert [r["meaning"] for r in api._generate_suggestions("en", "x")] == [None, None]


def test_route_returns_replies_with_audio(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    body = client.post(f"/api/sessions/{sid}/suggest").json()
    assert [r["text"] for r in body["replies"]] == ["Window, please.", "Aisle is fine.", "Is there an exit row?"]
    assert all(r["audio_key"] for r in body["replies"])
    assert body["replies"][0]["meaning"] == "창가로 주세요."


def test_route_hands_the_model_the_scene_the_level_and_the_bots_last_line(client, monkeypatch):
    sid = _free(client)
    model = Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    system = model.calls[0]["messages"][0]["content"]
    last_user = model.calls[0]["messages"][-1]["content"]
    assert "Good morning! Window or aisle?" in last_user
    assert "지금 상황" in system and "초급" in system


def test_route_passes_the_lesson_topic_and_recent_turns(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "lesson", "topic": "used to"}).json()["session_id"]
    db.add_message(sid, "user", "I used to swim.")
    db.add_message(sid, "bot", "Nice! Another one?")
    model = Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    system = model.calls[0]["messages"][0]["content"]
    assert "오늘 수업 주제: used to" in system
    assert "학생: I used to swim." in system
    assert "Nice! Another one?" in model.calls[0]["messages"][-1]["content"]
    assert "상대방: Nice! Another one?" not in system  # the line being answered is the query, not history


def test_route_keeps_only_the_last_six_messages_as_history(client, monkeypatch):
    sid = _free(client)
    for i in range(5):
        db.add_message(sid, "user", f"user line {i}")
        db.add_message(sid, "bot", f"bot line {i}")
    model = Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    system = model.calls[0]["messages"][0]["content"]
    assert "bot line 1" in system and "bot line 0" not in system


def test_route_rejects_what_it_cannot_answer(client, monkeypatch):
    Model(monkeypatch, GOOD)
    assert client.post("/api/sessions/999/suggest").status_code == 404
    script = client.post("/api/sessions", json={"language": "en", "mode": "script",
                                                "scenario_id": "standup-meeting-en"}).json()["session_id"]
    assert client.post(f"/api/sessions/{script}/suggest").status_code == 400
    ended = _free(client)
    db.end_session(ended, "{}", "beginner")
    assert client.post(f"/api/sessions/{ended}/suggest").status_code == 409
    silent = db.create_session("en", "lesson", topic=None)
    assert client.post(f"/api/sessions/{silent}/suggest").status_code == 409


def test_route_says_so_when_nothing_can_be_suggested(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, llm.LLMError("down"))
    r = client.post(f"/api/sessions/{sid}/suggest")
    assert r.status_code == 503
    assert r.json()["detail"] == api.SUGGEST_UNAVAILABLE


def test_route_caches_per_bot_line_and_not_failures(client, monkeypatch):
    sid = _free(client)
    model = Model(monkeypatch, llm.LLMError("down"))
    assert client.post(f"/api/sessions/{sid}/suggest").status_code == 503
    model.answers = [GOOD]
    first = client.post(f"/api/sessions/{sid}/suggest").json()
    again = client.post(f"/api/sessions/{sid}/suggest").json()
    assert first == again
    assert len(model.calls) == 2          # the failure, then one success; the repeat was free
    db.add_message(sid, "user", "Window.")
    db.add_message(sid, "bot", "Great. Any bags to check?")
    client.post(f"/api/sessions/{sid}/suggest")
    assert len(model.calls) == 3          # a new bot line is a new question


def test_route_still_answers_when_tts_is_down_and_recovers_after(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    def dead(t, l, v):
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", dead)
    body = client.post(f"/api/sessions/{sid}/suggest").json()
    assert [r["audio_key"] for r in body["replies"]] == [None, None, None]
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    body = client.post(f"/api/sessions/{sid}/suggest").json()
    assert all(r["audio_key"] for r in body["replies"])  # audio is not frozen into the cache


def test_route_response_does_not_leak_cache_mutation(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    cached = api._cached_suggestions(sid, db.get_messages(sid)[-1]["id"])
    assert all("audio_key" not in r for r in cached)


def test_route_says_unavailable_when_the_bot_line_vanishes_mid_request(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    real_get_messages = db.get_messages
    calls = []

    def flaky(session_id):
        calls.append(session_id)
        return real_get_messages(session_id) if len(calls) == 1 else []

    monkeypatch.setattr(db, "get_messages", flaky)
    r = client.post(f"/api/sessions/{sid}/suggest")
    assert r.status_code == 503
    assert r.json()["detail"] == api.SUGGEST_UNAVAILABLE
