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
    monkeypatch.setattr("app.api.stt.status", lambda: "ready")
    body = client.get("/api/health").json()
    assert body == {"ollama": True, "voicevox": False, "whisper": "ready"}


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


@pytest.mark.parametrize("title", [",$咖啡店點餐", "They Said No!", ""])
def test_a_generated_title_that_is_not_korean_falls_back_to_the_wish(client, monkeypatch, title):
    monkeypatch.setattr("app.api.llm.chat_json", lambda messages, schema, **kw: {
        "title": title, "goal": "g", "persona_prompt": "You are a moving company clerk.",
    })
    r = client.post("/api/scenarios/generate",
                    json={"language": "en", "mode": "free", "wish": " 이사 업체에 견적 묻기 "})
    assert r.status_code == 200 and r.json()["title"] == "이사 업체에 견적 묻기"


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


def test_generate_retries_a_script_that_fails_the_check_once(client, monkeypatch):
    good = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"Line {i} okay."} for i in range(16)]
    answers = iter([{"title": "t", "lines": good[:15]}, {"title": "t", "lines": good}])
    calls = []
    def fake(messages, schema, **kw):
        calls.append(1)
        return next(answers)
    monkeypatch.setattr("app.api.llm.chat_json", fake)
    r = client.post("/api/scenarios/generate", json={"language": "en", "mode": "script", "wish": "cafe"})
    assert r.status_code == 200 and len(calls) == 2


def test_generate_gives_up_after_the_second_bad_script(client, monkeypatch):
    bad = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"Line {i}."} for i in range(15)]
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {"title": "t", "lines": bad})
    r = client.post("/api/scenarios/generate", json={"language": "en", "mode": "script", "wish": "cafe"})
    assert r.status_code == 422
    assert r.json()["detail"] == "줄 수가 맞지 않아요"


def _sixteen(**changes):
    lines = [{"speaker": "bot" if i % 2 == 0 else "user", "text": f"Line {i} okay."} for i in range(16)]
    for i, line in changes.items():
        lines[int(i[1:])] = line
    return lines


@pytest.mark.parametrize("lines,detail", [
    (_sixteen(l0={"speaker": "user", "text": "Hi."}), "대사 순서가 맞지 않아요"),
    (_sixteen(l3={"speaker": "user", "text": "좋아요."}), "다른 언어가 섞였어요"),
    (_sixteen(l3={"speaker": "user", "text": " ".join(["word"] * 21)}), "너무 긴 줄이 있어요"),
])
def test_generate_says_in_korean_what_was_wrong_with_the_script(client, monkeypatch, lines, detail):
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {"title": "t", "lines": lines})
    r = client.post("/api/scenarios/generate", json={"language": "en", "mode": "script", "wish": "cafe"})
    assert r.status_code == 422 and r.json()["detail"] == detail


def test_generate_rejects_a_non_object_script_result_instead_of_crashing(client, monkeypatch):
    """chat_json's contract is 'parsed as JSON', not 'parsed as an object' -- a
    model can hand back a bare list. That must fail the check (and retry, then
    422) like any other bad generation, not crash with a 500 on .get()."""
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: ["not", "an", "object"])
    r = client.post("/api/scenarios/generate", json={"language": "en", "mode": "script", "wish": "cafe"})
    assert r.status_code == 422
    assert r.json()["detail"] == "줄 수가 맞지 않아요"


def test_home_stats_route_returns_the_computed_counters(client):
    sid = db.create_session("en", "free")
    db.add_message(sid, "user", "hello")
    body = client.get("/api/stats/home", params={"language": "en"}).json()
    assert body == {"streak": 1, "week_turns": 1, "fixed_total": 0, "top_tags": [],
                     "recent": []}


def test_home_stats_recent_always_has_a_title(client):
    free = db.create_session(language="en", mode="free", scenario_id=None, topic=None)
    topical = db.create_session(language="en", mode="lesson", scenario_id=None,
                                topic="과거형 연습")
    db.end_session(free, "{}", "beginner")
    db.end_session(topical, "{}", "beginner")

    recent = client.get("/api/stats/home?language=en").json()["recent"]
    by_id = {r["id"]: r for r in recent}

    assert by_id[topical]["title"] == "과거형 연습"
    assert by_id[free]["title"] == "자유 대화"
