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

# i+1: comprehensible input works when the bot's own speech sits a step beyond
# what the learner can already produce, not level with it -- pitching exactly
# to their level gives them nothing new to pick up. Shared between free and
# lesson mode so both actually use the level they are handed, rather than
# free mode taking a level argument and silently ignoring it. Script mode is
# excluded on purpose: its lines are fixed dialogue, not generated speech, so
# there is nothing here for a level to pitch.
LEVEL_PITCH = (
    "The student's current level is {level}. Pitch your own speech a small step "
    "above it -- a little longer, a little richer -- so there is something new to "
    "pick up, while staying comprehensible. Do not drop to their level, and do not "
    "leap past it."
)

FREE_TEMPLATE = """\
{style}

You are role-playing a scene with a language learner.

Your character: {persona}
Scene goal: {goal}

{level_pitch}

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
{level_pitch}
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

# Tag vocabularies are per language on purpose. Giving Japanese a "전치사" slot
# leaves particle errors with nowhere to go and they get filed as "어순"; the
# spike measured 6/8 with a shared list and 8/8 once split.
FEEDBACK_TAGS = {
    "en": ("시제", "관사", "전치사", "어순", "어휘", "단복수", "없음"),
    "ja": ("시제", "조사", "활용", "어순", "어휘", "경어", "없음"),
}

# Naming the tags is not enough -- the model guesses. One defining line each,
# plus the consistency rule in the system prompt, is what made tagging reliable.
FEEDBACK_TAG_DEFINITIONS = {
    "en": (
        "시제 - 동사의 과거/현재/미래 형태가 틀림\n"
        "관사 - a, an, the를 빠뜨렸거나 잘못 씀\n"
        "전치사 - in, on, at, to 같은 전치사를 잘못 고름\n"
        "어순 - 단어 순서 자체가 틀림\n"
        "어휘 - 단어 선택이 틀렸거나 부자연스러움\n"
        "단복수 - 단수/복수 형태나 주어-동사 수 일치가 틀림 (He don't -> He doesn't)\n"
        "없음 - 틀린 곳이 없음"
    ),
    "ja": (
        "시제 - 과거/현재/미래 형태가 틀림\n"
        "조사 - は, が, に, で, を, の 같은 조사를 잘못 골랐음\n"
        "활용 - 동사/형용사 활용형이 틀림 (て형, ない형, 명사수식 등)\n"
        "어순 - 단어 순서 자체가 틀림\n"
        "어휘 - 단어 선택이 틀렸거나 부자연스러움\n"
        "경어 - 존댓말/반말 수준이 안 맞음\n"
        "없음 - 틀린 곳이 없음"
    ),
}

KOREAN_LANGUAGE_NAMES = {"en": "영어", "ja": "일본어"}


def feedback_schema(language) -> dict:
    """Ollama constrains generation to this shape, so the JSON always parses.
    What it cannot enforce is the *content*: that the prose is Korean and that
    the chosen tag matches what the explanation actually says. Those are the
    system prompt's job."""
    return {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "fixed": {"type": "string"},
            "tag": {"type": "string", "enum": list(FEEDBACK_TAGS[language])},
            "correction": {"type": "string"},
            "suggestion": {"type": "string"},
        },
        "required": ["ok", "fixed", "tag", "correction", "suggestion"],
    }


REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "weak_points": {"type": "array", "items": {"type": "string"}},
        "expressions": {"type": "array", "items": {"type": "string"}},
        "next_focus": {"type": "string"},
        "level": {"type": "string", "enum": list(config.LEVELS)},
    },
    "required": ["summary", "weak_points", "expressions", "next_focus", "level"],
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

    level_pitch = LEVEL_PITCH.format(level=level)

    if mode == "free":
        if not scenario:
            raise ValueError("free mode needs a scenario")
        prompt = FREE_TEMPLATE.format(
            style=style,
            persona=scenario["persona_prompt"],
            goal=scenario.get("goal", "have a natural conversation"),
            language=language_name,
            level_pitch=level_pitch,
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
        style=style, language=language_name, level_pitch=level_pitch,
        topic_line=topic_line, language_rule=language_rule_text
    )
    if turns_used >= config.DEFAULT_MAX_TURNS - 2:
        prompt += WIND_DOWN
    return prompt


