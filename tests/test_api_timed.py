"""1분 말하기: 질문 만들기와 timed 세션 시작 -- 서버 쪽. 모델은 전부 목(mock)이다."""
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
    api._cached_timed_questions.cache_clear()
    return TestClient(app)


def _q(text, meaning="뜻이에요", starter="Well..."):
    return {"text": text, "meaning": meaning, "starter": starter}


class Model:
    """Queue of chat_json answers; records every call. Mirrors test_api_suggest.py's Model."""
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


GOOD = {"questions": [
    _q("What did you do last weekend?", "지난 주말에 뭐 했어요?", "Last weekend, I..."),
    _q("What is your plan for this weekend?", "이번 주말 계획이 뭐예요?", "This weekend, I'm going to..."),
    _q("Do you like to stay home or go out on weekends?", "주말엔 집에 있는 게 좋아요, 나가는 게 좋아요?", "I like to..."),
]}


# ---------------------------------------------------------------------------
# _valid_questions
# ---------------------------------------------------------------------------

def test_valid_questions_keeps_good_items_with_fields_intact():
    out = api._valid_questions(GOOD["questions"], "en")
    assert out == GOOD["questions"]


def test_valid_questions_drops_an_item_with_a_chinese_meaning():
    raw = [_q("Good text", "这是中文"), _q("What do you usually eat for lunch?", "점심에 뭘 먹어요?")]
    out = api._valid_questions(raw, "en")
    assert [q["text"] for q in out] == ["What do you usually eat for lunch?"]


def test_valid_questions_drops_a_question_with_hangul_mixed_in():
    raw = [_q("What do you 좋아 to eat?"), _q("What do you usually eat for lunch?", "점심에 뭘 먹어요?")]
    out = api._valid_questions(raw, "en")
    assert [q["text"] for q in out] == ["What do you usually eat for lunch?"]


def test_valid_questions_drops_an_empty_text():
    raw = [_q("   "), _q("What do you usually eat for lunch?", "점심에 뭘 먹어요?")]
    out = api._valid_questions(raw, "en")
    assert [q["text"] for q in out] == ["What do you usually eat for lunch?"]


@pytest.mark.parametrize("language,text", [
    ("en", "무엇을 했어요?"),      # Korean instead of the target language
    ("en", "1234!!"),             # no Latin letters at all
    ("ja", "我明天很忙吗？"),        # kanji with no kana -- could be Chinese
    ("ja", "何をしましたか OK"),    # Latin letters leaking into a Japanese question
    ("ja", ""),
])
def test_valid_questions_drops_a_question_that_fails_the_script_check(language, text):
    assert api._valid_questions([_q(text, "뜻이에요")], language) == []


def test_valid_questions_starter_becomes_empty_when_missing_or_hangul_mixed_in():
    raw = [
        {"text": "What did you do yesterday?", "meaning": "어제 뭐 했어요?"},
        {"text": "What is your plan for tomorrow?", "meaning": "내일 계획이 뭐예요?", "starter": "내일은..."},
    ]
    out = api._valid_questions(raw, "en")
    assert [q["starter"] for q in out] == ["", ""]


def test_valid_questions_dedupes_the_same_text():
    raw = [_q("What did you do last weekend?", "지난 주말에 뭐 했어요?"),
           _q("what did you do last weekend?", "지난 주말에 뭐 했어요?")]
    out = api._valid_questions(raw, "en")
    assert len(out) == 1


def test_valid_questions_caps_at_three():
    raw = [_q(f"Question number {i} for you today?", "뜻이에요") for i in range(5)]
    out = api._valid_questions(raw, "en")
    assert len(out) == 3


def test_valid_questions_merges_with_what_was_already_kept():
    kept = [_q("What did you do last weekend?", "지난 주말에 뭐 했어요?")]
    out = api._valid_questions([_q("What is your plan for tomorrow?", "내일 계획이 뭐예요?")], "en", kept)
    assert [q["text"] for q in out] == ["What did you do last weekend?", "What is your plan for tomorrow?"]


@pytest.mark.parametrize("raw", [None, "nope", [None, 3, "x"], [{"text": 5}], [{"meaning": "뜻이에요"}]])
def test_valid_questions_survives_malformed_model_output(raw):
    assert api._valid_questions(raw, "en") == []


# ---------------------------------------------------------------------------
# _generate_timed_questions -- retry / dead-model rules from _generate_suggestions
# ---------------------------------------------------------------------------

