"""System prompt assembly for the three modes, plus feedback and report prompts.

The spoken-style block is the single most important part of this file. Left to
itself an LLM writes prose: long sentences, no contractions, formal connectives.
Read aloud, that teaches the learner a register nobody actually speaks.
"""
import json

from app import config

LANGUAGE_NAMES = {"en": "English", "ja": "Japanese"}

# Qwen is Chinese-trained and bleeds Chinese characters/words into Japanese
# output, and sometimes drops into romaji. This rule is appended, verbatim, to
# any prompt that asks for Japanese text -- conversation and feedback alike --
# because it needs to reach the model regardless of which prompt is active.
JAPANESE_SCRIPT_ONLY_RULE = (
    "Write only in Japanese script: kanji, hiragana, and katakana. Never use "
    "Chinese characters or words, and never use romanized (romaji) Japanese."
)

# How much Korean scaffolding the teacher may use, by level. This deliberately
# overrides SPOKEN_STYLE's "reply in {language} only" for lesson mode: a beginner
# cannot learn a grammar point from an explanation they cannot parse. Free and
# script mode keep full immersion.
LESSON_LANGUAGE_RULE = {
    "beginner": (
        "Explain the grammar in Korean so the student actually understands, but "
        "always give your example sentences in {language}. This overrides the "
        "'reply in {language} only' rule above."
    ),
    "intermediate": (
        "Explain mostly in simple {language}. Drop into Korean for a phrase or "
        "two when the student looks lost, then return to {language}. This "
        "overrides the 'reply in {language} only' rule above."
    ),
    "advanced": (
        "Stay in {language} throughout, including your explanations."
    ),
}

SPOKEN_STYLE = """\
You are speaking out loud, and your reply is read by a speech synthesiser.
Follow these rules without exception:
- Reply in {language} only.
- Keep every reply to 1 to 3 sentences. This is a hard limit, not a target,
  because it is read aloud: anything longer becomes a wall of speech. Stop
  after the third sentence even if you have more you could say.
- Never break a reply into more than one paragraph and never leave a blank
  line. Write it as one continuous block, the way speech sounds.
- Use contractions and everyday spoken wording, the way a real person talks.
- Never use markdown, asterisks, bullet points, numbered lists, or headings.
- Never use emoji.
- Never add parenthetical asides or stage directions.
- Ask a question back when it keeps the conversation going naturally."""

FREE_TEMPLATE = """\
{style}

You are role-playing a scene with a language learner.

Your character: {persona}
Scene goal: {goal}

Stay fully in character. Never break role to comment on the learner's {language}
— corrections are handled elsewhere. If the learner says something unclear, react
the way your character naturally would."""

SCRIPT_TEMPLATE = """\
{style}

You are performing a short scripted dialogue with a language learner, like two
actors reading a scene. Deliver your assigned line naturally and wait for the
learner to read theirs. Do not add lines that are not in the script."""

LESSON_TEMPLATE = """\
{style}

You are a warm, patient {language} teacher in a one-to-one spoken lesson.
The student's current level is {level}. Pitch everything to that level.
{language_rule}

{topic_line}

Run the lesson in short spoken beats, never a lecture — each step happens in a separate turn:
1. Explain one small point in a sentence or two.
2. Give one clear example sentence.
3. Ask the student to make their own sentence using it.
4. Correct what they say, briefly and kindly, then move on or go deeper.

Do exactly one of these four steps per reply, then stop and wait for the student."""

WIND_DOWN = """

You are near the end of this session. Start steering it to a natural close and
wrap it up within the next couple of exchanges."""

FEEDBACK_SCHEMA = {
    "type": "object",
    "properties": {
        "correction": {"type": "string"},
        "suggestion": {"type": "string"},
    },
    "required": ["correction", "suggestion"],
}

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "report": {"type": "string"},
        "level": {"type": "string", "enum": list(config.LEVELS)},
    },
    "required": ["report", "level"],
}


def build_system_prompt(mode, language, *, scenario=None, topic=None,
                        level="beginner", turns_used=0) -> str:
    if mode not in config.MODES:
        raise ValueError(f"unknown mode: {mode}")
    if language not in config.LANGUAGES:
        raise ValueError(f"unknown language: {language}")

    language_name = LANGUAGE_NAMES[language]
    style = SPOKEN_STYLE.format(language=language_name)
    if language == "ja":
        style += "\n- " + JAPANESE_SCRIPT_ONLY_RULE

    if mode == "free":
        if not scenario:
            raise ValueError("free mode needs a scenario")
        prompt = FREE_TEMPLATE.format(
            style=style,
            persona=scenario["persona_prompt"],
            goal=scenario.get("goal", "have a natural conversation"),
            language=language_name,
        )
        max_turns = scenario.get("max_turns", config.DEFAULT_MAX_TURNS)
        if turns_used >= max_turns - 2:
            prompt += WIND_DOWN
        return prompt

    if mode == "script":
        return SCRIPT_TEMPLATE.format(style=style)

    topic_line = (
        f"Today's topic, chosen by the student: {topic}"
        if topic
        else "The student has not chosen a topic. Choose one grammar point or "
             "theme that suits their level and teach that."
    )
    language_rule = LESSON_LANGUAGE_RULE.get(level, LESSON_LANGUAGE_RULE["beginner"])
    language_rule_text = language_rule.format(language=language_name)
    prompt = LESSON_TEMPLATE.format(
        style=style, language=language_name, level=level, topic_line=topic_line,
        language_rule=language_rule_text
    )
    if turns_used >= config.DEFAULT_MAX_TURNS - 2:
        prompt += WIND_DOWN
    return prompt


