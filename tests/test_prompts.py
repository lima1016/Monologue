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


def test_a_stored_scenario_with_no_goal_falls_back_instead_of_saying_None():
    """scenarios.from_row always materialises `goal`, so a generated scenario
    with none reads back as {"goal": None} -- the key is present and a default
    keyed on its absence never fires. The prompt then literally told the model
    "Scene goal: None". A built-in scenario omits the key entirely, which is
    why this only ever showed up for generated ones."""
    stored = {"id": "user-x", "language": "en", "type": "free", "title": "t",
              "goal": None, "persona_prompt": "You are a barista.",
              "max_turns": None, "lines": None}
    text = prompts.build_system_prompt("free", "en", scenario=stored)
    assert "have a natural conversation" in text
    assert "Scene goal: None" not in text
    # max_turns is None here too: the wind-down comparison must not crash, and
    # a fresh session must not be told to wrap up on its first turn.
    assert "wrap" not in text.lower()


def test_free_mode_asks_the_bot_to_wind_down_near_the_turn_limit():
    scenario = {"persona_prompt": "p", "goal": "g", "max_turns": 8}
    early = prompts.build_system_prompt("free", "en", scenario=scenario, turns_used=1)
    late = prompts.build_system_prompt("free", "en", scenario=scenario, turns_used=7)
    assert "wrap" in late.lower() or "wind" in late.lower()
    assert "wrap" not in early.lower()


def test_lesson_mode_injects_the_estimated_level():
    text = prompts.build_system_prompt("lesson", "en", level="advanced")
    assert "advanced" in text


def test_the_bot_is_told_to_pitch_slightly_above_the_learner():
    """i+1: comprehensible input works when it sits a step beyond what the
    learner can already produce, not level with it."""
    text = prompts.build_system_prompt("free", "en", level="intermediate",
                                       scenario={"persona_prompt": "p", "goal": "g",
                                                 "max_turns": 8})
    assert "intermediate" in text
    assert "step above" in text.lower()


def test_the_pitch_reconciles_with_the_sentence_cap_instead_of_fighting_it():
    """LEVEL_PITCH used to ask for speech "a little longer" while SPOKEN_STYLE
    caps every reply at three sentences as a hard limit -- a direct
    contradiction that the model resolved by obeying the cap and dropping the
    pitch along with it. The pitch must name the cap it lives inside, and must
    never ask for more length again."""
    text = prompts.build_system_prompt("free", "en", level="intermediate",
                                       scenario={"persona_prompt": "p", "goal": "g",
                                                 "max_turns": 8})
    # The pitch's own phrasing, not SPOKEN_STYLE's -- SPOKEN_STYLE already says
    # "1 to 3 sentences", so a looser substring would pass without the pitch
    # naming the cap at all.
    assert "within the 1 to 3 sentence limit" in text
    assert "longer" not in prompts.LEVEL_PITCH.lower()


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


def test_feedback_system_warns_the_text_is_a_speech_recognition_transcript():
    """The learner's window-seat case: the model needs to know the line came
    from speech recognition, or it treats a mis-heard word as a real one."""
    system = prompts.build_feedback_messages("en", "test")[0]["content"]
    assert "음성" in system
    assert "확신" in system  # the "if unsure, ok: true" permission


def test_feedback_system_tells_suggestion_not_to_restate_correction():
    system = prompts.build_feedback_messages("en", "test")[0]["content"]
    assert "다른 표현" in system


def test_feedback_context_paragraph_carries_scenario_and_bot_last_line():
    system = prompts.build_feedback_messages(
        "en", "I'd like to take a seat Uh Windows",
        scenario_title="식당 자리 안내", scenario_goal="창가 자리를 요청하고 안내받는다",
        bot_last="Would you like a table by the window?",
    )[0]["content"]
    assert "식당 자리 안내" in system
    assert "창가 자리를 요청하고 안내받는다" in system
    assert "Would you like a table by the window?" in system


def test_feedback_context_paragraph_absent_without_any_context():
    """No scenario, no prior bot line, no topic (first turn / scenario-less
    lesson mode): the context paragraph must be left out entirely, not filled
    in with a None-shaped hole -- this file already learned that lesson once
    for build_system_prompt's free-mode branch."""
    system = prompts.build_feedback_messages("en", "test")[0]["content"]
    assert "None" not in system
    assert "참고할 문맥" not in system


def test_feedback_context_only_fills_in_the_pieces_it_has():
    system = prompts.build_feedback_messages(
        "en", "test", bot_last="Checking in today?",
    )[0]["content"]
    assert "Checking in today?" in system
    assert "지금 상황" not in system  # no scenario_title given
    assert "None" not in system


def test_feedback_context_goes_in_the_system_prompt_not_the_few_shot_turns():
    """Context must land only in the system message. If it also reshaped the
    few-shot user turns, the real query would look structurally different from
    every worked example the model just saw -- the local model latches onto
    that mismatch rather than the content."""
    with_context = prompts.build_feedback_messages(
        "en", "I go store yesterday.",
        scenario_title="식당 자리 안내", scenario_goal="창가 자리를 요청받는다",
        bot_last="Would you like a table by the window?", topic="past tense",
    )
    without_context = prompts.build_feedback_messages("en", "I go store yesterday.")

    with_shots = [m["content"] for m in with_context if m["role"] == "user"][:-1]
    without_shots = [m["content"] for m in without_context if m["role"] == "user"][:-1]
    assert with_shots == without_shots
    for content in with_shots:
        assert content.startswith("학생이 말한 문장: ")
        assert "식당" not in content
        assert "window" not in content


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


def test_scenario_prompt_is_written_in_korean_and_carries_the_wish():
    msgs = prompts.build_scenario_messages("en", "free", "구직 면접")
    system, user = msgs[0]["content"], msgs[-1]["content"]
    hangul = sum(1 for ch in system if "가" <= ch <= "힣")
    assert hangul > 100, "scenario prompt is not Korean"
    assert "구직 면접" in user


def test_scenario_schema_differs_by_kind():
    free = prompts.scenario_schema("free")
    assert set(free["required"]) == {"title", "goal", "persona_prompt"}
    script = prompts.scenario_schema("script")
    assert "lines" in script["required"]
    assert script["properties"]["lines"]["type"] == "array"
