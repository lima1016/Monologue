from datetime import date

import pytest

from app import config, library
from app import db


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


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    return db


def _add(store, n, theme="hotel", language="en"):
    store.add_library_scenario({"id": f"lib-{theme}-{language}-{n:02d}", "theme_id": theme, "situation": "s",
                                "language": language, "type": "script", "title": f"t{n}",
                                "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})


def test_pick_prefers_a_script_never_played(store):
    for n in (1, 2, 3):
        _add(store, n)
    store.create_session("en", "script", scenario_id="lib-hotel-en-01")
    store.create_session("en", "script", scenario_id="lib-hotel-en-03")
    assert library.pick_script("en", "hotel")["id"] == "lib-hotel-en-02"


def test_pick_chooses_randomly_among_the_unplayed(store):
    for n in (1, 2, 3):
        _add(store, n)
    import random
    picks = {library.pick_script("en", "hotel", rng=random.Random(seed))["id"] for seed in range(30)}
    assert picks == {"lib-hotel-en-01", "lib-hotel-en-02", "lib-hotel-en-03"}


def test_when_all_were_played_pick_the_one_played_longest_ago(store, monkeypatch):
    for n in (1, 2):
        _add(store, n)
    times = iter(["2026-09-05T00:00:00+00:00", "2026-09-01T00:00:00+00:00"])
    monkeypatch.setattr(db, "_now", lambda: next(times))
    store.create_session("en", "script", scenario_id="lib-hotel-en-01")
    store.create_session("en", "script", scenario_id="lib-hotel-en-02")
    assert library.pick_script("en", "hotel")["id"] == "lib-hotel-en-02"


def test_pick_is_scoped_to_language_and_theme_and_empty_is_none(store):
    _add(store, 1, theme="hotel", language="ja")
    assert library.pick_script("en", "hotel") is None
    assert library.pick_script("ja", "cafe-restaurant") is None


def test_free_setup(store):
    store.add_library_scenario({"id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None,
                                "language": "en", "type": "free", "title": "호텔", "goal": "g",
                                "persona_prompt": "p", "max_turns": 16})
    assert library.free_setup("en", "hotel")["id"] == "lib-hotel-en-free"
    assert library.free_setup("ja", "hotel") is None


@pytest.mark.parametrize("title,expected", [
    ("카페에서 주문하기", "카페에서 주문하기"),
    ("  호텔 체크인  ", "호텔 체크인"),
    (",$咖啡店點餐", "상황"),               # Chinese with a junk prefix (seen from qwen2.5)
    ("They Said No!", "상황"),              # English
    ("カフェで注文", "상황"),                 # Japanese kana
    ("커피 注文하기", "상황"),                # Hangul mixed with an ideograph
    ("", "상황"),
    (None, "상황"),
    (["not", "text"], "상황"),
])
def test_korean_title(title, expected):
    assert library.korean_title(title, " 상황 ") == expected


def test_korean_title_is_capped():
    long = "아주 긴 제목 " * 10
    got = library.korean_title(long, "상황")
    assert len(got) <= 40 and got.startswith("아주 긴 제목") and got == got.strip()


def test_theme_of():
    assert library.theme_of("lib-cafe-restaurant-ja-07") == "cafe-restaurant"
    assert library.theme_of("lib-hotel-en-free") == "hotel"
    assert library.theme_of("restaurant-seating-en") is None
    assert library.theme_of("user-abc123") is None
    assert library.theme_of(None) is None


def test_reason_for():
    today = date(2026, 9, 14)
    assert library.reason_for(None, today) == "아직 안 해본 테마예요"
    assert library.reason_for(date(2026, 9, 14), today) == "오늘도 한 번 더 해볼까요?"
    assert library.reason_for(date(2026, 9, 13), today) == "어제 연습했어요"
    assert library.reason_for(date(2026, 9, 9), today) == "5일 전에 마지막으로 했어요"


def _ready(store, theme, language="en", scripts=1, free=False):
    for n in range(1, scripts + 1):
        store.add_library_scenario({"id": f"lib-{theme}-{language}-{n:02d}", "theme_id": theme, "situation": "s",
                                    "language": language, "type": "script", "title": "t",
                                    "lines": [{"speaker": "bot", "text": "Hi."}, {"speaker": "user", "text": "Hey."}]})
    if free:
        store.add_library_scenario({"id": f"lib-{theme}-{language}-free", "theme_id": theme, "situation": None,
                                    "language": language, "type": "free", "title": "t", "goal": "g",
                                    "persona_prompt": "p", "max_turns": 16})


def _played(store, monkeypatch, scenario_id, stamp, mode="script"):
    monkeypatch.setattr(db, "_now", lambda: stamp)
    store.create_session(scenario_id.split("-")[-2], mode, scenario_id=scenario_id)


def test_recommend_empty_library_is_empty(store):
    assert library.recommend("en", date(2026, 9, 14)) == []


def test_recommend_only_ready_themes_and_carries_theme_fields(store):
    _ready(store, "hotel", scripts=2, free=True)
    recs = library.recommend("en", date(2026, 9, 14))
    assert len(recs) == 1
    r = recs[0]
    assert (r["theme_id"], r["title"], r["category"]) == ("hotel", "호텔", "travel")
    assert r["situations"][0] == "체크인"
    assert r["ready"] == {"free": True, "script": 2}
    assert r["reason"] == "아직 안 해본 테마예요"


def test_recommend_does_not_hydrate_full_scenario_rows(store, monkeypatch):
    """Pins the perf fix: recommend() must answer readiness from
    db.library_readiness's single grouped query, never by hydrating every
    script's full row (lines_json included) through library_scenarios."""
    _ready(store, "hotel", scripts=2, free=True)

    def _boom(*a, **k):
        raise AssertionError("recommend must not call db.library_scenarios")

    monkeypatch.setattr(db, "library_scenarios", _boom)
    recs = library.recommend("en", date(2026, 9, 14))
    assert recs[0]["ready"] == {"free": True, "script": 2}


def test_recommend_prefers_themes_never_played(store, monkeypatch):
    for theme in ("hotel", "cafe-restaurant", "meetings"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-hotel-en-01", "2026-09-01T03:00:00+00:00")
    _played(store, monkeypatch, "lib-meetings-en-01", "2026-09-02T03:00:00+00:00")
    assert library.recommend("en", date(2026, 9, 14))[0]["theme_id"] == "cafe-restaurant"


def test_when_everything_was_played_recommend_the_older_half(store, monkeypatch):
    for theme in ("hotel", "shopping", "meetings", "interview"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-hotel-en-01", "2026-09-01T03:00:00+00:00")
    _played(store, monkeypatch, "lib-shopping-en-01", "2026-09-02T03:00:00+00:00")
    _played(store, monkeypatch, "lib-meetings-en-01", "2026-09-12T03:00:00+00:00")
    _played(store, monkeypatch, "lib-interview-en-01", "2026-09-13T03:00:00+00:00")
    first = library.recommend("en", date(2026, 9, 14))[0]
    assert first["theme_id"] in {"hotel", "shopping"}
    assert first["reason"].endswith("일 전에 마지막으로 했어요")


def test_recommend_avoids_the_category_just_practised_when_it_can(store, monkeypatch):
    for theme in ("meetings", "interview", "hotel"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-standup-en-01", "2026-09-13T03:00:00+00:00")   # business, not ready but played
    for seed_day in range(1, 20):
        first = library.recommend("en", date(2026, 9, seed_day))[0]
        assert first["category"] == "travel", seed_day


def test_recommend_prefers_never_played_even_in_the_last_practised_category(store, monkeypatch):
    """Spec step 3 (pool: never-played, else oldest half) runs before step 4
    (prefer another category within that pool) -- not the other way around.
    Here the only never-played themes are business, and business is also the
    category just practised: a category-first filter would strand them as
    the alternative forever and hand the big card to an old daily/travel/
    smalltalk theme instead."""
    for theme in ("cafe-restaurant", "hotel", "first-meeting", "standup", "meetings", "phone-email"):
        _ready(store, theme)
    _played(store, monkeypatch, "lib-cafe-restaurant-en-01", "2026-09-01T03:00:00+00:00")
    _played(store, monkeypatch, "lib-hotel-en-01", "2026-09-02T03:00:00+00:00")
    _played(store, monkeypatch, "lib-first-meeting-en-01", "2026-09-03T03:00:00+00:00")
    _played(store, monkeypatch, "lib-standup-en-01", "2026-09-04T03:00:00+00:00")  # most recent, business
    for seed_day in range(1, 20):
        first = library.recommend("en", date(2026, 9, seed_day))[0]
        assert first["theme_id"] in {"meetings", "phone-email"}, seed_day
        assert first["reason"] == "아직 안 해본 테마예요", seed_day


def test_recommend_is_stable_within_a_day(store):
    for theme in ("hotel", "shopping", "meetings", "interview", "hobbies", "first-meeting"):
        _ready(store, theme)
    day = date(2026, 9, 14)
    assert library.recommend("en", day) == library.recommend("en", day)
    days = {library.recommend("en", date(2026, 9, d))[0]["theme_id"] for d in range(1, 29)}
    assert len(days) > 1, "the pick should vary across days"


def test_the_alternative_comes_from_another_category_when_possible(store):
    for theme in ("hotel", "airport-flight", "meetings"):
        _ready(store, theme)
    for d in range(1, 15):
        recs = library.recommend("en", date(2026, 9, d))
        assert len(recs) == 2
        assert recs[0]["theme_id"] != recs[1]["theme_id"]
        if recs[0]["category"] == "travel":
            assert recs[1]["category"] == "business"
