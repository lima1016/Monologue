import pytest

from app import reading


def test_romaji_uses_hepburn_for_the_sounds_that_differ():
    """헵번식이 아니면 학습자가 앱 밖에서 본 표기와 어긋난다.
    훈령식은 si/ti/tu로 적지만, 교재와 도로 표지판은 shi/chi/tsu다."""
    assert reading.to_romaji("シ") == "shi"
    assert reading.to_romaji("チ") == "chi"
    assert reading.to_romaji("ツ") == "tsu"
    assert reading.to_romaji("フ") == "fu"
    assert reading.to_romaji("ジ") == "ji"


def test_romaji_handles_youon_as_one_sound():
    """キャ는 ki+ya가 아니라 한 음절이다. 두 글자를 따로 변환하면 kiya가 되어
    학습자가 두 박자로 읽게 된다."""
    assert reading.to_romaji("キャ") == "kya"
    assert reading.to_romaji("ショ") == "sho"
    assert reading.to_romaji("チュ") == "chu"


def test_romaji_doubles_the_consonant_after_a_small_tsu():
    assert reading.to_romaji("ガッコウ") == "gakkou"
    assert reading.to_romaji("キッテ") == "kitte"


def test_romaji_repeats_the_vowel_for_a_long_mark():
    """ー는 앞 모음을 늘인다. 매크론(ō) 대신 모음을 반복하는 편이
    초보에게 가나와의 대응이 눈에 보인다."""
    assert reading.to_romaji("コーヒー") == "koohii"


def test_romaji_returns_none_for_nothing_to_convert():
    assert reading.to_romaji(None) is None
    assert reading.to_romaji("") is None


def test_ruby_sits_only_over_the_kanji():
    """사전은 토큰 전체의 읽기(タベル)를 준다. 그대로 올리면 이미 읽을 수 있는
    'べる' 위에까지 가나가 붙어, 보조가 오히려 읽기를 방해한다."""
    assert reading.align("食べる", "たべる") == [
        {"text": "食", "ruby": "た"},
        {"text": "べる", "ruby": None},
    ]


def test_ruby_is_not_added_when_there_is_no_kanji():
    assert reading.align("よやく", "よやく") == [{"text": "よやく", "ruby": None}]


def test_a_leading_kana_is_stripped_too():
    assert reading.align("お店", "おみせ") == [
        {"text": "お", "ruby": None},
        {"text": "店", "ruby": "みせ"},
    ]


def test_two_kanji_runs_fall_back_to_rubying_the_whole_token():
    """取り引き처럼 한자 덩어리가 둘이면 어느 읽기가 어느 덩어리 것인지
    가나만으로는 가를 수 없다. 여기서 영리해지려다 틀린 읽기를 만드는 것이
    최악이다 -- 틀린 읽기를 배우면 안 배우느니만 못하다. 통째로 올린 읽기는
    정확하지 않아도 정직하고, 여전히 읽을 수 있다."""
    assert reading.align("取り引き", "とりひき") == [
        {"text": "取り引き", "ruby": "とりひき"}
    ]


def test_a_reading_that_does_not_match_the_surface_falls_back():
    """읽기가 표기와 아귀가 안 맞으면(사전이 이상한 것을 줬거나 표기가 바뀌었거나)
    억지로 자르지 않는다."""
    assert reading.align("東京", "とうきょう") == [
        {"text": "東京", "ruby": "とうきょう"}
    ]


def test_align_with_no_reading_gives_plain_text():
    assert reading.align("ABC", None) == [{"text": "ABC", "ruby": None}]


def test_analyse_romanises_the_topic_particle_as_wa_not_ha():
    """는 조사 は는 항상 '와'로 읽는다. kana(표기)는 ハ지만 pron(발음)은 ワ다.
    이걸 놓치면 학습자가 일본어에서 가장 자주 나오는 조사를 잘못 배운다."""
    tokens = reading.analyse("私は学生です")
    romaji = " ".join(t["romaji"] for t in tokens if t["romaji"])
    assert "wa" in romaji.split()
    assert "ha" not in romaji.split()


