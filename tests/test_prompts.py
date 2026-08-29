import pytest

from app import prompts


def test_every_mode_and_language_produces_a_prompt_with_spoken_style_rules():
    for mode in ("free", "script", "lesson"):
        for lang in ("en", "ja"):
            scenario = {"persona_prompt": "You are a host.", "goal": "seat them",
                        "max_turns": 8} if mode == "free" else None
            text = prompts.build_system_prompt(mode, lang, scenario=scenario)
            assert "1 to 3 sentences" in text
            assert "contractions" in text.lower()
            assert "markdown" in text.lower()
            assert "emoji" in text.lower()


def test_free_mode_embeds_persona_and_goal():
    scenario = {"persona_prompt": "You are an airline agent.", "goal": "assign a seat",
                "max_turns": 8}
    text = prompts.build_system_prompt("free", "en", scenario=scenario)
    assert "You are an airline agent." in text
    assert "assign a seat" in text


def test_free_mode_asks_the_bot_to_wind_down_near_the_turn_limit():
    scenario = {"persona_prompt": "p", "goal": "g", "max_turns": 8}
    early = prompts.build_system_prompt("free", "en", scenario=scenario, turns_used=1)
    late = prompts.build_system_prompt("free", "en", scenario=scenario, turns_used=7)
    assert "wrap" in late.lower() or "wind" in late.lower()
    assert "wrap" not in early.lower()


def test_lesson_mode_injects_the_estimated_level():
    text = prompts.build_system_prompt("lesson", "en", level="advanced")
    assert "advanced" in text


def test_lesson_mode_uses_the_topic_when_given():
    text = prompts.build_system_prompt("lesson", "ja", topic="て form", level="beginner")
    assert "て form" in text


def test_lesson_mode_delegates_topic_choice_when_none_given():
    text = prompts.build_system_prompt("lesson", "en", level="beginner")
    assert "choose" in text.lower()


def test_lesson_mode_describes_the_teaching_cycle():
    text = prompts.build_system_prompt("lesson", "en", level="beginner")
    for beat in ("explain", "example", "correct"):
        assert beat in text.lower()


def test_prompt_names_the_target_language():
    assert "English" in prompts.build_system_prompt("lesson", "en")
    assert "Japanese" in prompts.build_system_prompt("lesson", "ja")


def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        prompts.build_system_prompt("quiz", "en")


def test_free_mode_without_scenario_raises():
    with pytest.raises(ValueError):
        prompts.build_system_prompt("free", "en")


def test_feedback_messages_carry_the_learner_text_and_two_sentence_cap():
    msgs = prompts.build_feedback_messages("en", "I go store yesterday")
    joined = " ".join(m["content"] for m in msgs)
    assert "I go store yesterday" in joined
    assert "두 문장" in joined


def test_feedback_system_prompt_states_korean_up_front():
    # The Korean identity anchor must be in the opening sentence, not buried
    # mid-paragraph, or local models ignore it and answer in the target
    # language instead.
    msgs = prompts.build_feedback_messages("en", "I go store yesterday")
    system = msgs[0]["content"]
    assert "한국어" in system[:60]


def test_feedback_schema_requires_five_fields_and_language_specific_tags():
    en = prompts.feedback_schema("en")
    assert set(en["required"]) == {"ok", "fixed", "tag", "correction", "suggestion"}
    assert en["properties"]["ok"]["type"] == "boolean"
    assert "전치사" in en["properties"]["tag"]["enum"]
    assert "조사" not in en["properties"]["tag"]["enum"]

    ja = prompts.feedback_schema("ja")
    assert "조사" in ja["properties"]["tag"]["enum"]
    assert "전치사" not in ja["properties"]["tag"]["enum"]


def test_every_tag_has_a_definition_line():
    for language, tags in prompts.FEEDBACK_TAGS.items():
        defs = prompts.FEEDBACK_TAG_DEFINITIONS[language]
        for tag in tags:
            assert f"{tag} -" in defs, f"{language}/{tag} has no definition"


def test_feedback_system_prompt_is_written_in_korean():
    """The bug this fixes: the prompt asked for Korean *in English*, and the
    model followed the language it was addressed in rather than the request."""
    for language in ("en", "ja"):
        system = prompts.build_feedback_messages(language, "test")[0]["content"]
        hangul = sum(1 for ch in system if "가" <= ch <= "힣")
        assert hangul > 100, f"{language} system prompt is not Korean"


