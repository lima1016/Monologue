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
