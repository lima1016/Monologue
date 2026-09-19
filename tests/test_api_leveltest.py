"""레벨 테스트 -- 서버 쪽. 받아쓰기·모델·음성은 전부 목(mock)이다.
docs/superpowers/specs/2026-09-19-monologue-level-test-design.md"""
import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import api, config, db, leveltest, llm, prompts, stt, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    db.init_db()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    monkeypatch.setattr(api, "_today", lambda: date(2026, 9, 19))
    return TestClient(app)


class Heard:
    """stt.transcribe stand-in: the uploaded bytes *are* what was heard, so a
    test says exactly what the learner repeated. Raises when told to."""
    def __init__(self, monkeypatch):
        self.fail = None
        self.calls = 0
        monkeypatch.setattr(stt, "transcribe", self)

    def __call__(self, audio, language):
        self.calls += 1
        if self.fail:
            raise self.fail
        return audio.decode("utf-8")


SEGMENTS = [
    {"start": 0.0, "end": 3.0, "text": "On weekends I usually sleep late."},
    {"start": 7.0, "end": 10.0, "text": "Then I meet my friends for lunch."},
]


class Segments:
    def __init__(self, monkeypatch, result=None):
        self.result = SEGMENTS if result is None else result
        monkeypatch.setattr(stt, "transcribe_segments", self)

    def __call__(self, audio, language):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class Model:
    """Queue of chat_json answers; records every call."""
    def __init__(self, monkeypatch, *answers):
        self.answers = list(answers)
        self.calls = []
        monkeypatch.setattr(llm, "chat_json", self)

    def __call__(self, messages, schema, **kw):
        self.calls.append({"messages": messages, "schema": schema})
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


def _judged(*cefrs, comment="주제를 잘 이었지만 표현이 조금 단순했어요."):
    return {"answers": [{"q": q, "cefr": c, "comment": comment} for q, c in enumerate(cefrs)]}


BANK = leveltest.load_bank("en")


def _start(client, language="en"):
    r = client.post("/api/level-test", json={"language": language})
    assert r.status_code == 200
    return r.json()


def _say(client, tid, i, heard):
    return client.post(f"/api/level-test/{tid}/items/{i}",
                       files={"file": ("i.webm", heard.encode("utf-8"), "audio/webm")})


def _answer(client, tid, q, seconds="45"):
    return client.post(f"/api/level-test/{tid}/answers/{q}", data={"seconds": seconds},
                       files={"file": ("a.webm", b"AUDIO", "audio/webm")})


def _repeat(client, tid, perfect=12, language="en"):
    """The first `perfect` sentences repeated exactly (4 each), the rest
    mumbled (0 each)."""
    for it in leveltest.load_bank(language)["items"]:
        assert _say(client, tid, it["i"], it["text"] if it["i"] < perfect else "x").status_code == 200


def _count(table):
    with db.connect() as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _finished_session(level):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    for _ in range(5):
        db.add_message(sid, "user", "I go", correction="설명", ok=0, fixed="I went.", tag="시제")
    db.end_session(sid, json.dumps({"summary": "좋았어요"}, ensure_ascii=False), level)


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

def test_start_sends_twelve_sentences_as_audio_only_and_two_questions(client):
    body = _start(client)
    assert body["test_id"] > 0
    assert [it["i"] for it in body["items"]] == list(range(12))
    for it in body["items"]:
        assert set(it) == {"i", "audio_key"}, "the original sentence must not reach the client"
        assert it["audio_key"]
    assert body["questions"] == [{"q": q["q"], "text": q["text"], "meaning": q["meaning"]}
                                 for q in BANK["questions"]]
    assert all(it["text"] not in json.dumps(body, ensure_ascii=False) for it in BANK["items"])