# Two worked examples per language, covering the two failure shapes a local
# model actually produced: an erroneous line (where the fix should land) and
# an already-correct line (where the model tended to give up on Korean and
# answer with a short formulaic line in the target language instead). Each
# assistant turn is exactly the JSON shape FEEDBACK_SCHEMA expects -- nothing
# more -- so the model isn't taught to wrap it in extra prose.
FEEDBACK_EXAMPLES = {
    "en": [
        {
            "learner": "I go store yesterday.",
            "correction": (
                "'go'는 과거형이 아니라서 틀렸습니다. 'went'로 바꾸고 'to the'를 "
                "추가해야 합니다. 올바른 문장은 'I went to the store yesterday.'입니다."
            ),
            "suggestion": (
                "원어민이라면 'I went to the store yesterday.' 또는 'Yesterday I "
                "went to the store.'처럼 말할 거예요."
            ),
        },
        {
            "learner": "I have two brothers and one sister.",
            "correction": "이 문장은 문법적으로 이미 맞습니다. 고칠 부분이 없습니다.",
            "suggestion": (
                "좀 더 자연스럽게 말하고 싶다면 'I've got two brothers and a "
                "sister.'처럼 표현할 수도 있어요."
            ),
        },
    ],
    "ja": [
        {
            "learner": "きのう、レストランに行きます。",
            "correction": (
                "'行きます'는 현재형이라서 어제 있었던 일에는 맞지 않습니다. 과거형인 "
                "'行きました'로 바꿔야 합니다. 올바른 문장은 'きのう、レストランに"
                "行きました。'입니다."
            ),
            "suggestion": "원어민이라면 '昨日、レストランに行きました。'처럼 자연스럽게 말할 거예요.",
        },
        {
            "learner": "わたしは毎朝コーヒーを飲みます。",
            "correction": "이 문장은 문법적으로 이미 맞습니다. 고칠 부분이 없습니다.",
            "suggestion": (
                "좀 더 자연스럽게 말하고 싶다면 '毎朝コーヒーを飲んでいます。'처럼 "
                "표현할 수도 있어요."
            ),
        },
    ],
}


def build_feedback_messages(language, user_text) -> list[dict]:
    """Ask for a grammar correction and a more natural phrasing, 2 sentences each.

    Few-shot examples are included as prior turns: a stated rule alone
    ("writing your feedback in Korean") was not enough to hold the local
    model, which kept dropping into the target language, especially on
    already-correct lines. Showing both failure shapes worked in Korean is
    the next rung up, not more emphasis on the same instruction.
    """
    language_name = LANGUAGE_NAMES[language]
    system = (
        f"You are a {language_name} teacher reviewing one line a learner just spoke, "
        "writing your feedback in Korean.\n"
        "Return two things:\n"
        "- correction: what was grammatically wrong and the fixed sentence. "
        "If it was already correct, say so briefly -- still in Korean.\n"
        "- suggestion: a more natural way a native speaker would say it.\n"
        "Write each in at most two sentences. Keep the "
        f"{language_name} example sentences themselves in {language_name}. "
        "No markdown, no emoji."
    )
    if language == "ja":
        system += " " + JAPANESE_SCRIPT_ONLY_RULE

    messages = [{"role": "system", "content": system}]
    for example in FEEDBACK_EXAMPLES[language]:
        messages.append({"role": "user", "content": f"The learner said: {example['learner']}"})
        messages.append({
            "role": "assistant",
            "content": json.dumps(
                {"correction": example["correction"], "suggestion": example["suggestion"]},
                ensure_ascii=False,
            ),
        })
    messages.append({"role": "user", "content": f"The learner said: {user_text}"})
    return messages


def build_report_messages(language, transcript) -> list[dict]:
    """Ask for an end-of-session report and a level estimate in one call."""
    language_name = LANGUAGE_NAMES[language]
    system = (
        f"You are a {language_name} teacher writing a short end-of-lesson report "
        "for one student, in Korean.\n"
        "Cover: grammar mistakes that repeated, two or three expressions worth "
        "memorising, and a brief encouraging overall comment.\n"
        "Also estimate the student's level as exactly one of: beginner, "
        "intermediate, advanced.\n"
        "Keep the report under 200 words. No markdown, no emoji."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Here is the full session transcript:\n\n{transcript}"},
    ]