def test_generate_returns_up_to_three_questions_on_the_first_try(monkeypatch):
    model = Model(monkeypatch, GOOD)
    out = api._generate_timed_questions("en", "일상 · 주말", "beginner")
    assert len(model.calls) == 1
    assert [q["text"] for q in out] == [q["text"] for q in GOOD["questions"]]


def test_generate_retries_once_when_fewer_than_two_pass_and_fills_with_the_second_call(monkeypatch):
    model = Model(
        monkeypatch,
        {"questions": [_q("What did you do last weekend?", "지난 주말에 뭐 했어요?")]},
        {"questions": [_q("What did you do last weekend?", "지난 주말에 뭐 했어요?"),
                       _q("What is your plan for tomorrow?", "내일 계획이 뭐예요?")]},
    )
    out = api._generate_timed_questions("en", "일상 · 주말", "beginner")
    assert len(model.calls) == 2
    assert [q["text"] for q in out] == ["What did you do last weekend?", "What is your plan for tomorrow?"]


def test_generate_gives_up_after_one_call_when_the_model_raises(monkeypatch):
    model = Model(monkeypatch, llm.LLMError("down"))
    with pytest.raises(api._NoQuestions):
        api._generate_timed_questions("en", "일상 · 주말", "beginner")
    assert len(model.calls) == 1


def test_generate_raises_when_nothing_passes_even_after_the_retry(monkeypatch):
    model = Model(monkeypatch, {"questions": [_q("무엇을 했어요?")]}, {"questions": []})
    with pytest.raises(api._NoQuestions):
        api._generate_timed_questions("en", "일상 · 주말", "beginner")
    assert len(model.calls) == 2


# ---------------------------------------------------------------------------
# GET /api/timed/questions
# ---------------------------------------------------------------------------

def test_route_returns_three_questions_with_fields_intact(client, monkeypatch):
    Model(monkeypatch, GOOD)
    body = client.get("/api/timed/questions?language=en&theme_id=cafe-restaurant").json()
    assert body == {"questions": GOOD["questions"]}


def test_route_503_when_the_model_cannot_produce_enough(client, monkeypatch):
    Model(monkeypatch, {"questions": [_q("무엇을 했어요?")]}, {"questions": []})
    r = client.get("/api/timed/questions?language=en&theme_id=cafe-restaurant")
    assert r.status_code == 503
    assert r.json()["detail"] == api.TIMED_QUESTIONS_UNAVAILABLE


def test_route_unknown_theme_is_404(client, monkeypatch):
    Model(monkeypatch, GOOD)
    r = client.get("/api/timed/questions?language=en&theme_id=no-such-theme")
    assert r.status_code == 404


def test_route_asks_the_model_once_for_the_same_theme_on_the_same_day(client, monkeypatch):
    model = Model(monkeypatch, GOOD)
    client.get("/api/timed/questions?language=en&theme_id=cafe-restaurant")
    client.get("/api/timed/questions?language=en&theme_id=cafe-restaurant")
    assert len(model.calls) == 1


# ---------------------------------------------------------------------------
# POST /api/sessions, mode=timed
# ---------------------------------------------------------------------------

def test_start_timed_session_needs_a_topic(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "timed"})
    assert r.status_code == 400
    r = client.post("/api/sessions", json={"language": "en", "mode": "timed", "topic": "   "})
    assert r.status_code == 400


def test_start_timed_session_rejects_a_scenario_id(client):
    r = client.post("/api/sessions", json={
        "language": "en", "mode": "timed", "topic": "What did you do last weekend?",
        "scenario_id": "airport-checkin-en",
    })
    assert r.status_code == 400


def test_start_timed_session_makes_no_model_call_and_no_opening_line(client, monkeypatch):
    model = Model(monkeypatch, GOOD)
    body = client.post("/api/sessions", json={
        "language": "en", "mode": "timed", "topic": "What did you do last weekend?",
    }).json()
    assert body == {"session_id": body["session_id"], "mode": "timed",
                    "topic": "What did you do last weekend?"}
    assert db.get_messages(body["session_id"]) == []
    assert model.calls == []


# ---------------------------------------------------------------------------
# resumable_session excludes timed
# ---------------------------------------------------------------------------

def test_resumable_never_returns_a_timed_session_even_with_messages(client):
    sid = db.create_session("en", "timed", topic="What did you do last weekend?")
    db.add_message(sid, "user", "Last weekend I stayed home.")
    assert db.resumable_session("en") is None
