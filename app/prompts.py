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
#
# Length is deliberately not one of the levers. SPOKEN_STYLE caps every reply
# at three sentences as a hard rule, so an i+1 instruction phrased as "speak a
# little longer" cannot be obeyed -- and a model asked to do two contradictory
# things at once tends to satisfy the hard limit and drop the softer one,
# taking the rest of the pitch down with it. The levers here -- vocabulary,
# structure, question openness -- are the ones that still fit inside the cap.
# Do not restore length as a lever here.
LEVEL_PITCH = (
    "The student's current level is {level}. Pitch your own speech a small step "
    "above it, within the 1 to 3 sentence limit: reach for slightly less common "
    "words, vary your sentence structure instead of repeating the same shape, "
    "and ask questions that need more than yes or no. Do not drop to their "
    "level, and do not leap past it."
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
        # `or`, not a .get default: a built-in scenario omits `goal` entirely,
        # but a generated one round-trips through scenarios.from_row, which
        # always materialises the key -- so a scenario with no goal reads back
        # as {"goal": None}, the key is present, and a default keyed on absence
        # never fires. That put the literal text "Scene goal: None" into the
        # prompt. Same shape for max_turns, which is only defused today by
        # validate_item's int check -- luck, not design.
        prompt = FREE_TEMPLATE.format(
            style=style,
            persona=scenario["persona_prompt"],
            goal=scenario.get("goal") or "have a natural conversation",
            language=language_name,
            level_pitch=level_pitch,
        )
        max_turns = scenario.get("max_turns") or config.DEFAULT_MAX_TURNS
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
# No example's suggestion may quote its own fixed -- the model copies examples over rules (test_no_feedback_example_suggestion_quotes_its_own_fixed).
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
                "원어민이라면 'I stopped by the store yesterday.'처럼 더 가볍게 말하기도 해요."
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
            "suggestion": "원어민이라면 '昨日はレストランで食べてきました。'처럼 말하기도 해요.",
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

학생이 {lang} 문장을 한 줄 말했습니다. 이 문장은 학생이 소리 내어 말한 것을 음성
인식이 받아쓴 것입니다 — 잘못 알아들은 단어나 'uh', 'um' 같은 말버릇이 섞여 있을 수
있습니다. 그렇게 받아쓰기 오류로 보이는 부분은 문법 오류로 지적하지 마세요. 확신이
서지 않으면 ok를 true로 두세요. 없는 오류를 지어내는 것이 진짜 오류 하나를 놓치는
것보다 나쁩니다.

아래 다섯 항목을 채우세요.

- ok: 문법적으로 맞으면 true, 틀린 곳이 있으면 false
- fixed: 고친 문장 하나만. 이미 맞으면 원문 그대로. {lang}으로 씁니다
- tag: 틀린 부분의 종류. 아래 정의를 보고 정확히 하나만 고릅니다
{defs}
- correction: 무엇이 왜 틀렸는지. 한국어로 두 문장 이내
- suggestion: 이 상황에서 원어민이라면 이 말을 어떻게 했을지. 학생이 하려던 뜻은 그대로
  두고, 상대방이 직전에 한 말과 대화 목표에 자연스럽게 이어지는 한마디를 따옴표로 인용해
  보여줍니다. correction과 같은 지적을 되풀이하지 말고, fixed 문장을 그대로 인용하지
  마세요 -- fixed와는 다른 표현이어야 합니다. 문장이 이미 맞을 때도 쓸 수 있는 다른
  표현으로 씁니다. 한국어로 두 문장 이내

tag는 correction에서 실제로 지적한 내용과 일치해야 합니다.

correction과 suggestion은 반드시 한국어로 씁니다. 인용하는 {lang} 예문만 {lang}으로 둡니다.
마크다운과 이모지는 쓰지 않습니다."""


def _feedback_context(*, scenario_title=None, scenario_goal=None,
                      bot_last=None, topic=None) -> str:
    """Build the optional context paragraph for the feedback system prompt.

    Returns "" when there is nothing to say (first turn, scenario-less lesson
    mode) so the caller can append it unconditionally without ever leaving a
    "Scene goal: None"-shaped hole in the prompt -- this file already learned
    that lesson once, in build_system_prompt's free-mode branch.
    """
    lines = []
    if scenario_title:
        goal_part = f" (목표: {scenario_goal})" if scenario_goal else ""
        lines.append(f"- 지금 상황: {scenario_title}{goal_part}")
    if bot_last:
        lines.append(f"- 상대방(봇)이 바로 직전에 한 말: \"{bot_last}\"")
    if topic:
        lines.append(f"- 오늘 수업 주제: {topic}")
    if not lines:
        return ""
    return (
        "\n\n참고할 문맥입니다. 학생이 무엇을 말하려 했는지 판단하고, suggestion을"
        " 이 상황에 맞추는 데 쓰세요. 문맥 문장을 그대로 베끼지는 마세요.\n" + "\n".join(lines)
    )


def build_feedback_messages(language, user_text, *, scenario_title=None,
                            scenario_goal=None, bot_last=None, topic=None) -> list[dict]:
    """Ask for structured grammar feedback on one learner line.

    The system prompt is written in Korean, and that is the fix, not a style
    choice. The previous version asked for Korean output *in English*; the model
    answered in the language it was addressed in, and English corrections are
    still sitting in the messages table from that period. Moving the instruction
    itself into Korean took the spike from unreliable to 10/10 (en) and 8/8 (ja).

    Few-shot examples stay -- a stated rule alone was not enough to hold the
    local model, especially on already-correct lines.

    Context (scenario, the bot's last line, lesson topic) goes into the system
    prompt as its own trailing paragraph, never into the few-shot user turns.
    Those turns are a fixed "학생이 말한 문장: ..." shape with no context of
    their own; giving only the real query that extra shape would make it look
    different from every worked example the model just saw, and the local
    model latches onto that structural mismatch rather than the content. All
    context is optional and any piece that's missing (first turn, a
    scenario-less lesson) is simply left out of the paragraph -- see
    _feedback_context.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    system = FEEDBACK_SYSTEM.format(
        lang=language_name, defs=FEEDBACK_TAG_DEFINITIONS[language]
    )
    system += _feedback_context(
        scenario_title=scenario_title, scenario_goal=scenario_goal,
        bot_last=bot_last, topic=topic,
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
- lines: 대사 16줄. speaker는 "bot"과 "user"가 번갈아 나오고 **bot으로 시작합니다.**
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


_LIBRARY_PREVIOUS = 10


def build_library_script_messages(language, theme_title, situation, previous) -> list[dict]:
    """라이브러리용 대본 한 편. 같은 테마에서 30편을 만들면 서로 닮아가므로, 최근에
    만든 것의 제목과 첫 대사를 보여주고 다르게 쓰라고 한다."""
    system = SCENARIO_SYSTEM_SCRIPT.format(lang=KOREAN_LANGUAGE_NAMES[language])
    system += "\n초보 학습자가 소리 내어 따라 읽을 대본입니다. 한 줄은 짧게 씁니다."
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    user = f"테마: {theme_title}\n세부 상황: {situation}"
    recent = list(previous)[-_LIBRARY_PREVIOUS:]
    if recent:
        listed = "\n".join(f"- 제목: {p['title']} / 첫 대사: {p['opening']}" for p in recent)
        user += f"\n\n이미 만든 대본입니다. 제목, 첫 대사, 흐름이 이것들과 다르게 쓰세요.\n{listed}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


_TRANSLATE_SOURCE = {"ja": "일본어", "en": "영어"}

TRANSLATE_SYSTEM = """당신은 {source}를 한국어로 옮기는 번역가입니다.

주어진 {source} 문장의 뜻을 자연스러운 한국어 한 줄로만 답하세요.
답은 반드시 한글로만 씁니다. 중국어, 한자, {source} 원문을 답에 섞지 마세요.
설명, 문법 풀이, 로마자, 원문 반복을 넣지 마세요. 번역문만 답하세요."""

# 예시 문장은 앱이 실제로 만드는 대사의 모양을 따른다: 손님을 맞는 질문,
# 한자가 많은 업무 문장, 두 문장짜리 대사. 벤치마크에서 새는 자리가 바로
# 그런 줄이었다(한국어로 시작해 두 번째 문장에서 중국어로 넘어감).
TRANSLATE_EXAMPLES = {
    "ja": [
        ("いらっしゃいませ。何名様ですか？", "어서 오세요. 몇 분이세요?"),
        ("会議の時間が変更になったので、確認をお願いします。",
         "회의 시간이 바뀌었으니 확인 부탁드립니다."),
        ("すみません、駅までの道を教えていただけますか。", "실례합니다, 역까지 가는 길을 알려주실 수 있나요?"),
        ("大丈夫ですよ。少し休んでから始めましょう。", "괜찮아요. 조금 쉬었다가 시작해요."),
    ],
    "en": [
        ("Welcome! How many are in your party?", "어서 오세요! 몇 분이세요?"),
        ("Could you send me the report by Friday?", "금요일까지 보고서를 보내주실 수 있나요?"),
        ("Take the second left and it's right there.", "두 번째에서 왼쪽으로 돌면 바로 거기 있어요."),
        ("No worries. Let's take a short break first.", "괜찮아요. 먼저 잠깐 쉬어요."),
    ],
}


def build_translate_messages(language, text) -> list[dict]:
    """한 줄짜리 뜻을 요청한다.

    시스템 프롬프트가 한국어인 것은 style이 아니라 fix다 -- build_feedback_messages의
    docstring에 적힌 것과 같은 이유로, 이 로컬 모델은 자기가 불린 언어로 답한다.
    영어로 "answer in Korean"이라고 쓰면 영어 답이 섞여 나온다.

    실제 모델로 일본어 29줄을 세 번씩(87회) 돌린 프롬프트 탐침이 이 모양을
    정했다. 아래 횟수는 탐침 자체의 한국어 판정으로 센, 87회 중 샌 횟수다:
    - 규칙만: 47회가 중국어로 샘. 예시 대화를 더해도 44회 -- 예시만으로는 못 막는다.
    - 사용자 턴을 한국어 요청으로 감싸면 38회(한국어 56%). 마지막 턴이 순수
      일본어면 모델이 그 문자권으로 끌려가는데, 감싸면 그 끌림이 약해진다.
    - 샌 답에 한 번 되묻기(build_translate_retry_messages)까지 하면 18회(79%).
    앱의 실제 경로를 _is_korean_meaning으로 잰 수치는 이와 다르다: 일본어 87회 중
    65회(75%), 영어 20회 중 19회(95%) -- tests/test_translate_quality.py 참고.
    남는 누출은 api._cached_translation의 한글 검사가 503으로 막는다 -- 틀린
    언어로 뜻을 보여주지는 않는다.
    """
    source = _TRANSLATE_SOURCE[language]
    messages = [{"role": "system", "content": TRANSLATE_SYSTEM.format(source=source)}]
    for original, meaning in TRANSLATE_EXAMPLES[language]:
        messages.append({"role": "user", "content": _translate_request(source, original)})
        messages.append({"role": "assistant", "content": meaning})
    messages.append({"role": "user", "content": _translate_request(source, text)})
    return messages


def _translate_request(source, text):
    return f"다음 {source} 문장을 자연스러운 한국어 한 줄로 옮기세요. 번역문만 한글로 답하세요.\n\n{source}: {text}"


TRANSLATE_RETRY = "방금 답에 한자나 일본어, 중국어, 영어 원문이 섞였습니다. 같은 뜻을 한글로만 다시 한 줄로 쓰세요."


def build_translate_retry_messages(messages, bad_answer) -> list[dict]:
    """샌 답을 대화에 그대로 보여주고 한국어로 다시 요청한다. 한 번만 쓴다 --
    두 번째에도 새는 줄은 세 번째도 거의 같은 곳에서 샜다(온도 0.2)."""
    return [*messages,
            {"role": "assistant", "content": bad_answer},
            {"role": "user", "content": TRANSLATE_RETRY}]


def suggest_schema() -> dict:
    """What 💡 뭐라고 하지? asks for. Ollama makes it parse; api._valid_replies
    decides what is actually shown (language, length, duplicates, Korean meaning)."""
    return {
        "type": "object",
        "properties": {
            "replies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}, "meaning": {"type": "string"}},
                    "required": ["text", "meaning"],
                },
            },
        },
        "required": ["replies"],
    }


