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
    from app import api, llm
    api._cached_translation.cache_clear()
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


def test_a_failed_translation_is_not_remembered(client, monkeypatch):
    """실패는 캐시하지 않는다. 일본어 줄의 상당수가 두 번 새서 실패하는데, 그
    실패가 남으면 그 줄은 서버를 재시작할 때까지 영영 503이다 -- 대본 패널의
    줄과 같은 말풍선, 이어서 하기까지 전부."""
    from app import api, llm
    api._cached_translation.cache_clear()
    answers = iter(["好久等了", "好久等了", "오래 기다리셨습니다"])
    calls = []

    def chat(messages, **kw):
        calls.append(messages)
        return next(answers)

    monkeypatch.setattr(llm, "chat", chat)
    body = {"language": "ja", "text": "お待たせしました。"}
    assert client.post("/api/translate", json=body).status_code == 503
    res = client.post("/api/translate", json=body)
    assert res.status_code == 200
    assert res.json()["meaning"] == "오래 기다리셨습니다"
    assert len(calls) == 3


def test_translate_says_so_when_the_model_returns_nothing(client, monkeypatch):
    """빈 문자열은 실패가 아니라 성공처럼 보이지만, 뜻이 원래 없는 줄과
    구분되지 않으므로 503으로 취급해야 한다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "")
    res = client.post("/api/translate", json={"language": "ja", "text": "こんにちは"})
    assert res.status_code == 503


def test_translate_says_so_when_the_model_returns_only_whitespace(client, monkeypatch):
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "   \n  \n")
    res = client.post("/api/translate", json={"language": "ja", "text": "こんにちは"})
    assert res.status_code == 503


def test_translate_keeps_only_the_first_line(client, monkeypatch):
    """모델이 뜻에 괄호 설명이나 두 번째 문장을 덧붙여도 첫 줄만 뜻으로 쓴다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(
        llm, "chat",
        lambda messages, **kw: "어서 오세요\n(직역: 잘 오셨습니다)",
    )
    res = client.post("/api/translate", json={"language": "ja", "text": "いらっしゃいませ"})
    assert res.status_code == 200
    assert res.json()["meaning"] == "어서 오세요"


@pytest.mark.parametrize("leak", [
    "好久等了，请问几位？",                      # 통째로 중국어
    "안녕하세요, 예약은 되셨나요? 오늘은几位呢？",  # 한국어로 시작해 중국어로 샘
    "좋은 아침입니다. 오늘 참 일찍 일어난 거ですね.",  # 일본어 원문이 섞여 나옴
    "вашего 비행기는 20분 후에 12번 게이트에서 탑승합니다.",  # 영어 줄에서 실제로 나온 키릴 문자
])
def test_translate_refuses_a_meaning_in_the_wrong_language(client, monkeypatch, leak):
    """규칙만 있던 프롬프트의 탐침(실제 모델, 87회 중 47회 샘)에서 나온 모양
    그대로다. 틀린 언어로 뜻을
    보여주느니 503 -- 학습자는 중국어 뜻을 한국어 뜻으로 믿을 수 없다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: leak)
    res = client.post("/api/translate", json={"language": "ja", "text": "こんにちは"})
    assert res.status_code == 503


@pytest.mark.parametrize("meaning", [
    "PDF를 USB로 주세요",                 # 영문 약어는 글자로 세면 한글보다 많아진다
    "API와 SDK 문서를 GitHub에서 확인",
    "ㅋㅋ 진짜요?",                        # 호환 자모도 한글이다
    "카페 라테 말고 café 주세요",            # 라틴-1 글자는 외국 문자가 아니다
    "ＯＫ, 알겠습니다",                     # 전각 영문도 영문이다
    "'I'm fine'은 괜찮다는 뜻이에요",
])
def test_a_korean_meaning_with_latin_words_is_korean(meaning):
    from app import api
    assert api._is_korean_meaning(meaning)


@pytest.mark.parametrize("leak", [
    "손님, “请问几位”?",       # 따옴표 안이라도 한자는 가르치는 표현이 아니라 새는 중이다
    '손님, "请问几位"?',
    "손님, '请问几位'?",
    "don't 请问几位 isn't 괜찮아요 정말 괜찮아요",  # 낱말 속 아포스트로피가 인용을 열면 안 된다
    "don't вашего isn't 괜찮아요 정말 괜찮아요",   # 한자가 없어도 마찬가지
])
def test_quoting_does_not_hide_a_leak(leak):
    from app import api
    assert not api._is_korean_meaning(leak)


def test_translate_asks_once_more_when_the_first_answer_leaks(client, monkeypatch):
    """프롬프트 탐침(실제 모델, 일본어 87회, 탐침 자체의 한국어 판정)에서 한 번
    되묻기가 한국어 뜻을 56%에서 79%로 올렸다. 앱의 실제 경로로는 75%다
    (test_translate_quality.py)."""
    from app import api, llm
    api._cached_translation.cache_clear()
    answers = iter(["오늘은几位呢？", "오늘은 몇 분이세요?"])
    calls = []

    def chat(messages, **kw):
        calls.append(messages)
        return next(answers)

    monkeypatch.setattr(llm, "chat", chat)
    res = client.post("/api/translate", json={"language": "ja", "text": "今日は何名様ですか？"})
    assert res.status_code == 200
    assert res.json()["meaning"] == "오늘은 몇 분이세요?"
    assert len(calls) == 2
    assert calls[1][-2] == {"role": "assistant", "content": "오늘은几位呢？"}


def test_translate_does_not_ask_again_when_the_first_answer_is_korean(client, monkeypatch):
    from app import api, llm
    api._cached_translation.cache_clear()
    calls = []

    def chat(messages, **kw):
        calls.append(kw)
        return "오늘은 몇 분이세요?"

    monkeypatch.setattr(llm, "chat", chat)
    client.post("/api/translate", json={"language": "ja", "text": "今日は何名様ですか？"})
    assert len(calls) == 1
    assert calls[0].get("max_tokens"), "번역 호출에 길이 상한이 없다"


def test_translate_gives_up_after_the_second_leak(client, monkeypatch):
    from app import api, llm
    api._cached_translation.cache_clear()
    calls = []

    def chat(messages, **kw):
        calls.append(messages)
        return "好久等了，请问几位？"

    monkeypatch.setattr(llm, "chat", chat)
    res = client.post("/api/translate", json={"language": "ja", "text": "お待たせしました。"})
    assert res.status_code == 503
    assert len(calls) == 2


def test_translate_allows_a_quoted_japanese_word_in_the_meaning(client, monkeypatch):
    """수업 대사는 일본어 표현 자체를 가르친다. 따옴표로 인용한 가나는 누출이 아니다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(llm, "chat",
                        lambda messages, **kw: '"たぶん"은 확신이 없을 때 쓰는 말이에요.')
    res = client.post("/api/translate", json={"language": "ja", "text": "「たぶん」を使ってみましょう。"})
    assert res.status_code == 200