def test_no_voice_no_test_when_tts_is_down(client, monkeypatch):
    calls = []

    def down(*a):
        calls.append(a)
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", down)
    r = client.post("/api/level-test", json={"language": "en"})
    assert r.status_code == 503
    assert r.json()["detail"] == "지금은 문장 음성을 준비할 수 없어요"
    assert all(it["text"] not in r.text for it in BANK["items"])
    assert _count("level_tests") == 0, "a failed start leaves no test row"
    assert len(calls) == 1, "stops at the first voice it cannot make"


def test_a_voice_failing_partway_also_stops_the_start(client, monkeypatch):
    calls = []

    def fourth_fails(text, language, voice):
        calls.append(text)
        if len(calls) == 4:
            raise tts.TTSError("down")
        return b"RIFFfake"
    monkeypatch.setattr(tts, "synthesize", fourth_fails)
    assert client.post("/api/level-test", json={"language": "en"}).status_code == 503
    assert len(calls) == 4 and _count("level_tests") == 0


# ---------------------------------------------------------------------------
# repeating sentences
# ---------------------------------------------------------------------------

def test_twelve_perfect_repeats_make_c2_and_the_app_teaches_advanced(client, monkeypatch):
    Heard(monkeypatch)
    for _ in range(3):
        _finished_session("beginner")
    assert db.stable_level("en") == "beginner"
    tid = _start(client)["test_id"]
    _repeat(client, tid)
    r = client.post(f"/api/level-test/{tid}/finish")
    assert r.status_code == 200
    res = r.json()
    assert (res["cefr"], res["step"], res["app_level"]) == ("C2", "상위", "advanced")
    assert res["ei"] == {"score": 48, "max": 48, "by_level": {
        "A1": [8, 8], "A2": [8, 8], "B1": [12, 12], "B2": [12, 12], "C1": [8, 8]}}
    assert (res["ielts"], res["toefl"], res["jf"]) == ("8.5–9.0", {"band": "6.0", "old": "28–30"}, None)
    assert res["note"] == leveltest.NOTE
    assert res["answers"] == [] and res["test_id"] == tid and res["language"] == "en"
    assert res["finished_at"]
    # The test outranks three sessions that all said beginner.
    assert db.stable_level("en") == "advanced"
    assert db.stable_level("ja") is None


def test_the_test_level_holds_with_no_sessions_at_all(client, monkeypatch):
    Heard(monkeypatch)
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=6)   # 24 -> B1
    client.post(f"/api/level-test/{tid}/finish")
    assert db.stable_level("en") == "intermediate"


def test_finish_before_all_twelve_is_400(client, monkeypatch):
    Heard(monkeypatch)
    tid = _start(client)["test_id"]
    for it in BANK["items"][:11]:
        _say(client, tid, it["i"], it["text"])
    r = client.post(f"/api/level-test/{tid}/finish")
    assert r.status_code == 400
    assert r.json()["detail"] == "아직 따라 말하기가 끝나지 않았어요"
    assert db.latest_level_test("en") is None


