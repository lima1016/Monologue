import pytest

from app import config, library


def _script(texts, speakers=None):
    speakers = speakers or ["bot" if i % 2 == 0 else "user" for i in range(len(texts))]
    return [{"speaker": s, "text": t} for s, t in zip(speakers, texts)]


EN16 = [f"Line number {i} here." for i in range(16)]
JA16 = [f"これは{i}番目のセリフです。" for i in range(16)]


def test_there_are_twenty_themes_five_per_category():
    themes = library.load_themes()
    assert len(themes) == 20
    for cat in config.THEME_CATEGORIES:
        assert sum(t["category"] == cat for t in themes) == 5
    assert len({t["id"] for t in themes}) == 20
    assert all(t["title"] and len(t["situations"]) >= 3 for t in themes)


def test_get_theme():
    assert library.get_theme("hotel")["title"] == "호텔"
    assert library.get_theme("nope") is None


def test_a_good_sixteen_line_script_passes():
    assert library.check_script(_script(EN16), "en") is None
    assert library.check_script(_script(JA16), "ja") is None


def test_line_count_must_be_exact():
    assert library.check_script(_script(EN16[:15]), "en") == "line-count"
    assert library.check_script(_script(EN16 + ["Extra one."]), "en") == "line-count"
    assert library.check_script(_script(EN16[:8]), "en", expected_lines=8) is None


def test_structure_bot_first_and_alternating():
    assert library.check_script(_script(EN16, ["user", "bot"] * 8), "en") == "structure"
    speakers = ["bot", "user"] * 8
    speakers[3] = "bot"
    assert library.check_script(_script(EN16, speakers), "en") == "structure"
    bad = _script(EN16)
    bad[4]["text"] = ""
    assert library.check_script(bad, "en") == "structure"


@pytest.mark.parametrize("language,index,text", [
    ("en", 2, "Sure, 좋아요."),
    ("en", 2, "Sure, 没问题."),
    ("en", 2, "はい、わかりました。"),
    ("en", 2, "1234 !!"),
    ("ja", 2, "はい、좋아요。"),
    ("ja", 2, "OKです。"),
    ("ja", 2, "ＯＫです。"),
])
def test_language_is_checked_per_line(language, index, text):
    lines = _script(EN16 if language == "en" else JA16)
    lines[index]["text"] = text
    assert library.check_script(lines, language) == "language"


def test_japanese_needs_kana_somewhere_but_not_on_every_line():
    lines = _script(JA16)
    lines[3]["text"] = "了解。"
    assert library.check_script(lines, "ja") is None
    kanji_only = _script(["我想要咖啡。"] * 16)
    assert library.check_script(kanji_only, "ja") == "language"


def test_line_length_limits():
    lines = _script(EN16)
    lines[1]["text"] = " ".join(["word"] * 20)
    assert library.check_script(lines, "en") is None
    lines[1]["text"] = " ".join(["word"] * 21)
    assert library.check_script(lines, "en") == "too-long"
    ja = _script(JA16)
    ja[1]["text"] = "あ" * 45 + "。、"
    assert library.check_script(ja, "ja") is None
    ja[1]["text"] = "あ" * 46
    assert library.check_script(ja, "ja") == "too-long"


def test_same_opening_line_as_an_existing_script_is_a_duplicate():
    existing = [_script(["Hi there, welcome in!"] + [f"Other {i} words." for i in range(15)])]
    new = _script(["hi there welcome in"] + [f"Totally new line {i}." for i in range(15)])
    assert library.check_script(new, "en", existing) == "same-opening"


def test_a_script_too_similar_to_an_existing_one_is_a_duplicate():
    base = [f"The quick brown fox number {i} jumps." for i in range(16)]
    near = list(base)
    near[0] = "A different opening line entirely."
    near[5] = "The quick brown fox number 5 leaps."
    assert library.check_script(_script(near), "en", [_script(base)]) == "too-similar"
    far = [f"Completely unrelated sentence {i * 7} about tea." for i in range(16)]
    assert library.check_script(_script(far), "en", [_script(base)]) is None


def test_duplicate_checks_can_be_switched_off():
    base = _script(EN16)
    assert library.check_script(_script(EN16), "en", [base], check_duplicates=False) is None


def test_default_max_turns_is_sixteen_and_builtin_free_scenarios_follow():
    import json
    assert config.DEFAULT_MAX_TURNS == 16
    items = json.loads((config.DATA_DIR / "scenarios.json").read_text(encoding="utf-8"))
    assert all(i["max_turns"] == 16 for i in items if i["type"] == "free")
