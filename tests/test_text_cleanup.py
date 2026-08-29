from app.text_cleanup import clean_for_tts


def test_strips_markdown_emphasis_but_keeps_words():
    assert clean_for_tts("That's **really** good and *fine*") == "That's really good and fine"


def test_strips_backticks_and_headings():
    assert clean_for_tts("## Note\nUse `git status` now") == "Note Use git status now"


def test_strips_list_markers():
    assert clean_for_tts("- first\n- second") == "first second"
    assert clean_for_tts("1. first\n2. second") == "first second"


def test_removes_emoji():
    assert clean_for_tts("Nice work 👍🎉 today") == "Nice work today"


def test_removes_parenthetical_asides():
    assert clean_for_tts("Sure (as I said before), let's go") == "Sure, let's go"


def test_collapses_whitespace_and_newlines():
    assert clean_for_tts("Hello   there\n\n  friend") == "Hello there friend"


def test_truncates_at_a_sentence_boundary_when_over_the_cap():
    text = "One sentence here. Two sentence here. Three sentence here."
    assert clean_for_tts(text, max_chars=25) == "One sentence here."


def test_hard_truncates_when_no_sentence_boundary_fits():
    assert clean_for_tts("a" * 100, max_chars=10) == "a" * 10


def test_japanese_text_survives_untouched():
    text = "いらっしゃいませ。ご予約はされていますか？"
    assert clean_for_tts(text) == text


def test_japanese_sentence_truncation_uses_ideographic_period():
    text = "いらっしゃいませ。ご予約はされていますか？窓際もあります。"
    assert clean_for_tts(text, max_chars=12) == "いらっしゃいませ。"


def test_empty_and_whitespace_input_return_empty():
    assert clean_for_tts("") == ""
    assert clean_for_tts("   \n  ") == ""
