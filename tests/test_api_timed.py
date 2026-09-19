"""1분 말하기: 질문 만들기, timed 세션 시작, 회차 -- 서버 쪽. 모델은 전부 목(mock)이다."""
import json
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app import api, config, db, llm, prompts, stt, tts
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


# ---------------------------------------------------------------------------
# rounds: upload, transcribe again, grade sentence by sentence, native answer
# ---------------------------------------------------------------------------

SEGMENTS = [
    {"start": 0.0, "end": 2.0, "text": "Last weekend I go to the park."},
    {"start": 6.0, "end": 9.0, "text": "We ate sandwiches together."},
]
WRONG = {"ok": False, "fixed": "Last weekend I went to the park.", "tag": "시제",
         "correction": "과거 일이라 went를 써요.", "suggestion": None}
RIGHT = {"ok": True, "fixed": None, "tag": None, "correction": None, "suggestion": None}
NATIVE = {"native": "Last weekend I headed to the park and we had sandwiches together.",
          "level": "intermediate"}


class Stt:
    """transcribe_segments stand-in: returns SEGMENTS, or raises what it is told to."""
    def __init__(self, monkeypatch, result=None):
        self.result = SEGMENTS if result is None else result
        self.calls = 0
        monkeypatch.setattr(stt, "transcribe_segments", self)

    def __call__(self, audio, language):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _timed(language="en", topic="What did you do last weekend?"):
    return db.create_session(language, "timed", topic=topic)


def _upload(client, sid, seconds="30", audio=b"AUDIO-BYTES"):
    return client.post(f"/api/sessions/{sid}/timed/rounds", data={"seconds": seconds},
                       files={"file": ("r.webm", audio, "audio/webm")})


def _review_rows():
    with db.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM review_queue").fetchall()]


