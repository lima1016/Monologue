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