def test_analyse_romanises_the_direction_particle_as_e_not_he():
    tokens = reading.analyse("学校へ行きます")
    romaji = " ".join(t["romaji"] for t in tokens if t["romaji"])
    assert "e" in romaji.split()
    assert "he" not in romaji.split()


def test_analyse_still_romanises_a_long_vowel_word_with_the_written_form():
    """pron은 장음을 'ー'로 뭉뚱그려서(ガッコー) kana(ガッコウ)와 다르게 적는다.
    pron에 'ー'가 있으면 kana로 돌아가야 学校가 gakkoo가 되지 않는다."""
    tokens = reading.analyse("学校")
    assert tokens[0]["romaji"] == "gakkou"


def test_analyse_reads_the_ha_inside_a_greeting_as_wa():
    """こんにちは의 は도 조사 は와 같은 이유로 '와'다. 예전 규칙은 품사가 助詞일
    때만 발음을 봐서, 감동사 하나로 굳은 이 인사말이 konnichiha로 나왔다."""
    tokens = reading.analyse("こんにちは")
    assert tokens[0]["romaji"] == "konnichiwa"


def test_analyse_keeps_the_written_vowels_of_arigatou_and_toukyou():
    assert reading.analyse("ありがとう")[0]["romaji"] == "arigatou"
    assert reading.analyse("東京")[0]["romaji"] == "toukyou"


def test_analyse_romanises_the_object_particle_as_o():
    tokens = reading.analyse("コーヒーを飲む")
    assert [t["romaji"] for t in tokens[:2]] == ["koohii", "o"]


def test_analyse_returns_one_token_per_word_with_parts():
    tokens = reading.analyse("寿司を食べる")
    assert [t["surface"] for t in tokens] == ["寿司", "を", "食べる"]
    assert tokens[0]["parts"] == [{"text": "寿司", "ruby": "すし"}]
    assert tokens[1]["parts"] == [{"text": "を", "ruby": None}]
    assert tokens[2]["parts"] == [{"text": "食", "ruby": "た"},
                                  {"text": "べる", "ruby": None}]
    assert tokens[0]["romaji"] == "sushi"


def test_analyse_never_raises_when_the_dictionary_is_unavailable(monkeypatch):
    """사전이 없다고 학습자의 줄이 비면 안 된다. 보조가 없는 것과
    줄이 사라지는 것은 다른 문제다."""
    monkeypatch.setattr(reading, "_tagger", _boom)
    tokens = reading.analyse("寿司を食べる")
    assert tokens == [{"surface": "寿司を食べる", "reading": None, "romaji": None, "hangul": None,
                       "parts": [{"text": "寿司を食べる", "ruby": None}]}]


def _boom():
    raise RuntimeError("no dictionary")


def test_analyse_of_empty_text_is_empty():
    assert reading.analyse("") == []


def test_analyse_keeps_ascii_whitespace_the_dictionary_drops():
    """MeCab은 공백을 표면형으로 돌려주지 않는다 -- 그대로 두면 화면의 줄이
    음성이 실제로 말하는 원문과 달라진다(공백이 사라진다). 이 불변식이
    이걸 지킨다: 토큰의 text를 모두 이어붙이면 반드시 원문과 같아야 한다."""
    for text in [
        "こんにちは 世界",
        "Wi-Fi は使えますか",
        "田中さん、\nおはよう",
        "\tご注文は\tこちらです",
        "  先頭と末尾に空白  ",
        "Hello World",
        "",
    ]:
        tokens = reading.analyse(text)
        rebuilt = "".join(p["text"] for t in tokens for p in t["parts"])
        assert rebuilt == text, f"{text!r} -> {rebuilt!r}"