def test_a_finished_test_takes_no_more_uploads(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    tid = _start(client)["test_id"]
    _repeat(client, tid)
    client.post(f"/api/level-test/{tid}/finish")
    assert _say(client, tid, 0, "x").status_code == 409
    assert _answer(client, tid, 0).status_code == 409
    assert db.get_level_test(tid)["items"][0]["score"] == 4


def test_finish_twice_returns_the_same_result_without_asking_the_model_again(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    model = Model(monkeypatch, _judged("B1", "B1"))
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=6)
    _answer(client, tid, 0)
    first = client.post(f"/api/level-test/{tid}/finish").json()
    assert len(model.calls) == 1
    second = client.post(f"/api/level-test/{tid}/finish").json()
    assert second == first
    assert len(model.calls) == 1


def test_stt_down_is_503_and_the_same_sentence_can_be_uploaded_again(client, monkeypatch):
    heard = Heard(monkeypatch)
    tid = _start(client)["test_id"]
    heard.fail = stt.SttUnavailable("loading")
    r = _say(client, tid, 3, BANK["items"][3]["text"])
    assert r.status_code == 503 and r.json()["detail"] == "받아쓰기를 할 수 없어요"
    heard.fail = RuntimeError("cuda")
    assert _say(client, tid, 3, BANK["items"][3]["text"]).status_code == 503
    assert db.get_level_test(tid)["items"] == {}
    heard.fail = None
    assert _say(client, tid, 3, "x").json() == {"i": 3, "done": True}
    assert db.get_level_test(tid)["items"][3]["score"] == 0
    _say(client, tid, 3, BANK["items"][3]["text"])
    assert db.get_level_test(tid)["items"] == {3: {"heard": BANK["items"][3]["text"], "score": 4}}


def test_unknown_test_or_item_is_404(client, monkeypatch):
    Heard(monkeypatch)
    tid = _start(client)["test_id"]
    assert _say(client, tid, 12, "x").status_code == 404
    assert _say(client, tid, -1, "x").status_code == 404
    assert _say(client, tid + 99, 0, "x").status_code == 404
    assert _answer(client, tid, 2).status_code == 404
    assert client.post(f"/api/level-test/{tid + 99}/finish").status_code == 404


def test_no_recording_is_kept(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    tid = _start(client)["test_id"]
    _repeat(client, tid)
    _answer(client, tid, 0)
    assert not config.AUDIO_DIR.exists() or not any(config.AUDIO_DIR.iterdir())


# ---------------------------------------------------------------------------
# answering the two questions
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("seconds", ["nan", "inf", "0", "-3", "61"])
def test_answer_seconds_must_be_a_real_length(client, monkeypatch, seconds):
    Segments(monkeypatch)
    tid = _start(client)["test_id"]
    assert _answer(client, tid, 0, seconds).status_code == 422
    assert db.get_level_test(tid)["answers"] == {}


def test_answer_is_transcribed_and_stored_with_its_stats(client, monkeypatch):
    Segments(monkeypatch)
    tid = _start(client)["test_id"]
    assert _answer(client, tid, 1, "30").json() == {"q": 1, "done": True}
    assert db.get_level_test(tid)["answers"] == {1: {
        "text": "On weekends I usually sleep late. Then I meet my friends for lunch.",
        "seconds": 30.0, "words": 13, "wpm": 26, "long_pauses": 1}}


def test_japanese_answer_sentences_join_without_spaces(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch, [{"start": 0.0, "end": 2.0, "text": "週末は寝ます。"},
                           {"start": 2.5, "end": 4.5, "text": "友達に会います。"}])
    model = Model(monkeypatch, _judged("A2"))
    tid = _start(client, "ja")["test_id"]
    _answer(client, tid, 0, "30")
    assert db.get_level_test(tid)["answers"][0]["text"] == "週末は寝ます。友達に会います。"
    _repeat(client, tid, language="ja")
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert res["answers"][0]["text"] == "週末は寝ます。友達に会います。"
    assert "답: 週末は寝ます。友達に会います。\n" in model.calls[0]["messages"][-1]["content"]


def test_one_recorded_answer_keeps_only_that_judgment(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    model = Model(monkeypatch, _judged("C1", "A1"))   # judges q0 and a q1 nobody recorded
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)
    _answer(client, tid, 1)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert [(a["q"], a["cefr"]) for a in res["answers"]] == [(1, "A1")]
    asked = model.calls[0]["messages"][-1]["content"]
    assert "답 1개를 각각 판정해 주세요." in asked and "두 답" not in asked
    assert BANK["questions"][0]["text"] not in asked


def test_an_upload_landing_after_finish_cannot_rewrite_the_test(client, monkeypatch):
    Heard(monkeypatch)
    tid = _start(client)["test_id"]
    _repeat(client, tid)
    client.post(f"/api/level-test/{tid}/finish")
    # The routes already 409 here; this is the write that was in flight past that check.
    db.set_level_item(tid, 0, "x", 0)
    db.set_level_answer(tid, 0, {"text": "late", "seconds": 1, "words": 1, "wpm": 60, "long_pauses": 0})
    test = db.get_level_test(tid)
    assert test["items"][0] == {"heard": BANK["items"][0]["text"], "score": 4}
    assert test["answers"] == {}


def test_answer_stt_down_is_503(client, monkeypatch):
    Segments(monkeypatch, stt.SttUnavailable("loading"))
    tid = _start(client)["test_id"]
    r = _answer(client, tid, 0)
    assert r.status_code == 503 and r.json()["detail"] == "받아쓰기를 할 수 없어요"
    assert db.get_level_test(tid)["answers"] == {}


def test_two_b2_answers_lift_a_28_over_the_b2_cut(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    model = Model(monkeypatch, _judged("B2", "B2"))
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)   # 7 x 4 = 28: B1, two short of B2
    _answer(client, tid, 0)
    _answer(client, tid, 1)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert res["ei"]["score"] == 28
    assert (res["cefr"], res["step"], res["app_level"]) == ("B2", "하위", "intermediate")
    assert (res["ielts"], res["toefl"]) == ("5.5–6.0", {"band": "4.0", "old": "20–22"})
    assert [(a["q"], a["cefr"], a["comment"]) for a in res["answers"]] == [
        (0, "B2", "주제를 잘 이었지만 표현이 조금 단순했어요."),
        (1, "B2", "주제를 잘 이었지만 표현이 조금 단순했어요.")]
    assert res["answers"][0]["wpm"] == 17 and res["answers"][0]["long_pauses"] == 1
    assert model.calls[0]["schema"] == prompts.level_answers_schema()
    asked = model.calls[0]["messages"][-1]["content"]
    assert BANK["questions"][0]["text"] in asked and "Then I meet my friends for lunch." in asked


def test_each_result_answer_carries_its_question(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    Model(monkeypatch, _judged("B1", "B1"))
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)
    _answer(client, tid, 1)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert [(a["q"], a["question"]) for a in res["answers"]] == [(1, BANK["questions"][1]["text"])]


def test_judging_failure_leaves_the_sentences_to_decide(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    Model(monkeypatch, RuntimeError("ollama down"))
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)
    _answer(client, tid, 0)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert (res["cefr"], res["step"]) == ("B1", "상위")
    assert [(a["q"], a["cefr"], a["comment"]) for a in res["answers"]] == [(0, None, None)]


def test_no_answers_means_no_model_call(client, monkeypatch):
    Heard(monkeypatch)
    model = Model(monkeypatch, _judged("C2", "C2"))
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert model.calls == [] and (res["cefr"], res["step"]) == ("B1", "상위")


def test_a_comment_that_is_not_korean_is_blanked_but_its_cefr_stays(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    Model(monkeypatch, {"answers": [
        {"q": 0, "cefr": "B2", "comment": "Good ideas, but the sentences were short."},
        {"q": 1, "cefr": "B2", "comment": "생각은 좋았지만 这个 문장이 짧았어요."},
        {"q": 7, "cefr": "A1", "comment": "없는 질문이에요."}]})
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)
    _answer(client, tid, 0)
    _answer(client, tid, 1)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert [(a["q"], a["cefr"], a["comment"]) for a in res["answers"]] == [(0, "B2", ""), (1, "B2", "")]
    assert res["cefr"] == "B2", "the labels still count toward the boundary rule"


JA_SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "週末はよく寝ます。"},
               {"start": 2.5, "end": 4.5, "text": "友達に会います。"}]