# Two worked examples per language, covering the two failure shapes a local
# model actually produced: an erroneous line (where the fix should land) and
# an already-correct line (where the model tended to give up on Korean and
# answer with a short formulaic line in the target language instead). Each
# assistant turn is exactly the JSON shape feedback_schema() expects -- nothing
# more -- so the model isn't taught to wrap it in extra prose.
FEEDBACK_EXAMPLES = {
    "en": [
        {
            "learner": "I go store yesterday.",
            "ok": False,
            "fixed": "I went to the store yesterday.",
            "tag": "시제",
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
            "ok": True,
            "fixed": "I have two brothers and one sister.",
            "tag": "없음",
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
            "ok": False,
            "fixed": "きのう、レストランに行きました。",
            "tag": "시제",
            "correction": (
                "'行きます'는 현재형이라서 어제 있었던 일에는 맞지 않습니다. 과거형인 "
                "'行きました'로 바꿔야 합니다. 올바른 문장은 'きのう、レストランに"
                "行きました。'입니다."
            ),
            "suggestion": "원어민이라면 '昨日、レストランに行きました。'처럼 자연스럽게 말할 거예요.",
        },
        {
            "learner": "わたしは毎朝コーヒーを飲みます。",
            "ok": True,
            "fixed": "わたしは毎朝コーヒーを飲みます。",
            "tag": "없음",
            "correction": "이 문장은 문법적으로 이미 맞습니다. 고칠 부분이 없습니다.",
            "suggestion": (
                "좀 더 자연스럽게 말하고 싶다면 '毎朝コーヒーを飲んでいます。'처럼 "
                "표현할 수도 있어요."
            ),
        },
    ],
}

# Editing this string? Run `pytest tests/test_feedback_quality.py -m engine`
# against the real model afterward -- it is the only check that catches a
# regression in Korean output or tag accuracy; the default (non-engine) test
# run mocks the model and will not notice.
FEEDBACK_SYSTEM = """당신은 한국인 학생을 가르치는 한국어 원어민 교사입니다.
당신이 말하고 쓰는 언어는 오직 한국어입니다. {lang}은(는) 당신이 설명하는 '대상'일 뿐,
당신이 사용하는 언어가 아닙니다.

학생이 {lang} 문장을 한 줄 말했습니다. 아래 다섯 항목을 채우세요.

- ok: 문법적으로 맞으면 true, 틀린 곳이 있으면 false
- fixed: 고친 문장 하나만. 이미 맞으면 원문 그대로. {lang}으로 씁니다
- tag: 틀린 부분의 종류. 아래 정의를 보고 정확히 하나만 고릅니다
{defs}
- correction: 무엇이 왜 틀렸는지. 한국어로 두 문장 이내
- suggestion: 원어민이라면 어떻게 말할지. 한국어로 두 문장 이내

tag는 correction에서 실제로 지적한 내용과 일치해야 합니다.

correction과 suggestion은 반드시 한국어로 씁니다. 인용하는 {lang} 예문만 {lang}으로 둡니다.
마크다운과 이모지는 쓰지 않습니다."""