_LEVEL_KOREAN = {"beginner": "초급", "intermediate": "중급", "advanced": "고급"}

_SUGGEST_LENGTH_RULE = {
    "en": "한 대답은 영어 12단어 이하입니다",
    "ja": "한 대답은 일본어 30자 이하입니다",
}

# Editing this string? Run `pytest tests/test_suggest_quality.py -m engine`
# against the real model afterward.
SUGGEST_SYSTEM = """당신은 한국인 학생의 {lang} 회화 연습을 돕는 한국어 원어민 교사입니다.
당신이 설명에 쓰는 언어는 한국어입니다. {lang}은(는) 학생이 소리 내어 말할 문장에만 씁니다.

학생이 {lang}로 대화하는 중인데, 상대방이 방금 한 말에 뭐라고 대답할지 막막해합니다.
학생이 그대로 따라 말할 수 있는 대답을 2~3개 주세요.

- 대답마다 방향이 달라야 합니다. 예를 들어 하나는 받아들이기, 하나는 다른 것을
  요청하거나 사양하기, 하나는 되묻거나 질문하기. 같은 말을 단어만 바꾼 대답은 안 됩니다
- 실제 사람이 하는 짧은 입말로 씁니다. {length_rule}
- 학생 수준({level})에 맞는 쉬운 단어를 씁니다
- text: 학생이 말할 {lang} 문장 하나. 설명, 괄호, 따옴표, 로마자를 넣지 않습니다
- meaning: 그 문장의 뜻을 자연스러운 한국어 한 줄로. 한글로만 씁니다

마크다운과 이모지는 쓰지 않습니다."""

