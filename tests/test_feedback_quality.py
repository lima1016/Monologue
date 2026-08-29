"""Feedback quality against the real model. Runs only under `-m engine`.

These are threshold tests, not exact-match tests: the model is sampled, so a
single wrong tag is not a regression. The thresholds are set below what the
spike measured (en 10/10 Korean, 8/10 tag; ja 8/8 both) so normal variance
does not fail the build, but a prompt regression does.
"""
import re

import pytest

from app import llm, prompts

pytestmark = pytest.mark.engine

CASES = [
    ("en", "I go store yesterday.", False, "시제"),
    ("en", "She have two cat.", False, "단복수"),
    ("en", "I am interested on music.", False, "전치사"),
    ("en", "Yesterday I to the park went.", False, "어순"),
    ("en", "I want to buy car.", False, "관사"),
    ("en", "My father is a doctor.", True, "없음"),
    ("en", "Could you tell me where the station is?", True, "없음"),
    ("ja", "きのう、レストランに行きます。", False, "시제"),
    ("ja", "わたしは学校で行きます。", False, "조사"),
    ("ja", "毎日ジムに行くします。", False, "활용"),
    ("ja", "友達と映画を見ました。", True, "없음"),
    ("ja", "すみません、駅はどこですか。", True, "없음"),
]


def _hangul(text):
    return len(re.findall(r"[가-힣]", text or ""))


def _ask(language, sentence):
    return llm.chat_json(prompts.build_feedback_messages(language, sentence),
                         prompts.feedback_schema(language))


@pytest.fixture(scope="module")
def results():
    return [(lang, text, exp_ok, exp_tag, _ask(lang, text))
            for lang, text, exp_ok, exp_tag in CASES]


def test_explanations_are_written_in_korean(results):
    """The bug that motivated this file: English corrections in the database.
    Quoted target-language examples inflate the Latin count, so count Hangul
    rather than comparing alphabets."""
    bad = [text for _, text, _, _, out in results
           if _hangul(out["correction"]) < 8 or _hangul(out["suggestion"]) < 8]
    assert len(bad) <= 1, f"not Korean: {bad}"


def test_ok_flag_matches_whether_the_sentence_was_correct(results):
    wrong = [text for _, text, exp_ok, _, out in results if out["ok"] != exp_ok]
    assert len(wrong) <= 1, f"wrong ok: {wrong}"


def test_tags_are_mostly_right(results):
    """Pooling both languages here would hide the exact regression this file
    exists to catch: a shared tag list (see FEEDBACK_TAGS in app/prompts.py)
    drops Japanese from 8/8 to 6/8 because particle errors have nowhere to go
    but 어순. A pooled threshold of <=3 wrong out of 12 (75%) tolerates that
    drop; splitting per language does not."""
    wrong_en = [(text, out["tag"], exp) for lang, text, _, exp, out in results
                if lang == "en" and out["tag"] != exp]
    wrong_ja = [(text, out["tag"], exp) for lang, text, _, exp, out in results
                if lang == "ja" and out["tag"] != exp]
    assert len(wrong_en) <= 2, f"wrong tags (en): {wrong_en}"
    assert len(wrong_ja) <= 1, f"wrong tags (ja): {wrong_ja}"


def test_fixed_is_a_real_sentence_not_an_explanation(results):
    """`fixed` feeds the re-speak button, so it must be the target-language
    sentence alone -- Korean prose in this field would be read aloud as the
    thing to repeat."""
    for _, text, _, _, out in results:
        assert out["fixed"], f"empty fixed for {text}"
        assert _hangul(out["fixed"]) == 0, f"Korean leaked into fixed for {text}"


def test_report_comes_back_in_korean_and_respects_the_counts():
    stats = {"turns": 3, "wrong": 2, "tags": {"시제": 1, "전치사": 1},
             "sentences": [{"said": "I go store yesterday.",
                            "fixed": "I went to the store yesterday.", "tag": "시제"},
                           {"said": "I am interested on music.",
                            "fixed": "I am interested in music.", "tag": "전치사"}]}
    transcript = ("bot: What did you do yesterday?\n"
                  "user: I go store yesterday.\n"
                  "bot: Nice. What music do you like?\n"
                  "user: I am interested on music.")
    out = llm.chat_json(prompts.build_report_messages("en", transcript, stats),
                        prompts.REPORT_SCHEMA)
    assert _hangul(out["summary"]) >= 8, out["summary"]
    assert _hangul(out["next_focus"]) >= 5, out["next_focus"]
    assert out["weak_points"], "two wrong turns should produce at least one weak point"
    assert out["level"] in ("beginner", "intermediate", "advanced")
