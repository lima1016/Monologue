from app.text_match import normalize


def test_strips_the_full_punctuation_set_the_js_twin_lists():
    """static/js/match.js's normalize() lists this exact punctuation set in its
    PUNCT regex; app.text_match.normalize is its Python twin and must strip
    the same characters, or the two drift apart silently."""
    text = "a.b,c!d?e;f:g'h\"i(j)k[l]m{n}o-p–q—r…s·t、u。v！w？x「y」z『a』b（c）"
    assert normalize(text) == "abcdefghijklmnopqrstuvwxyzabc"


def test_lowercases_and_collapses_whitespace():
    assert normalize("  Hello   World  ") == "hello world"


def test_none_and_empty_input_are_empty_strings():
    assert normalize(None) == ""
    assert normalize("") == ""


def test_punctuation_is_deleted_not_spaced_so_contractions_stay_one_word():
    assert normalize("don't") == "dont"


def test_punctuation_is_deleted_not_spaced_so_japanese_gets_no_invented_boundary():
    assert normalize("おはよう、ございます") == \
        normalize("おはようございます")


def test_the_learners_real_punctuation_only_pairs_normalize_equal():
    pairs = [
        ("I finished the login bug and started on the report screen",
         "I finished the login bug and started on the report screen."),
        ("Yeah give me a sec okay I'm ready",
         "Yeah, give me a sec, okay? I'm ready."),
        ("Card please", "Card, please."),
        ("i went there", "I went there."),
        ("おはようございます",
         "おはようございます。"),
    ]
    for spoken, fixed in pairs:
        assert normalize(spoken) == normalize(fixed), (spoken, fixed)


def test_the_learners_real_genuinely_different_pairs_stay_different():
    pairs = [
        ("Will do thanks", "I will do it, thanks."),
        ("Not really I might need a review on the pool recastulator",
         "Not really, I might need a review of the pool recirculator."),
        ("私は学生です", "私が学生です"),
    ]
    for spoken, fixed in pairs:
        assert normalize(spoken) != normalize(fixed), (spoken, fixed)