# One worked example per language: the same invitation, answered three
# different ways (accept / decline-with-alternative / ask back) -- the variety
# the prompt asks for, shown rather than only stated.
SUGGEST_EXAMPLES = {
    "en": (
        "Would you like to grab lunch together tomorrow?",
        [
            {"text": "Sure, that sounds great!", "meaning": "좋아요, 좋은 생각이에요!"},
            {"text": "Sorry, I'm busy tomorrow. How about Friday?", "meaning": "미안해요, 내일은 바빠요. 금요일은 어때요?"},
            {"text": "Where were you thinking of going?", "meaning": "어디 가려고 생각했어요?"},
        ],
    ),
    "ja": (
        "明日、一緒にお昼を食べませんか。",
        [
            {"text": "いいですね、ぜひ！", "meaning": "좋네요, 꼭 같이 먹어요!"},
            {"text": "すみません、明日はちょっと忙しいです。", "meaning": "죄송해요, 내일은 좀 바빠요."},
            {"text": "どこに行きますか。", "meaning": "어디로 가요?"},
        ],
    ),
}


def _suggest_request(bot_line: str) -> str:
    return f"상대방이 방금 한 말: \"{bot_line}\"\n학생이 할 수 있는 대답을 방향이 다르게 2~3개 주세요."