def _ja_finish(client, monkeypatch, *model_answers):
    Heard(monkeypatch)
    Segments(monkeypatch, JA_SEGMENTS)
    model = Model(monkeypatch, *model_answers)
    tid = _start(client, "ja")["test_id"]
    _repeat(client, tid, perfect=7, language="ja")
    _answer(client, tid, 0)
    return model, client.post(f"/api/level-test/{tid}/finish").json()


JA_COMMENT = {"answers": [{"q": 0, "cefr": "B1", "comment": "週末の話はよくできましたが、文が短いです。"}]}


def test_a_japanese_comment_is_asked_again_and_the_korean_retry_is_kept(client, monkeypatch):
    model, res = _ja_finish(client, monkeypatch, JA_COMMENT, {"answers": [
        {"q": 0, "cefr": "B1", "comment": "주말 이야기는 잘 전했지만 문장이 짧았어요."}]})
    assert len(model.calls) == 2
    assert model.calls[1]["messages"][-1]["content"] == prompts.LEVEL_ANSWERS_RETRY
    assert model.calls[1]["messages"][-2] == {"role": "assistant",
                                              "content": json.dumps(JA_COMMENT, ensure_ascii=False)}
    assert [(a["cefr"], a["comment"]) for a in res["answers"]] == [("B1", "주말 이야기는 잘 전했지만 문장이 짧았어요.")]