def test_upload_stores_the_recording_transcribes_it_and_makes_round_one(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    body = _upload(client, sid).json()
    assert body == {"round": 1, "seconds": 30.0, "words": 11, "wpm": 22, "long_pauses": 1,
                    "sentences": [{"text": "Last weekend I go to the park."},
                                  {"text": "We ate sandwiches together."}]}
    assert (config.AUDIO_DIR / f"s{sid}_r1.webm").read_bytes() == b"AUDIO-BYTES"
    rounds = db.get_rounds(sid)
    assert [r["round"] for r in rounds] == [1]
    assert rounds[0]["audio_path"] == f"audio/s{sid}_r1.webm"
    assert [s["text"] for s in rounds[0]["sentences"]] == [
        "Last weekend I go to the park.", "We ate sandwiches together."]
    assert all(s["graded"] is False for s in rounds[0]["sentences"])


def test_a_second_upload_is_round_two(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    body = _upload(client, sid).json()
    assert body["round"] == 2
    assert [r["round"] for r in db.get_rounds(sid)] == [1, 2]
    assert (config.AUDIO_DIR / f"s{sid}_r2.webm").exists()


@pytest.mark.parametrize("failure", [stt.SttUnavailable("loading"), RuntimeError("cuda")])
def test_stt_failure_keeps_the_recording_and_the_round_then_transcribe_fills_it(client, monkeypatch, failure):
    fake = Stt(monkeypatch, failure)
    sid = _timed()
    r = _upload(client, sid)
    assert r.status_code == 503
    assert r.json()["detail"] == {"message": api.TIMED_STT_UNAVAILABLE, "round": 1}
    kept = config.AUDIO_DIR / f"s{sid}_r1.webm"
    assert kept.exists(), "the recording must be saved even when transcription fails"
    assert kept.read_bytes() == b"AUDIO-BYTES"
    rounds = db.get_rounds(sid)
    assert len(rounds) == 1, "the round number must be reserved even when transcription fails"
    rnd = rounds[0]
    assert rnd["round"] == 1 and rnd["sentences"] == [] and rnd["seconds"] == 30.0
    assert rnd["audio_path"] == f"audio/s{sid}_r1.webm"

    fake.result = SEGMENTS
    body = client.post(f"/api/sessions/{sid}/timed/rounds/1/transcribe").json()
    assert body["round"] == 1 and body["words"] == 11 and body["long_pauses"] == 1
    assert len(body["sentences"]) == 2
    [rnd] = db.get_rounds(sid)
    assert rnd["words"] == 11 and rnd["long_pauses"] == 1
    assert [s["text"] for s in rnd["sentences"]] == [s["text"] for s in body["sentences"]]

    r = client.post(f"/api/sessions/{sid}/timed/rounds/1/transcribe")
    assert r.status_code == 409


def test_transcribe_again_can_fail_again_and_still_names_the_round(client, monkeypatch):
    Stt(monkeypatch, stt.SttUnavailable("loading"))
    sid = _timed()
    _upload(client, sid)
    r = client.post(f"/api/sessions/{sid}/timed/rounds/1/transcribe")
    assert r.status_code == 503
    assert r.json()["detail"]["round"] == 1


def test_a_failed_round_still_takes_its_number(client, monkeypatch):
    fake = Stt(monkeypatch, stt.SttUnavailable("loading"))
    sid = _timed()
    _upload(client, sid)
    fake.result = SEGMENTS
    assert _upload(client, sid).json()["round"] == 2


def test_grade_round_one_makes_a_message_and_a_review_for_tomorrow(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, WRONG)
    body = client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0").json()
    assert body == {"i": 0, "text": "Last weekend I go to the park.", **WRONG}
    [msg] = db.get_messages(sid)
    assert msg["speaker"] == "user" and msg["text"] == "Last weekend I go to the park."
    assert msg["ok"] == 0 and msg["fixed"] == WRONG["fixed"] and msg["tag"] == "시제"
    [review] = _review_rows()
    assert review["message_id"] == msg["id"]
    assert review["due_date"] == (date.today() + timedelta(days=1)).isoformat()
    stored = db.get_rounds(sid)[0]["sentences"][0]
    assert stored["graded"] is True and stored["message_id"] == msg["id"]
    assert stored["fixed"] == WRONG["fixed"]


def test_grade_a_right_sentence_makes_a_message_but_no_review(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, RIGHT)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/1")
    assert len(db.get_messages(sid)) == 1
    assert _review_rows() == []


def test_grading_the_same_sentence_again_asks_no_model_and_adds_no_row(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    model = Model(monkeypatch, WRONG)
    first = client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0").json()
    second = client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0").json()
    assert second == first
    assert len(model.calls) == 1
    assert len(db.get_messages(sid)) == 1
    assert len(_review_rows()) == 1


def test_grade_round_two_is_kept_only_in_timed_rounds(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    _upload(client, sid)
    Model(monkeypatch, WRONG)
    body = client.post(f"/api/sessions/{sid}/timed/rounds/2/grade/0").json()
    assert body["ok"] is False and body["fixed"] == WRONG["fixed"]
    assert db.get_messages(sid) == []
    assert _review_rows() == []
    one, two = db.get_rounds(sid)
    assert two["sentences"][0]["graded"] is True and two["sentences"][0]["message_id"] is None
    assert two["sentences"][0]["fixed"] == WRONG["fixed"]
    assert one["sentences"][0]["graded"] is False


def test_grade_when_the_model_fails_stays_ungraded_and_makes_no_row(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, llm.LLMError("down"))
    r = client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0")
    assert r.status_code == 200
    assert r.json()["ok"] is None and r.json()["text"] == "Last weekend I go to the park."
    assert db.get_rounds(sid)[0]["sentences"][0]["graded"] is False
    assert db.get_messages(sid) == []
    # and a retry that works grades it
    Model(monkeypatch, WRONG)
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0").json()["ok"] is False
    assert len(db.get_messages(sid)) == 1


def test_grade_passes_the_question_as_the_topic(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed(topic="What did you do last weekend?")
    _upload(client, sid)
    model = Model(monkeypatch, RIGHT)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0")
    assert "What did you do last weekend?" in json.dumps(model.calls[0]["messages"], ensure_ascii=False)


def test_grade_missing_round_or_sentence_is_404(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, RIGHT)
    assert client.post(f"/api/sessions/{sid}/timed/rounds/3/grade/0").status_code == 404
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/2").status_code == 404
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/-1").status_code == 404


def test_native_round_one_stores_the_level(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, NATIVE)
    body = client.post(f"/api/sessions/{sid}/timed/rounds/1/native").json()
    assert body["native"] == NATIVE["native"] and body["level"] == "intermediate"
    assert body["audio_key"]
    [rnd] = db.get_rounds(sid)
    assert rnd["native"] == NATIVE["native"] and rnd["level"] == "intermediate"


def test_native_round_two_stores_no_level(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    _upload(client, sid)
    Model(monkeypatch, NATIVE)
    body = client.post(f"/api/sessions/{sid}/timed/rounds/2/native").json()
    assert body["level"] is None
    assert db.get_rounds(sid)[1]["level"] is None
    assert db.get_rounds(sid)[1]["native"] == NATIVE["native"]


def test_native_is_given_the_fixed_sentences_and_the_question(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, WRONG)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0")
    model = Model(monkeypatch, NATIVE)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/native")
    ask = model.calls[0]["messages"][-1]["content"]
    assert "Last weekend I went to the park." in ask and "I go to" not in ask
    assert "We ate sandwiches together." in ask
    assert "What did you do last weekend?" in ask


def test_native_is_asked_once_and_then_served_from_storage(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    model = Model(monkeypatch, NATIVE)
    first = client.post(f"/api/sessions/{sid}/timed/rounds/1/native").json()
    second = client.post(f"/api/sessions/{sid}/timed/rounds/1/native").json()
    assert second == first
    assert len(model.calls) == 1


@pytest.mark.parametrize("answer", [
    {"native": "Last weekend I went to the 공원 with friends.", "level": "beginner"},  # Korean leaked
    {"native": "   ", "level": "beginner"},
    {"native": " ".join(["word"] * 221), "level": "beginner"},                         # too long
    llm.LLMError("down"),
])
def test_native_503_and_nothing_stored_when_the_answer_is_unusable(client, monkeypatch, answer):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, answer)
    r = client.post(f"/api/sessions/{sid}/timed/rounds/1/native")
    assert r.status_code == 503
    assert r.json()["detail"] == api.TIMED_NATIVE_UNAVAILABLE
    assert db.get_rounds(sid)[0]["native"] is None


def test_native_japanese_needs_kana_and_has_a_450_character_cap(client, monkeypatch):
    Stt(monkeypatch, [{"start": 0.0, "end": 3.0, "text": "先週末は公園に行きました。"}])
    sid = _timed("ja", "先週末は何をしましたか。")
    _upload(client, sid)
    Model(monkeypatch, {"native": "我上周末去了公园。", "level": "beginner"})
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/native").status_code == 503
    Model(monkeypatch, {"native": "あ" * 451, "level": "beginner"})
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/native").status_code == 503
    Model(monkeypatch, {"native": "先週末は友だちと公園に行きました。", "level": "beginner"})
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/native").status_code == 200


def test_native_for_a_round_with_no_sentences_is_503_without_a_model_call(client, monkeypatch):
    Stt(monkeypatch, [])
    sid = _timed()
    _upload(client, sid)
    model = Model(monkeypatch, NATIVE)
    assert client.post(f"/api/sessions/{sid}/timed/rounds/1/native").status_code == 503
    assert model.calls == []


def test_native_prompt_few_shot_is_synthetic_and_the_schema_enumerates_levels():
    msgs = prompts.build_timed_native_messages("en", "Q?", ["A sentence here."], "beginner")
    assert msgs[0]["role"] == "system" and msgs[-1]["role"] == "user"
    assert json.loads(msgs[2]["content"])["native"] == prompts.TIMED_NATIVE_EXAMPLES["en"][2]["native"]
    assert "A sentence here." in msgs[-1]["content"]
    assert prompts.timed_native_schema()["properties"]["level"]["enum"] == list(config.LEVELS)
    ja = prompts.build_timed_native_messages("ja", "質問？", ["文です。"], "advanced")
    assert prompts.JAPANESE_SCRIPT_ONLY_RULE in ja[0]["content"]


@pytest.mark.parametrize("call", [
    lambda c, sid: _upload(c, sid),
    lambda c, sid: c.post(f"/api/sessions/{sid}/timed/rounds/1/transcribe"),
    lambda c, sid: c.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0"),
    lambda c, sid: c.post(f"/api/sessions/{sid}/timed/rounds/1/native"),
])
def test_an_ended_session_is_409_another_mode_is_400_and_no_session_is_404(client, monkeypatch, call):
    Stt(monkeypatch)
    Model(monkeypatch, RIGHT)
    sid = _timed()
    _upload(client, sid)
    db.end_session(sid, "{}", None)
    assert call(client, sid).status_code == 409
    other = db.create_session("en", "lesson", topic="weekend")
    assert call(client, other).status_code == 400
    assert call(client, 99999).status_code == 404


def test_an_upload_to_an_ended_session_writes_no_file(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    db.end_session(sid, "{}", None)
    assert _upload(client, sid).status_code == 409
    assert not (config.AUDIO_DIR / f"s{sid}_r1.webm").exists()


# ---------------------------------------------------------------------------
# a filler-only sentence is done, not retried forever; a round's length is real
# ---------------------------------------------------------------------------

FILLER_FIRST = [
    {"start": 0.0, "end": 1.0, "text": "Um."},
    {"start": 1.5, "end": 4.0, "text": "Last weekend I go to the park."},
]


def test_a_filler_only_sentence_is_graded_as_filler_with_no_model_call_and_no_row(client, monkeypatch):
    Stt(monkeypatch, FILLER_FIRST)
    sid = _timed()
    assert [s["text"] for s in _upload(client, sid).json()["sentences"]] == [
        "Um.", "Last weekend I go to the park."]
    model = Model(monkeypatch, WRONG)
    body = client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0").json()
    assert body == {"i": 0, "text": "Um.", "ok": None, "fixed": None, "correction": None,
                    "suggestion": None, "tag": None, "filler": True}
    assert model.calls == [], "a filler-only sentence must not reach the model"
    assert db.get_messages(sid) == []
    stored = db.get_rounds(sid)[0]["sentences"][0]
    assert stored["graded"] is True and stored["filler"] is True and stored["message_id"] is None

    again = client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0").json()
    assert again == body
    assert model.calls == []
    assert db.get_messages(sid) == []


@pytest.mark.parametrize("language,text", [("en", "Um"), ("en", "Uh, um..."), ("ja", "えーと。")])
def test_other_filler_only_shapes_count_too(language, text):
    assert api._is_filler_only(text, language)


def test_a_sentence_with_words_after_its_filler_is_not_filler():
    assert not api._is_filler_only("Um, I went home.", "en")


def test_the_native_prompt_leaves_filler_sentences_out(client, monkeypatch):
    Stt(monkeypatch, FILLER_FIRST)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, WRONG)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0")
    model = Model(monkeypatch, NATIVE)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/native")
    ask = model.calls[0]["messages"][-1]["content"]
    assert "Um." not in ask
    assert "Last weekend I go to the park." in ask


@pytest.mark.parametrize("seconds", ["nan", "inf", "-inf", "0", "-1", "500", "120.5"])
def test_upload_refuses_a_length_that_is_not_real_before_writing_anything(client, monkeypatch, seconds):
    fake = Stt(monkeypatch)
    sid = _timed()
    # Without the check, nan/inf crash inside the route (wpm, JSON); this client
    # turns that into a 500 so the test fails on its own assertion, not a traceback.
    r = _upload(TestClient(app, raise_server_exceptions=False), sid, seconds=seconds)
    assert r.status_code == 422
    assert not (config.AUDIO_DIR / f"s{sid}_r1.webm").exists()
    assert db.get_rounds(sid) == []
    assert fake.calls == 0


@pytest.mark.parametrize("seconds", ["0.5", "60", "120"])
def test_upload_takes_a_real_length_up_to_the_cap(client, monkeypatch, seconds):
    Stt(monkeypatch)
    sid = _timed()
    assert _upload(client, sid, seconds=seconds).status_code == 200


# ---------------------------------------------------------------------------
# ending a timed session: a report of every round, the level from round 1,
# recordings swept; GET /report rebuilds the same shape later
# ---------------------------------------------------------------------------

def test_end_timed_session_reports_every_round_level_from_round_one_and_sweeps_recordings(client, monkeypatch):
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    Model(monkeypatch, WRONG)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/0")
    Model(monkeypatch, RIGHT)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/grade/1")
    Model(monkeypatch, NATIVE)
    client.post(f"/api/sessions/{sid}/timed/rounds/1/native")

    _upload(client, sid)
    Model(monkeypatch, WRONG)
    client.post(f"/api/sessions/{sid}/timed/rounds/2/grade/0")
    Model(monkeypatch, {"native": "Round two native answer here.", "level": "advanced"})
    client.post(f"/api/sessions/{sid}/timed/rounds/2/native")

    body = client.post(f"/api/sessions/{sid}/end").json()
    assert body["kind"] == "timed"
    assert body["topic"] == "What did you do last weekend?"
    assert body["level"] == "intermediate"          # round 1's level, not round 2's
    assert [r["round"] for r in body["rounds"]] == [1, 2]
    r1, r2 = body["rounds"]
    assert r1["fixed"] == 1 and r1["graded"] == 2 and r1["native"] == NATIVE["native"]
    assert r2["fixed"] == 1 and r2["graded"] == 1 and r2["native"] == "Round two native answer here."
    assert body["stats"] == {"turns": 2, "wrong": 1, "minutes": 1}
    assert body["summary"] == "" and body["weak_points"] == [] and body["expressions"] == []

    assert not (config.AUDIO_DIR / f"s{sid}_r1.webm").exists()
    assert not (config.AUDIO_DIR / f"s{sid}_r2.webm").exists()
    assert all(r["audio_path"] is None for r in db.get_rounds(sid))

    again = client.get(f"/api/sessions/{sid}/report").json()
    assert again["kind"] == "timed" and again["rounds"] == body["rounds"]
    assert again["level"] == "intermediate"
    assert again["mode"] == "timed" and again["graded"] is True


def test_end_timed_session_with_no_rounds_has_empty_report_and_no_error(client):
    sid = _timed()
    body = client.post(f"/api/sessions/{sid}/end").json()
    assert body["kind"] == "timed" and body["rounds"] == [] and body["level"] is None
    assert body["stats"] == {"turns": 0, "wrong": 0, "minutes": 0}


def test_history_row_shows_round_count_for_timed_and_zero_for_other_modes(client, monkeypatch):
    Stt(monkeypatch)
    tsid = _timed()
    _upload(client, tsid)
    _upload(client, tsid)
    client.post(f"/api/sessions/{tsid}/end")
    other = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(other, "user", "hi", ok=1)
    db.end_session(other, json.dumps({"summary": "s"}), "beginner")
    items = client.get("/api/sessions/history?language=en").json()["items"]
    by_id = {i["id"]: i for i in items}
    assert by_id[tsid]["mode"] == "timed" and by_id[tsid]["rounds"] == 2
    assert by_id[other]["rounds"] == 0


# ---------------------------------------------------------------------------
# abandoned timed sessions: the stale sweep must collect round recordings too
# ---------------------------------------------------------------------------

def _age(sid, when="2020-01-01T00:00:00+00:00"):
    with db.connect() as conn:
        conn.execute("UPDATE sessions SET started_at = ? WHERE id = ?", (when, sid))
        conn.execute("UPDATE timed_rounds SET created_at = ? WHERE session_id = ?", (when, sid))
        conn.execute("UPDATE messages SET created_at = ? WHERE session_id = ?", (when, sid))


def test_resumable_sweep_deletes_an_abandoned_timed_sessions_round_recordings(client, monkeypatch):
    """A timed session keeps its audio in timed_rounds, not messages. The sweep
    must see it before abandon_stale_sessions closes the session, or the file
    is stranded on disk forever."""
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    clip = config.AUDIO_DIR / f"s{sid}_r1.webm"
    assert clip.exists()
    _age(sid)

    assert db.stale_open_sessions(hours=24) == [sid]
    assert client.get("/api/sessions/resumable?language=en").status_code == 200

    assert not clip.exists()
    assert db.get_rounds(sid)[0]["audio_path"] is None
    assert db.get_session(sid)["ended_at"] is not None


def test_a_timed_session_with_a_recent_round_is_not_stale(client, monkeypatch):
    """Activity in a timed session is its rounds: a session opened long ago
    whose latest round is fresh is still in use."""
    Stt(monkeypatch)
    sid = _timed()
    _upload(client, sid)
    with db.connect() as conn:
        conn.execute("UPDATE sessions SET started_at = '2020-01-01T00:00:00+00:00' WHERE id = ?", (sid,))
    assert db.stale_open_sessions(hours=24) == []
    assert db.abandon_stale_sessions(hours=24) == 0
    assert db.get_session(sid)["ended_at"] is None