def _suggest_context(*, scenario_title=None, scenario_goal=None, topic=None, recent=()) -> str:
    """Same rule as _feedback_context: a missing piece is left out, never
    written as None, and no pieces at all means no paragraph."""
    lines = []
    if scenario_title:
        goal_part = f" (목표: {scenario_goal})" if scenario_goal else ""
        lines.append(f"- 지금 상황: {scenario_title}{goal_part}")
    if topic:
        lines.append(f"- 오늘 수업 주제: {topic}")
    if recent:
        lines.append("- 최근 대화:")
        for speaker, text in recent:
            who = "상대방" if speaker == "bot" else "학생"
            lines.append(f"  {who}: {text}")
    if not lines:
        return ""
    return "\n\n참고할 문맥입니다. 대답이 이 상황과 대화 흐름에 맞도록 쓰세요.\n" + "\n".join(lines)


def build_suggest_messages(language, bot_last, *, level="beginner", scenario_title=None,
                           scenario_goal=None, topic=None, recent=()) -> list[dict]:
    """Ask for 2-3 replies the learner could say to the bot's last line.

    Korean system prompt, for the reason every prompt in this file is Korean:
    this model answers in the language it is addressed in. Context goes into
    the system prompt, never the user turn, so the query turn keeps exactly
    the example turn's shape.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    system = SUGGEST_SYSTEM.format(
        lang=language_name, length_rule=_SUGGEST_LENGTH_RULE[language],
        level=_LEVEL_KOREAN.get(level, "초급"),
    )
    system += _suggest_context(scenario_title=scenario_title, scenario_goal=scenario_goal,
                               topic=topic, recent=recent)
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    example_bot, example_replies = SUGGEST_EXAMPLES[language]
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": _suggest_request(example_bot)},
        {"role": "assistant", "content": json.dumps({"replies": example_replies}, ensure_ascii=False)},
        {"role": "user", "content": _suggest_request(bot_last)},
    ]


# Editing this string? Run `pytest tests/test_coach_quality.py -m engine`
# against the real model afterward, and look at the table it prints.
COACH_SYSTEM = """당신은 한국인 학생의 {lang} 말하기를 지도하는 한국어 원어민 코치입니다.
설명은 한국어로만 씁니다.