def test_a_comment_leaking_twice_is_blank_and_the_model_is_asked_only_twice(client, monkeypatch):
    model, res = _ja_finish(client, monkeypatch, JA_COMMENT, JA_COMMENT)
    assert len(model.calls) == 2
    assert [(a["cefr"], a["comment"]) for a in res["answers"]] == [("B1", "")]


@pytest.mark.parametrize("retry", [RuntimeError("ollama down"), {"answers": []}])
def test_the_first_label_stands_when_the_retry_fails_or_leaves_it_out(client, monkeypatch, retry):
    model, res = _ja_finish(client, monkeypatch, JA_COMMENT, retry)
    assert len(model.calls) == 2
    assert [(a["cefr"], a["comment"]) for a in res["answers"]] == [("B1", "")]


def test_a_korean_comment_quoting_the_answer_is_kept_without_a_retry(client, monkeypatch):
    model, res = _ja_finish(client, monkeypatch, {"answers": [
        {"q": 0, "cefr": "B1", "comment": "「週末」 이야기를 잘 전했지만 문장이 짧았어요."}]})
    assert len(model.calls) == 1
    assert res["answers"][0]["comment"] == "「週末」 이야기를 잘 전했지만 문장이 짧았어요."


def test_the_answers_prompt_says_comments_are_korean_even_for_japanese():
    msgs = prompts.build_level_answers_messages("ja", [
        {"q": 0, "question": "週末は何をしますか。", "text": "寝ます。", "wpm": 20, "long_pauses": 2}])
    assert "답이 일본어여도 comment는 반드시 한국어로 씁니다." in msgs[0]["content"]


def test_a_label_outside_cefr_is_not_a_judgment(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    Model(monkeypatch, {"answers": [{"q": 0, "cefr": "intermediate", "comment": "좋아요, 다만 짧아요."}]})
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=7)
    _answer(client, tid, 0)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert res["answers"][0]["cefr"] is None and res["cefr"] == "B1"


def test_japanese_result_uses_jf_and_no_english_exam(client, monkeypatch):
    Heard(monkeypatch)
    tid = _start(client, "ja")["test_id"]
    _repeat(client, tid, perfect=12, language="ja")
    res = client.post(f"/api/level-test/{tid}/finish").json()
    assert (res["cefr"], res["ielts"], res["toefl"], res["jf"]) == ("C2", None, None, "JF 스탠다드 C2")
    assert db.stable_level("ja") == "advanced" and db.stable_level("en") is None


# ---------------------------------------------------------------------------
# not practice
# ---------------------------------------------------------------------------

def test_the_test_writes_no_practice_rows_and_moves_no_practice_stats(client, monkeypatch):
    Heard(monkeypatch)
    Segments(monkeypatch)
    Model(monkeypatch, _judged("B1", "B1"))
    _finished_session("beginner")
    before = client.get("/api/stats/mypage?language=en").json()
    counts = {t: _count(t) for t in ("sessions", "messages", "review_queue")}
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=9)
    _answer(client, tid, 0)
    _answer(client, tid, 1)
    client.post(f"/api/level-test/{tid}/finish")
    after = client.get("/api/stats/mypage?language=en").json()
    assert {t: _count(t) for t in counts} == counts
    for key in ("accuracy", "tags", "review"):
        assert after[key] == before[key]


