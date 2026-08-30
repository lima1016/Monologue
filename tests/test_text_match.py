import re
from pathlib import Path

from app.text_match import PUNCT, normalize

_MATCH_JS = Path(__file__).resolve().parent.parent / "static" / "js" / "match.js"


def _class_chars(class_body: str) -> set[str]:
    """The literal characters a `[...]` character class body (no outer
    brackets) matches, unescaping `\\x` to `x`. Safe for PUNCT specifically
    because none of its entries is a range like `a-z` -- the hyphen is always
    escaped -- so a backslash here always means "the next character,
    literally", never "start of a range"."""
    chars = set()
    i = 0
    while i < len(class_body):
        c = class_body[i]
        if c == "\\" and i + 1 < len(class_body):
            chars.add(class_body[i + 1])
            i += 2
        else:
            chars.add(c)
            i += 1
    return chars


def _js_punct_chars() -> set[str]:
    src = _MATCH_JS.read_text(encoding="utf-8")
    m = re.search(r"const PUNCT = /(\[.*\])/g;", src)
    assert m, ("static/js/match.js's PUNCT literal moved or changed shape --"
               " update this test's extraction regex to match")
    return _class_chars(m.group(1)[1:-1])


def _python_punct_chars() -> set[str]:
    pattern = PUNCT.pattern
    assert pattern[0] == "[" and pattern[-1] == "]"
    return _class_chars(pattern[1:-1])


def test_the_punctuation_set_matches_its_js_twin_character_for_character():
    """app.text_match.PUNCT and static/js/match.js's PUNCT are twins by design
    (see both files' docstrings) and there is no build step to share them, so
    this is what turns editing the punctuation set in one file and forgetting
    the other into a failing test instead of a silent split between the app's
    Python and JS halves.

    Compares the *character set* each regex matches, not the raw source text
    -- the two escape differently (JS escapes `-` as `\\-` for the same
    reason Python does, but escapes and literal placement otherwise differ),
    so a byte-for-byte comparison would fail for a reason that is not drift.
    """
    js_chars = _js_punct_chars()
    py_chars = _python_punct_chars()
    assert py_chars == js_chars, (
        "app.text_match.PUNCT and static/js/match.js's PUNCT have drifted apart. "
        "They are twins by design and must list the same punctuation characters "
        "-- edit both files together, not just one.\n"
        f"Python-only characters: {py_chars - js_chars or '(none)'}\n"
        f"JS-only characters: {js_chars - py_chars or '(none)'}"
    )


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