아래는 학생이 최근 말하기 연습에서 틀린 문장들입니다. 번호마다 학생이 한 말, 고친 문장,
교사의 설명이 있습니다. 학생이 한 말과 고친 문장을
직접 비교해서 여러 문장에 되풀이되는 습관을 찾으세요.

습관을 2~3개 주세요. 가장 자주 되풀이되는 것부터.
- habit: 학생이 실제로 하는 일을 구체적으로 한 문장(40자 이내). "문법이 약해요"처럼 막연하면 안 됩니다
- tip: 다음에 말할 때 바로 해 볼 수 있는 행동 한 문장(40자 이내). {lang} 표현을 넣을 때는 따옴표로 감쌉니다
- example_no: 이 습관이 가장 잘 보이는 문장의 번호 하나

마크다운과 이모지는 쓰지 않습니다."""

# Synthetic on purpose: none of these is a real learner's sentence, and their
# error families (third-person -s, a missing "a", question word order) are
# kept apart from the habits real learners here show most (run-on sentences,
# past tense, dropped prepositions) -- a few-shot built from real rows taught
# the model to copy its habits onto unrelated rows. Rows keep a "tag" key for
# shape (rows from the real data have one too), but the prompt never shows it
# to the model -- see _coach_input.
COACH_EXAMPLE_INPUT = [
    {"text": "She like coffee in the morning", "fixed": "She likes coffee in the morning.", "tag": "단복수", "correction": "주어가 she이면 likes를 써야 합니다."},
    {"text": "I have question about the menu", "fixed": "I have a question about the menu.", "tag": "어휘", "correction": "question 앞에 a를 넣어야 합니다."},
    {"text": "Where you are going after work?", "fixed": "Where are you going after work?", "tag": "어순", "correction": "are를 you 앞에 둬야 합니다."},
    {"text": "My brother work at a bank", "fixed": "My brother works at a bank.", "tag": "어순", "correction": "주어가 한 사람이면 works입니다."},
    {"text": "Can you give me pen?", "fixed": "Can you give me a pen?", "tag": "관사", "correction": "pen 앞에 a가 필요합니다."},
    {"text": "What time the store opens?", "fixed": "What time does the store open?", "tag": "어순", "correction": "does를 넣고 주어 앞에 둬야 합니다."},
]
COACH_EXAMPLE_OUTPUT = {"items": [
    {"habit": "한 사람이 주어일 때 동사 끝의 -s를 빠뜨려요",
     "tip": "she, he, 한 사람 뒤에는 \"likes\"처럼 -s를 붙여요", "example_no": 1},
    {"habit": "셀 수 있는 물건 하나를 말할 때 a를 빠뜨려요",
     "tip": "물건 하나는 \"a pen\"처럼 a부터 붙여 말해요", "example_no": 2},
    {"habit": "물어볼 때 주어를 동사보다 먼저 말해요",
     "tip": "Where, What 뒤에는 \"are you\"처럼 동사부터 둬요", "example_no": 3},
]}

_COACH_CORRECTION_CHARS = 80


def _coach_input(rows) -> str:
    lines = []
    for i, r in enumerate(rows, 1):
        why = (r.get("correction") or "").replace("\n", " ")[:_COACH_CORRECTION_CHARS]
        again = f" ({r['reps']}번 반복)" if (r.get("reps") or 1) > 1 else ""
        lines.append(f"{i}. 학생: {r['text']} / 고친 문장: {r['fixed']} / 설명: {why}{again}")
    return "틀린 문장들:\n" + "\n".join(lines) + "\n\n되풀이되는 습관을 2~3개 주세요."


def coach_schema() -> dict:
    return {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {"habit": {"type": "string"}, "tip": {"type": "string"},
                       "example_no": {"type": "integer"}},
        "required": ["habit", "tip", "example_no"]}}},
        "required": ["items"]}


def build_coach_messages(language, rows) -> list[dict]:
    """Few-shot, not rules alone: this file's feedback prompt learned that
    this model does not follow rules it has not been shown. The example is in
    English for both languages -- it teaches the shape (habits, not tags), and
    the query turn carries the learner's own language."""
    system = COACH_SYSTEM.format(lang=KOREAN_LANGUAGE_NAMES[language])
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": _coach_input(COACH_EXAMPLE_INPUT)},
        {"role": "assistant", "content": json.dumps(COACH_EXAMPLE_OUTPUT, ensure_ascii=False)},
        {"role": "user", "content": _coach_input(rows)},
    ]