# ---------------------------------------------------------------------------
# latest result and mypage
# ---------------------------------------------------------------------------

def test_latest_is_the_newest_finished_test_only(client, monkeypatch):
    Heard(monkeypatch)
    assert client.get("/api/level-test/latest?language=en").json() == {"result": None}
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=6)
    done = client.post(f"/api/level-test/{tid}/finish").json()
    later = _start(client)["test_id"]      # started, never finished
    _say(client, later, 0, BANK["items"][0]["text"])
    assert client.get("/api/level-test/latest?language=en").json() == {"result": done}
    assert db.latest_level_test("en")["id"] == tid
    assert client.get("/api/level-test/latest?language=ja").json() == {"result": None}


def test_a_newer_finished_test_replaces_the_level(client, monkeypatch):
    Heard(monkeypatch)
    first = _start(client)["test_id"]
    _repeat(client, first, perfect=12)
    client.post(f"/api/level-test/{first}/finish")
    second = _start(client)["test_id"]
    _repeat(client, second, perfect=2)
    client.post(f"/api/level-test/{second}/finish")
    assert db.stable_level("en") == "beginner"
    assert client.get("/api/level-test/latest?language=en").json()["result"]["test_id"] == second


def test_mypage_level_shows_the_test_even_on_a_thin_sample(client, monkeypatch):
    Heard(monkeypatch)
    _finished_session("beginner")
    level = client.get("/api/stats/mypage?language=en").json()["level"]
    assert level["value"] is None and level["test"] is None
    tid = _start(client)["test_id"]
    _repeat(client, tid, perfect=12)
    res = client.post(f"/api/level-test/{tid}/finish").json()
    level = client.get("/api/stats/mypage?language=en").json()["level"]
    assert level["value"] == "advanced"
    assert level["test"] == {"cefr": "C2", "step": "상위", "ielts": "8.5–9.0",
                             "toefl": {"band": "6.0", "old": "28–30"}, "jf": None,
                             "finished_at": res["finished_at"]}
    assert level["sessions"] == 1


# ---------------------------------------------------------------------------
# prompt and migration
# ---------------------------------------------------------------------------

def test_answers_prompt_is_korean_with_one_synthetic_example():
    qa = [{"q": 0, "question": "Tell me about your weekend.", "text": "I sleep.", "wpm": 20,
           "long_pauses": 2}]
    msgs = prompts.build_level_answers_messages("en", qa)
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
    assert "영어" in msgs[0]["content"] and "A1" in msgs[0]["content"] and "60자" in msgs[0]["content"]
    example = json.loads(msgs[2]["content"])
    assert all(api._is_korean_meaning(a["comment"]) for a in example["answers"])
    assert "I sleep." in msgs[3]["content"] and "Tell me about your weekend." in msgs[3]["content"]
    assert "일본어" in prompts.build_level_answers_messages("ja", qa)[0]["content"]
    schema = prompts.level_answers_schema()
    assert schema["properties"]["answers"]["items"]["properties"]["cefr"]["enum"] == list(leveltest.CEFR)


def test_v9_database_migrates_to_v10_keeping_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(sid, "user", "I go", correction="c", ok=0, fixed="I went.", tag="시제")
    with db.connect() as conn:
        conn.execute("DROP TABLE level_tests")
        conn.execute("PRAGMA user_version = 9")
    db.init_db()
    assert db.schema_version() == 10
    assert db.latest_level_test("en") is None
    assert db.wrong_tag_counts("en")[0]["n"] == 1
    tid = db.create_level_test("en")
    assert db.get_level_test(tid)["items"] == {} and db.get_level_test(tid)["result"] is None
