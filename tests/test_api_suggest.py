"""💡 뭐라고 하지? -- 서버 쪽. 모델은 전부 목(mock)이다."""
import pytest

from app import api


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