# Editing this string? Run `pytest tests/test_timed_quality.py -m engine`.
TIMED_QUESTIONS_SYSTEM = """당신은 한국인 학생의 {lang} 말하기 연습을 돕는 한국어 원어민 교사입니다.
설명은 한국어로만 씁니다.

학생이 1분 동안 혼자 말할 질문을 3개 주세요. 주제: {theme}. 학생 수준: {level}.
- text: 학생에게 묻는 {lang} 질문 한 문장. 학생 수준에 맞는 쉬운 단어로, 자기 경험이나 생각을 1분 동안 말할 수 있게 열린 질문으로
- meaning: 그 질문의 뜻을 자연스러운 한국어 한 줄로. 한글로만 씁니다
- starter: 학생이 말을 시작할 수 있는 {lang} 첫 마디(문장 앞부분, "..."으로 끝남)
세 질문은 서로 다른 방향이어야 합니다(경험, 계획, 의견처럼).
마크다운과 이모지는 쓰지 않습니다."""

TIMED_QUESTIONS_EXAMPLES = {
    "en": ("일상 · 주말", [
        {"text": "What did you do last weekend?", "meaning": "지난 주말에 뭐 했어요?", "starter": "Last weekend, I..."},
        {"text": "What is your plan for this weekend?", "meaning": "이번 주말 계획이 뭐예요?", "starter": "This weekend, I'm going to..."},
        {"text": "Do you like to stay home or go out on weekends? Why?", "meaning": "주말엔 집에 있는 게 좋아요, 나가는 게 좋아요? 왜요?", "starter": "I like to... because..."},
    ]),
    "ja": ("日常 · 週末", [
        {"text": "先週末は何をしましたか。", "meaning": "지난 주말에 뭐 했어요?", "starter": "先週末は..."},
        {"text": "今週末の予定は何ですか。", "meaning": "이번 주말 계획이 뭐예요?", "starter": "今週末は..."},
        {"text": "週末は家にいるのと出かけるのと、どちらが好きですか。", "meaning": "주말엔 집에 있는 것과 나가는 것 중 어느 쪽이 좋아요?", "starter": "私は...が好きです。なぜなら..."},
    ]),
}


def timed_questions_schema() -> dict:
    return {"type": "object", "properties": {"questions": {"type": "array", "items": {
        "type": "object",
        "properties": {"text": {"type": "string"}, "meaning": {"type": "string"}, "starter": {"type": "string"}},
        "required": ["text", "meaning", "starter"]}}}, "required": ["questions"]}


def build_timed_questions_messages(language, theme_title, level) -> list[dict]:
    system = TIMED_QUESTIONS_SYSTEM.format(lang=KOREAN_LANGUAGE_NAMES[language], theme=theme_title,
                                           level=_LEVEL_KOREAN.get(level, "초급"))
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    example_theme, example = TIMED_QUESTIONS_EXAMPLES[language]
    ask = lambda t: f"주제: {t}\n1분 말하기 질문 3개를 주세요."
    return [{"role": "system", "content": system},
            {"role": "user", "content": ask(example_theme)},
            {"role": "assistant", "content": json.dumps({"questions": example}, ensure_ascii=False)},
            {"role": "user", "content": ask(theme_title)}]


# 원어민이라면: 학생이 1분 동안 한 말을 원어민이 같은 질문에 답하듯 다시 말한 것.
# 학생 수준보다 한 단계 위(i+1)로 -- 고급은 그대로 고급.
_NATIVE_TARGET = {"beginner": "중급", "intermediate": "고급", "advanced": "고급"}

_NATIVE_LENGTH_RULE = {
    "en": "영어 120~160단어",
    "ja": "일본어 250~350자",
}

