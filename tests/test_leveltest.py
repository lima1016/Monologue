import pytest

from app import leveltest


def test_bank_has_twelve_graded_items_and_two_questions_per_language():
    for lang in ("en", "ja"):
        bank = leveltest.load_bank(lang)
        assert [it["cefr"] for it in bank["items"]] == ["A1", "A1", "A2", "A2", "B1", "B1", "B1", "B2", "B2", "B2", "C1", "C1"]
        assert [it["i"] for it in bank["items"]] == list(range(12))
        assert [q["q"] for q in bank["questions"]] == [0, 1]
        assert all(q["meaning"] for q in bank["questions"])


# target "I drink coffee every morning." normalizes to 5 words, so word-level edits
# only land on similarity 1.0/0.8/0.6/0.4/0.2/0.0 -- each heard below is picked so its
# real text_match.similarity() value actually sits in the tier the expected score names.
@pytest.mark.parametrize("heard,points", [
    ("I drink coffee every morning.", 4),
    ("i drink coffee every morning", 4),        # case/punctuation ignored
    ("I drink coffee every day.", 3),           # 1 word off of 5 -> 0.8
    ("I coffee morning", 2),                    # 2 insertions needed -> 0.6
    ("coffee morning", 1),                      # 3 insertions needed -> 0.4
    ("", 0),
    (None, 0),
])
def test_item_score_english(heard, points):
    assert leveltest.item_score(heard, "I drink coffee every morning.", "en") == points


def test_item_score_japanese_by_characters():
    assert leveltest.item_score("毎朝コーヒーを飲みます", "毎朝コーヒーを飲みます。", "ja") == 4


# 10-word target gives 0.1 granularity, so a single wrong word lands on similarity
# exactly 0.9 -- above the 0.8 floor but below the 0.95 one, so this must score 3.
# It exists to catch a sabotaged 0.95 floor (e.g. loosened to 0.9), which would wrongly
# score it 4.
def test_item_score_boundary_just_below_the_four_point_floor():
    target = "one two three four five six seven eight nine ten"
    heard = "one two three four five six seven eight nine eleven"
    assert leveltest.item_score(heard, target, "en") == 3


@pytest.mark.parametrize("score,expected", [
    (0, ("A1", "하위")), (4, ("A1", "하위")), (5, ("A1", "상위")), (9, ("A1", "상위")),
    (10, ("A2", "하위")), (19, ("A2", "상위")), (20, ("B1", "하위")), (24, ("B1", "하위")), (25, ("B1", "상위")),
    (29, ("B1", "상위")), (30, ("B2", "하위")), (38, ("B2", "상위")), (39, ("C1", "하위")), (44, ("C1", "상위")),
    (45, ("C2", "하위")), (48, ("C2", "상위")),
])
def test_cefr_cuts(score, expected):
    assert leveltest.cefr_from_ei(score) == expected


def test_answers_level_is_the_floor_of_the_mean():
    assert leveltest.answers_level(["B1", "B2"]) == "B1"
    assert leveltest.answers_level(["B2", "B2"]) == "B2"
    assert leveltest.answers_level(["C1"]) == "C1"
    assert leveltest.answers_level([]) is None
    assert leveltest.answers_level(["??"]) is None


@pytest.mark.parametrize("score,answers,expected", [
    (28, "B2", ("B2", "하위")),     # 2 below the B2 cut, answers say B2 -> up one
    (29, "C1", ("B2", "하위")),     # up one level only
    (27, "B2", ("B1", "상위")),     # 3 below the cut -> no move
    (28, "B1", ("B1", "상위")),     # answers agree -> no move
    (20, "A2", ("A2", "상위")),     # just above the B1 cut, answers lower -> down one
    (21, "A1", ("A2", "상위")),
    (22, "A2", ("B1", "하위")),     # 2 above the cut -> no move
    (28, None, ("B1", "상위")),
    (46, "C2", ("C2", "하위")),     # nothing above C2
    (1, "A1", ("A1", "하위")),      # nothing below A1
])
def test_boundary_moves_one_level_only_near_a_cut(score, answers, expected):
    cefr, step = leveltest.cefr_from_ei(score)
    assert leveltest.apply_boundary(score, cefr, step, answers) == expected


def test_english_conversions_follow_the_official_tables():
    c = leveltest.conversions("B1", "상위", "en")
    assert c["ielts"] == "4.5–5.0" and c["toefl"] == {"band": "3.5", "old": "18–19"} and c["jf"] is None
    assert leveltest.conversions("A2", "하위", "en")["ielts"] == "4.0 미만"
    assert leveltest.conversions("A2", "하위", "en")["toefl"] == {"band": "2.0", "old": "10–12"}
    assert leveltest.conversions("C2", "상위", "en")["toefl"] == {"band": "6.0", "old": "28–30"}
    assert "공식 점수가 아니에요" in c["note"]


def test_japanese_has_jf_and_no_jlpt_conversion():
    c = leveltest.conversions("B2", "하위", "ja")
    assert c["jf"] == "JF 스탠다드 B2" and c["ielts"] is None and c["toefl"] is None and "JLPT" in c["note"]


def test_app_level_and_by_level():
    assert [leveltest.app_level(c) for c in leveltest.CEFR] == ["beginner", "beginner", "intermediate",
                                                                "intermediate", "advanced", "advanced"]
    items = leveltest.load_bank("en")["items"]
    got = leveltest.by_level([4, 3, 4, 2, 3, 3, 1, 2, 0, 1, 0, 0], items)
    assert got == {"A1": [7, 8], "A2": [6, 8], "B1": [7, 12], "B2": [3, 12], "C1": [0, 8]}