def test_feedback_examples_carry_the_full_five_field_shape():
    import json
    for language in ("en", "ja"):
        msgs = prompts.build_feedback_messages(language, "test")
        answers = [json.loads(m["content"]) for m in msgs if m["role"] == "assistant"]
        assert answers, "few-shot examples are missing"
        for answer in answers:
            assert set(answer) == {"ok", "fixed", "tag", "correction", "suggestion"}
            assert answer["tag"] in prompts.FEEDBACK_TAGS[language]


def test_report_schema_constrains_level_to_the_three_values():
    assert prompts.REPORT_SCHEMA["properties"]["level"]["enum"] == [
        "beginner", "intermediate", "advanced"
    ]


def test_report_schema_asks_for_structured_fields():
    props = prompts.REPORT_SCHEMA["properties"]
    assert set(prompts.REPORT_SCHEMA["required"]) == {
        "summary", "weak_points", "expressions", "next_focus", "level"}
    assert props["weak_points"]["type"] == "array"
    assert props["expressions"]["type"] == "array"


def test_report_messages_include_the_transcript():
    empty = {"turns": 1, "wrong": 0, "tags": {}, "sentences": []}
    msgs = prompts.build_report_messages("en", "bot: Hi\nuser: Hello", empty)
    assert "user: Hello" in " ".join(m["content"] for m in msgs)


def test_report_system_prompt_is_written_in_korean():
    """The same bug Phase 2A fixed for feedback: the report prompt asked for
    Korean *in English*, and a model answers in the language it is addressed in."""
    empty = {"turns": 1, "wrong": 0, "tags": {}, "sentences": []}
    for language in ("en", "ja"):
        system = prompts.build_report_messages(language, "bot: hi\nuser: hello", empty)[0]["content"]
        hangul = sum(1 for ch in system if "가" <= ch <= "힣")
        assert hangul > 100, f"{language} report prompt is not Korean"


def test_report_prompt_hands_the_model_counts_rather_than_asking_it_to_count():
    stats = {"turns": 6, "wrong": 3, "tags": {"전치사": 2, "시제": 1},
             "sentences": [{"said": "I am interested on music.",
                            "fixed": "I am interested in music.", "tag": "전치사"}]}
    joined = " ".join(m["content"] for m in prompts.build_report_messages("en", "t", stats))
    assert "전치사 2회" in joined
    assert "I am interested in music." in joined


def test_report_prompt_warns_against_reading_ungraded_turns_as_flawless():
    """The bug this guards: `wrong == 0` alone reads as a flawless session even
    when every grading call actually failed. The ungraded count and the
    caution against that reading must both reach the model."""
    stats = {"turns": 3, "wrong": 0, "ungraded": 2, "tags": {}, "sentences": []}
    joined = " ".join(m["content"] for m in prompts.build_report_messages("en", "t", stats))
    assert "채점하지 못한 횟수: 2" in joined
    assert "완벽한 세션" in joined


def test_report_prompt_omits_the_ungraded_warning_when_nothing_went_ungraded():
    stats = {"turns": 3, "wrong": 1, "ungraded": 0, "tags": {}, "sentences": []}
    joined = " ".join(m["content"] for m in prompts.build_report_messages("en", "t", stats))
    assert "채점하지 못한" not in joined


def test_beginner_lesson_includes_korean_scaffolding_but_advanced_does_not():
    beginner = prompts.build_system_prompt("lesson", "en", level="beginner")
    advanced = prompts.build_system_prompt("lesson", "en", level="advanced")
    assert "Korean" in beginner
    assert "Korean" not in advanced


def test_unknown_level_falls_back_to_beginner_rule_without_raising():
    prompt = prompts.build_system_prompt("lesson", "en", level="fluent")
    assert prompt  # Should produce a prompt
    assert "Korean" in prompt  # Should fall back to beginner rule


def test_lesson_prompt_instructs_one_step_per_reply():
    prompt = prompts.build_system_prompt("lesson", "en", level="beginner")
    assert "one of these four steps per reply, then stop and wait" in prompt