# Editing this string? Look at a few real answers afterward (spec: Korean
# leaking in, length).
TIMED_NATIVE_SYSTEM = """당신은 한국인 학생의 {lang} 말하기를 돕는 {lang} 원어민 교사입니다.
학생이 질문 하나에 1분 동안 {lang}로 답했습니다. 학생이 한 말을 문장별로 받아 적어 줍니다.

- native: 같은 질문에 원어민이 1분 동안 답하듯, 학생이 한 이야기를 자연스러운 {lang} 입말로 다시 말해 주세요
  - 학생이 말한 내용과 순서를 따릅니다. 학생이 하지 않은 새 이야기를 지어내지 않습니다
  - 학생 수준은 {level}입니다. native는 {target} 수준의 단어와 문장으로 씁니다
  - 길이는 {length_rule}입니다
  - {lang}로만 씁니다. 한국어, 설명, 괄호, 번역, 로마자를 넣지 않습니다
- level: 학생이 한 말로 본 학생 수준. beginner, intermediate, advanced 중 하나

마크다운과 이모지는 쓰지 않습니다."""

# One synthetic example per language -- invented for this prompt, never a real
# learner's sentences.
TIMED_NATIVE_EXAMPLES = {
    "en": (
        "What did you do last weekend?",
        ["Last weekend I went to the park with my sister.",
         "We ate sandwiches and we played badminton.",
         "The weather was very good, so we stayed long time.",
         "I was tired but it was fun."],
        {"native": (
            "Last weekend was really nice, actually. On Saturday I went to the park with my "
            "younger sister. We don't get to hang out that often, so we'd been planning it for a "
            "while. We packed some sandwiches and a couple of drinks, found a quiet spot under a "
            "tree, and just ate and chatted for a bit. After lunch we played badminton. Neither of "
            "us is very good at it, so we spent most of the time laughing and chasing the "
            "shuttlecock around. The weather was perfect, sunny but not too hot, with a light "
            "breeze, so we ended up staying much longer than we'd planned. We didn't leave until "
            "the sun started to go down. By the time I got home I was completely worn out, but it "
            "was honestly one of the best days I've had in a while, and we've already said we "
            "want to do it again soon."),
         "level": "beginner"},
    ),
    "ja": (
        "先週末は何をしましたか。",
        ["先週末は妹と公園に行きました。",
         "サンドイッチを食べて、バドミントンをしました。",
         "天気がとてもよかったので、長い時間いました。",
         "疲れましたが、楽しかったです。"],
        {"native": (
            "先週末は、妹と一緒に近所の公園に行ってきました。二人とも忙しくて、なかなか"
            "ゆっくり会えないので、前から行こうねと話していたんです。朝のうちにサンドイッチを"
            "作って、飲み物と一緒に持っていきました。木の下の静かな場所を見つけて、お昼を"
            "食べながらいろいろおしゃべりしました。そのあとはバドミントンをしたんですが、"
            "二人ともあまり上手じゃないので、ずっと笑いっぱなしでした。天気もすごくよくて、"
            "暑すぎず、風も気持ちよかったので、つい予定よりずっと長くいてしまいました。"
            "夕方になってやっと帰りましたが、家に着いたらもうくたくたでした。それでも本当に"
            "楽しい一日だったので、また近いうちに行きたいねと話しています。"),
         "level": "beginner"},
    ),
}


def timed_native_schema() -> dict:
    return {"type": "object", "properties": {
        "native": {"type": "string"},
        "level": {"type": "string", "enum": list(config.LEVELS)},
    }, "required": ["native", "level"]}


def _timed_native_request(topic, sentences) -> str:
    lines = "\n".join(f"- {s}" for s in sentences)
    return f"질문: {topic}\n학생이 한 말:\n{lines}\n원어민이라면 어떻게 말할지 보여 주세요."


def build_timed_native_messages(language, topic, sentences, level) -> list[dict]:
    lang = KOREAN_LANGUAGE_NAMES[language]
    system = TIMED_NATIVE_SYSTEM.format(
        lang=lang, level=_LEVEL_KOREAN.get(level, "초급"),
        target=_NATIVE_TARGET.get(level, "중급"), length_rule=_NATIVE_LENGTH_RULE[language],
    )
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    example_topic, example_sentences, example = TIMED_NATIVE_EXAMPLES[language]
    return [{"role": "system", "content": system},
            {"role": "user", "content": _timed_native_request(example_topic, example_sentences)},
            {"role": "assistant", "content": json.dumps(example, ensure_ascii=False)},
            {"role": "user", "content": _timed_native_request(topic, sentences)}]