def build_feedback_messages(language, user_text) -> list[dict]:
    """Ask for structured grammar feedback on one learner line.

    The system prompt is written in Korean, and that is the fix, not a style
    choice. The previous version asked for Korean output *in English*; the model
    answered in the language it was addressed in, and English corrections are
    still sitting in the messages table from that period. Moving the instruction
    itself into Korean took the spike from unreliable to 10/10 (en) and 8/8 (ja).

    Few-shot examples stay -- a stated rule alone was not enough to hold the
    local model, especially on already-correct lines.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    system = FEEDBACK_SYSTEM.format(
        lang=language_name, defs=FEEDBACK_TAG_DEFINITIONS[language]
    )
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE

    messages = [{"role": "system", "content": system}]
    for example in FEEDBACK_EXAMPLES[language]:
        messages.append({"role": "user", "content": f"학생이 말한 문장: {example['learner']}"})
        messages.append({
            "role": "assistant",
            "content": json.dumps(
                {k: example[k] for k in ("ok", "fixed", "tag", "correction", "suggestion")},
                ensure_ascii=False,
            ),
        })
    messages.append({"role": "user", "content": f"학생이 말한 문장: {user_text}"})
    return messages


REPORT_SYSTEM = """당신은 한국인 학생을 가르치는 한국어 원어민 교사입니다.
당신이 말하고 쓰는 언어는 오직 한국어입니다. {lang}은(는) 설명하는 '대상'일 뿐입니다.

학생이 방금 {lang} 회화 연습 한 세션을 마쳤습니다. 대화록과, 코드가 정확히 집계한
통계를 함께 드립니다. 통계는 이미 정확하니 다시 세지 마세요. 당신이 할 일은 그
숫자가 무엇을 뜻하는지 해석하고, 다음에 무엇을 연습해야 하는지 짚는 것입니다.

- summary: 이번 세션이 어땠는지 두세 문장. 잘한 것부터 말합니다
- weak_points: 부족한 부분. 항목마다 무엇이 부족한지와 왜 그런지를 함께 씁니다.
               통계에 없는 것을 지어내지 마세요. 틀린 곳이 없었다면 빈 배열입니다
- expressions: 이번 대화에서 실제로 나온 것 중 외워둘 만한 표현 2~3개.
               {lang} 표현과 그것을 언제 쓰는지를 한국어로 함께 씁니다
- next_focus: 다음 세션에서 무엇을 연습할지 한 문장. 구체적으로

모든 설명은 한국어로 씁니다. 인용하는 {lang} 표현만 {lang}으로 둡니다.
마크다운과 이모지는 쓰지 않습니다."""


def build_report_messages(language, transcript, stats) -> list[dict]:
    """Ask for an end-of-session report, handing over counts rather than asking
    for them.

    The system prompt is Korean for the same reason the feedback prompt is:
    asking for Korean *in English* produced English, and moving the instruction
    itself into Korean is what fixed it there.

    The statistics are computed in db.session_stats and pasted in as fact. A
    model asked "which mistakes repeated" will invent a plausible answer; a
    model handed "전치사 2회, 시제 1회" and asked what that means will not.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    system = REPORT_SYSTEM.format(lang=language_name)
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE

    lines = ["이번 세션 통계 (코드가 집계한 정확한 숫자입니다)",
             f"- 학생이 말한 횟수: {stats['turns']}",
             f"- 그중 고칠 곳이 있었던 횟수: {stats['wrong']}"]
    # A turn can go ungraded when the grading call itself failed -- it is
    # neither right nor wrong. Handed only "고칠 곳이 있었던 횟수: 0" the model
    # writes a congratulatory summary for a session that was never actually
    # checked, so the ungraded count and the caution against that reading both
    # need to reach the prompt.
    if stats.get("ungraded"):
        lines.append(f"- 채점하지 못한 횟수: {stats['ungraded']}")
        lines.append(
            "고칠 곳이 있었던 횟수가 0이라 해도, 채점하지 못한 횟수가 있다면 "
            "완벽한 세션이었다고 쓰지 마세요."
        )
    if stats["tags"]:
        ranked = sorted(stats["tags"].items(), key=lambda kv: -kv[1])
        lines.append("- 오류 종류별 횟수: " + ", ".join(f"{t} {n}회" for t, n in ranked))
    else:
        lines.append("- 오류 종류별 횟수: 없음")
    if stats["sentences"]:
        lines.append("")
        lines.append("고쳐야 했던 문장들")
        for s in stats["sentences"]:
            lines.append(f"- 말한 것: {s['said']}")
            lines.append(f"  올바른 문장: {s['fixed']}  ({s['tag']})")

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(lines) + f"\n\n전체 대화록\n{transcript}"},
    ]


