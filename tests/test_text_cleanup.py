from app.text_cleanup import clean_for_tts, strip_fillers


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


# The learner's actual failing case: speech recognition heard a stray "Uh"
# before the mis-heard word, and the grading model read "Windows" as the
# operating system rather than a mis-hearing of "window".
def test_strip_fillers_removes_the_learners_actual_stray_uh():
    text = "I'd like to take a seat Uh Windows"
    assert strip_fillers(text, "en") == "I'd like to take a seat Windows"


def test_strip_fillers_removes_standalone_english_disfluencies():
    # Browser speech recognition never returns punctuation (see api._feedback),
    # so a filler sits between bare words with no comma either side.
    assert strip_fillers("Um I think so", "en") == "I think so"
    assert strip_fillers("It was uh really good", "en") == "It was really good"
    assert strip_fillers("Er hmm let me think", "en") == "let me think"


def test_strip_fillers_leaves_real_english_words_alone():
    """like, well, so are real words doing real work -- never strip them."""
    assert strip_fillers("I like it", "en") == "I like it"
    assert strip_fillers("Well done", "en") == "Well done"
    assert strip_fillers("I was so tired", "en") == "I was so tired"


def test_strip_fillers_does_not_touch_filler_substrings_inside_real_words():
    assert strip_fillers("Grab an umbrella", "en") == "Grab an umbrella"
    assert strip_fillers("Run faster", "en") == "Run faster"


def test_strip_fillers_removes_narrow_japanese_disfluencies():
    assert strip_fillers("えーと、レストランに行きたいです", "ja") == "レストランに行きたいです"


def test_strip_fillers_drops_the_separator_stranded_by_a_removed_filler():
    """A filler removed from the front can leave the punctuation that
    followed it stranded, e.g. "er, I think so" -> ", I think so" without
    this cleanup. ASR never actually returns punctuation (see api._feedback),
    so this should not arise in practice, but the leftover is tidied anyway."""
    assert strip_fillers("er, I think so", "en") == "I think so"
    assert strip_fillers("えっとわかりません", "ja") == "わかりません"


def test_strip_fillers_leaves_ano_alone():
    """あの is a real demonstrative/hedge, indistinguishable from a filler
    token by text alone -- stripping it would delete meaning some of the time."""
    assert strip_fillers("あの人は先生です", "ja") == "あの人は先生です"


def test_strip_fillers_of_pure_filler_returns_empty():
    assert strip_fillers("Uh um", "en") == ""
    assert strip_fillers("えーと", "ja") == ""


def test_strip_fillers_empty_input_returns_empty():
    assert strip_fillers("", "en") == ""