def test_analyse_recovers_from_a_bad_token_without_losing_the_rest(monkeypatch):
    """토큰 하나의 정렬이 실패해도 문장 전체가 사라지면 안 된다 -- 그 토큰만
    평문으로 떨어지고 나머지는 읽기를 그대로 유지해야 한다."""
    real_align = reading.align

    def flaky_align(surface, reading_kana):
        if surface == "食べる":
            raise RuntimeError("boom")
        return real_align(surface, reading_kana)

    monkeypatch.setattr(reading, "align", flaky_align)
    tokens = reading.analyse("寿司を食べる")

    assert tokens[0]["parts"] == [{"text": "寿司", "ruby": "すし"}]
    assert tokens[1]["parts"] == [{"text": "を", "ruby": None}]
    assert tokens[2] == {
        "surface": "食べる", "reading": None, "romaji": None, "hangul": None,
        "parts": [{"text": "食べる", "ruby": None}],
    }


def test_ruby_is_not_added_to_kana_that_merely_fails_to_match_its_reading():
    """읽기가 표기와 안 맞아도, 표기 자체에 한자가 없으면 루비를 붙이지
    않는다. 이미 읽을 수 있는 가나 위에 불완전한 읽기가 얹히는 것이
    한자가 없을 때 지켜야 할 4번 규칙의 핵심이다."""
    assert reading.align("あいう", "あい") == [{"text": "あいう", "ruby": None}]


def test_ruby_is_kept_when_the_core_mixes_kanji_with_non_kana_characters():
    """숫자는 가나가 아니지만 한자도 아니다 -- '한자가 없다'를 '가나가
    아니다'로 잘못 판정하면 100円 같은 표기의 루비가 사라진다."""
    assert reading.align("100円", "ひゃくえん") == [
        {"text": "100円", "ruby": "ひゃくえん"}
    ]


@pytest.mark.parametrize("pron, hangul", [
    ("アリガトー", "아리가토오"),   # 장음은 앞 모음을 한 번 더
    ("ガッコー", "갓코오"),         # 촉음은 앞 글자의 ㅅ 받침
    ("トーキョー", "토오쿄오"),
    ("コンニチワ", "콘니치와"),     # ん은 ㄴ 받침
    ("センセー", "센세에"),
    ("オハヨー", "오하요오"),
    ("ツクエ", "쓰쿠에"),
    ("コーヒー", "코오히이"),
    ("シャシン", "샤신"),           # 요음은 한 음절
    ("キョー", "쿄오"),
    ("チュー", "추우"),
    ("ジャ", "자"),
    ("ニュース", "뉴우스"),
    ("リョコー", "료코오"),
    ("ファイル", "파이루"),         # 외래어 작은 모음
    ("ティー", "티이"),
    ("ウィ", "위"),
    ("ミッツ", "밋쓰"),
    ("ラーメン", "라아멘"),
    ("イッ", "잇"),                 # 言っ -- 토큰 끝의 촉음도 받침으로 남는다
    ("ワ", "와"),
    ("オ", "오"),
])
def test_hangul_follows_the_sound(pron, hangul):
    """소리 나는 대로다. か행은 늘 거센소리(카), が행은 예사소리(가)로 적어
    맑은소리와 흐린소리가 한글에서도 갈린다."""
    assert reading.to_hangul(pron) == hangul


def test_hangul_returns_none_for_nothing_to_convert():
    assert reading.to_hangul(None) is None
    assert reading.to_hangul("") is None


def test_analyse_gives_each_word_a_hangul_reading_from_its_pronunciation():
    """로마자와 달리 한글은 늘 발음(pron)을 따른다 -- 장음을 모음 반복으로 적으니
    pron의 'ー'를 피할 이유가 없다."""
    assert reading.analyse("ありがとう")[0]["hangul"] == "아리가토오"
    assert reading.analyse("学校")[0]["hangul"] == "갓코오"
    assert reading.analyse("こんにちは")[0]["hangul"] == "콘니치와"
    particle = [t for t in reading.analyse("私は学生です") if t["surface"] == "は"][0]
    assert particle["hangul"] == "와"