def test_translate_gives_english_lines_a_korean_meaning(client, monkeypatch):
    from app import api, llm
    api._cached_translation.cache_clear()
    seen = []

    def chat(messages, **kw):
        seen.append(messages)
        return "몇 분이세요?"

    monkeypatch.setattr(llm, "chat", chat)
    res = client.post("/api/translate", json={"language": "en", "text": "How many are in your party?"})
    assert res.status_code == 200
    assert res.json()["meaning"] == "몇 분이세요?"
    assert "영어" in seen[0][0]["content"]


def test_translate_refuses_an_english_line_echoed_back_in_english(client, monkeypatch):
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "How many people are in your party?")
    res = client.post("/api/translate", json={"language": "en", "text": "How many are in your party?"})
    assert res.status_code == 503


def test_translate_caches_per_language(client, monkeypatch):
    """같은 문자열이라도 언어가 다르면 다른 요청이다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    calls = []

    def chat(messages, **kw):
        calls.append(messages[0]["content"])
        return "좋아요"

    monkeypatch.setattr(llm, "chat", chat)
    client.post("/api/translate", json={"language": "ja", "text": "OK"})
    client.post("/api/translate", json={"language": "en", "text": "OK"})
    assert len(calls) == 2


def test_reading_prefs_default_to_both_on(client):
    """기본은 셋 다 켜짐이다(뜻만 접힘). 완전 초보가 첫 화면에서
    아무것도 설정하지 않고도 읽을 수 있어야 한다."""
    res = client.get("/api/reading-prefs")
    assert res.status_code == 200
    assert res.json() == {"furigana": True, "romaji": True, "pron_script": "hangul"}


def test_reading_prefs_round_trip(client):
    """로마자를 끄는 것은 '가나를 읽을 수 있게 됐다'는 신호다.
    목발을 순서대로 치우는 것이 이 기능의 설계다."""
    client.post("/api/reading-prefs", json={"furigana": True, "romaji": False, "pron_script": "romaji"})
    assert client.get("/api/reading-prefs").json() == {
        "furigana": True, "romaji": False, "pron_script": "romaji",
    }


def test_reading_prefs_saved_without_a_script_keep_hangul(client):
    """표기 선택이 생기기 전의 요청 모양(두 필드)도 받아야 한다."""
    res = client.post("/api/reading-prefs", json={"furigana": True, "romaji": True})
    assert res.status_code == 200
    assert client.get("/api/reading-prefs").json()["pron_script"] == "hangul"


def test_reading_prefs_refuse_an_unknown_script(client):
    res = client.post("/api/reading-prefs", json={"furigana": True, "romaji": True, "pron_script": "katakana"})
    assert res.status_code == 422


def test_a_quoted_kanji_expression_from_the_line_itself_is_a_quote_not_a_leak():
    """수업 대사는 한자 표현 자체를 가르친다("大丈夫"는 괜찮다는 뜻). 인용한 한자가
    원문 줄에 실제로 있는 문자열이면 인용이고, 원문에 없는 한자는 새는 중이다."""
    from app import api
    line = "「大丈夫」は「괜찮다」という意味です。"
    assert api._is_korean_meaning('"大丈夫"는 괜찮다는 뜻이에요.', source=line)
    assert not api._is_korean_meaning('"大丈夫"는 괜찮다는 뜻이에요.', source="こんにちは")
    assert not api._is_korean_meaning("손님, “请问几位”?", source="何名様ですか？")


def test_translate_passes_the_original_line_to_the_korean_check(client, monkeypatch):
    from app import api, llm
    api._cached_translation.cache_clear()
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: '"大丈夫"는 괜찮다는 뜻이에요.')
    res = client.post("/api/translate", json={"language": "ja", "text": "「大丈夫」を使ってみましょう。"})
    assert res.status_code == 200


def test_quoting_the_whole_line_back_is_an_echo_not_a_quote():
    """인용 예외는 표현 하나 크기일 때만이다. 원문 줄을 통째로 따옴표에 넣고
    '는 뜻이에요'만 붙이면 번역하지 않은 줄을 뜻으로 내보내게 된다."""
    from app import api
    line = "「大丈夫」を使ってみましょう。"
    assert not api._is_korean_meaning(f'"{line}"는 뜻이에요', source=line)
    assert not api._is_korean_meaning('"大丈夫を使ってみましょう"라는 뜻입니다', source="大丈夫を使ってみましょう")
