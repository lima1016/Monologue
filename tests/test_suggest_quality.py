"""💡 뭐라고 하지? -- 실제 모델. `-m engine`에서만 돈다.

문턱은 실측보다 낮게 둔다. 실측 수치는 이 docstring에 적는다:
  2줄 이상 12/12, 뜻 없음 1/36, 원본 meaning 한국어 34/34 (2026-09-14, qwen2.5:14b)

알려진 한계: 뜻이 한국어이지만 틀릴 수 있다(예: 紅茶→레몬차, 인명 田中→다른 이름).
한글 검사는 언어만 보고 정확성은 못 본다.
"""
import pytest

from app import api, llm, prompts

pytestmark = pytest.mark.engine

# (언어, 봇 대사, 상황 제목, 목표, 수업 주제)
CASES = [
    ("en", "Welcome! Do you have a reservation with us?", "호텔 체크인", "예약을 확인하고 방 열쇠를 받는다", None),
    ("en", "So, how was your weekend?", "동료와 스몰토크", "주말 이야기를 나눈다", None),
    ("en", "Would you like something to drink while you wait?", "식당 대기", "자리를 기다리며 주문한다", None),
    ("en", "Great. Now try making your own sentence with 'used to'.", None, None, "used to"),
    ("en", "The meeting's been moved to three. Does that work for you?", "팀 회의", "일정 변경에 답한다", None),
    ("en", "What brings you to Seoul?", "공항 입국 심사", "방문 목적을 말한다", None),
    ("ja", "いらっしゃいませ。ご予約はございますか。", "호텔 체크인", "예약을 확인하고 방 열쇠를 받는다", None),
    ("ja", "週末は何をしましたか。", "동료와 스몰토크", "주말 이야기를 나눈다", None),
    ("ja", "お待ちの間、お飲み物はいかがですか。", "식당 대기", "자리를 기다리며 주문한다", None),
    ("ja", "では、「〜たことがある」を使って文を作ってみてください。", None, None, "〜たことがある"),
    ("ja", "会議が三時に変わりましたが、大丈夫ですか。", "팀 회의", "일정 변경에 답한다", None),
    ("ja", "どうして日本に来ましたか。", "공항 입국 심사", "방문 목적을 말한다", None),
]


@pytest.fixture(scope="module")
def served():
    """앱의 실제 경로(_generate_suggestions)가 돌려준 것. 실패는 None."""
    out = []
    for lang, bot, title, goal, topic in CASES:
        try:
            out.append((lang, bot, api._generate_suggestions(
                lang, bot, scenario_title=title, scenario_goal=goal, topic=topic)))
        except api._NoSuggestions:
            out.append((lang, bot, None))
    return out


def test_print_samples_for_a_human_to_read(served):
    for lang, bot, replies in served:
        print(f"\n[{lang}] {bot}")
        for r in replies or []:
            print(f"   - {r['text']}  /  {r['meaning']}")


def test_most_lines_get_at_least_two_replies(served):
    short = [bot for _, bot, replies in served if not replies or len(replies) < 2]
    print(f"\n2줄 미만: {len(short)}/{len(served)}")
    assert len(short) <= 2, short


def test_replies_do_not_all_open_the_same_way(served):
    """방향이 다르면 첫머리도 대개 다르다. 셋 다 'Yes, ...'로 시작하면 한 방향이다."""
    def opening(lang, text):
        return text.split()[0].lower().strip(",.!?") if lang == "en" else text[:2]
    same = [bot for lang, bot, replies in served
            if replies and len(replies) >= 2 and len({opening(lang, r["text"]) for r in replies}) == 1]
    assert len(same) <= 2, same


def test_shown_meanings_are_korean_and_rarely_missing(served):
    lines = [(r, bot) for _, bot, replies in served for r in replies or []]
    missing = [r["text"] for r, _ in lines if r["meaning"] is None]
    print(f"\n뜻 없음: {len(missing)}/{len(lines)}")
    assert all(api._is_korean_meaning(r["meaning"], source=r["text"]) for r, _ in lines if r["meaning"])
    assert len(missing) <= max(1, len(lines) // 5), missing


def test_the_models_own_meanings_mostly_are_korean():
    """대체 번역 전 원본 meaning. 대체 경로가 이 비율을 가려주므로 따로 잰다."""
    total = korean = 0
    for lang, bot, title, goal, topic in CASES:
        result = llm.chat_json(prompts.build_suggest_messages(lang, bot, scenario_title=title,
                                                              scenario_goal=goal, topic=topic),
                               prompts.suggest_schema(), temperature=0.7)
        for r in api._valid_replies(result.get("replies"), lang, bot):
            total += 1
            korean += bool(r["meaning"] and api._is_korean_meaning(r["meaning"], source=r["text"]))
    print(f"\n원본 meaning 한국어: {korean}/{total}")
    assert total and korean / total >= 0.6