def scenario_schema(kind) -> dict:
    """What a generated scenario must contain. Ollama constrains generation to
    this shape, so the JSON always parses -- what it cannot enforce is that the
    persona is usable or the lines alternate, which is why scenarios.validate_item
    still runs before anything is stored."""
    if kind == "free":
        return {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "goal": {"type": "string"},
                "persona_prompt": {"type": "string"},
            },
            "required": ["title", "goal", "persona_prompt"],
        }
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "speaker": {"type": "string", "enum": ["bot", "user"]},
                        "text": {"type": "string"},
                    },
                    "required": ["speaker", "text"],
                },
            },
        },
        "required": ["title", "lines"],
    }


SCENARIO_SYSTEM_FREE = """당신은 한국인 학습자를 위한 {lang} 회화 연습 상황을 만드는 사람입니다.
당신이 쓰는 언어는 한국어입니다. {lang}은(는) 만들어 낼 대사와 페르소나에만 씁니다.

학습자가 연습하고 싶은 상황을 한 줄로 말했습니다. 그 상황을 실제로 굴러가게 할
설정을 만드세요.

- title: 학습자가 목록에서 알아볼 수 있는 짧은 한국어 제목
- goal: 이 대화에서 학습자가 해내야 할 일. 한국어 한 문장.
        "영어를 연습한다" 같은 막연한 것 말고, "창가 자리를 요청하고 안내받는다"처럼
        끝났는지 아닌지 판별할 수 있는 것으로 씁니다
- persona_prompt: 봇이 연기할 상대의 지시문. **{lang}으로 씁니다.** 누구인지, 어떤
        태도인지, 무엇을 하려 하는지를 담습니다. 학습자가 아니라 상대를 묘사합니다.
        첫 대사를 따옴표로 정해주지 마세요 — 이 지시문은 매 턴 다시 모델에게
        전달되므로, 특정 문장을 지정하면 대화 내내 그 문장으로 되돌아가려 합니다.
        무엇을 물어보고 무엇을 안내할지를 쓰면 충분합니다

상대는 학습자를 가르치지 않습니다. 그 상황에 실제로 있을 법한 사람으로 행동합니다."""


SCENARIO_SYSTEM_SCRIPT = """당신은 한국인 학습자를 위한 {lang} 회화 대본을 만드는 사람입니다.
당신이 쓰는 언어는 한국어입니다. 대본의 대사는 {lang}으로 씁니다.

학습자가 연습하고 싶은 상황을 한 줄로 말했습니다. 그 상황의 짧은 대본을 만드세요.

- title: 학습자가 목록에서 알아볼 수 있는 짧은 한국어 제목
- lines: 대사 8줄. speaker는 "bot"과 "user"가 번갈아 나오고 **bot으로 시작합니다.**
        text는 {lang}으로, 실제 대화에서 쓰는 짧은 구어체로 씁니다.
        교과서 문장이 아니라 사람이 실제로 하는 말이어야 합니다"""


def build_scenario_messages(language, kind, wish) -> list[dict]:
    """Ask the model for a scenario the learner asked for by name.

    Korean system prompt for the same reason every other prompt here is: asking
    for Korean in English produced English, twice, and moving the instruction
    itself into Korean is what fixed it.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    template = SCENARIO_SYSTEM_FREE if kind == "free" else SCENARIO_SYSTEM_SCRIPT
    system = template.format(lang=language_name)
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"학습자가 연습하고 싶다고 한 것: {wish}"},
    ]
