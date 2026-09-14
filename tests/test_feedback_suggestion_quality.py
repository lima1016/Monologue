"""① 교정 칩 suggestion이 상황에 맞는 원어민 한마디인가. `-m engine`에서만 돈다.

바꾸기 전 프롬프트로 한 번, 바꾼 뒤 한 번 돌려 수치를 커밋 메시지에 남긴다.
문턱은 바꾼 뒤 실측보다 낮게 둔다 -- 모델은 샘플링되므로 한 번의 빗나감은 회귀가 아니다.

자동으로 재는 것은 `fixed` 되풀이율뿐이다. "상황에 맞는가"는 자동 판정하지 않는다 --
출력 표본을 -s로 찍어 사람이 읽는다.

실측 (2026-09-14, qwen2.5:14b): fixed 되풀이 바꾸기 전 5/6·6/6 -> 바꾼 뒤 3/6. 남는 되풀이는
api._drop_if_quoted가 화면에서 지운다.

재측정 (2026-09-14, qwen2.5:14b, 계약 아포스트로피 가드 이후): fixed 되풀이 1/6.
_drop_if_quoted가 사용하는 _QUOTED_SPAN을 고쳐(계약 아포스트로피가 인용을 일찍
닫지 않도록) 다시 잰 수치다.
"""
import pytest

from app import api, llm, prompts

pytestmark = pytest.mark.engine

# (언어, 학습자 문장, 봇 직전 말, 상황 제목, 목표)
CASES = [
    ("en", "I want window seat", "Do you have a seating preference?", "공항 체크인", "창가 자리를 요청한다"),
    ("en", "I go to Busan yesterday", "So, what did you do over the weekend?", "주말 이야기", "주말에 한 일을 말한다"),
    ("en", "Can I pay card", "That'll be twelve dollars.", "카페 주문", "음료를 주문하고 계산한다"),
    ("en", "I am agree with the plan", "So we move the launch to Friday. Thoughts?", "팀 회의", "일정 변경에 의견을 말한다"),
    ("en", "My room is too cold", "Front desk, how can I help you?", "호텔 프런트", "방 문제를 알린다"),
    ("en", "I'd like a coffee.", "Hi there, what can I get you?", "카페 주문", "음료를 주문한다"),
    ("ja", "窓側の席がほしいです", "お座席のご希望はございますか。", "공항 체크인", "창가 자리를 요청한다"),
    ("ja", "昨日釜山に行きます", "週末は何をしましたか。", "주말 이야기", "주말에 한 일을 말한다"),
    ("ja", "カードで払うできますか", "お会計は千二百円です。", "카페 주문", "계산한다"),
    ("ja", "部屋が寒いです", "フロントでございます。どうなさいましたか。", "호텔 프런트", "방 문제를 알린다"),
    ("ja", "コーヒーをください。", "いらっしゃいませ。ご注文は？", "카페 주문", "음료를 주문한다"),
]


@pytest.fixture(scope="module")
def results():
    out = []
    for lang, text, bot_last, title, goal in CASES:
        fb = llm.chat_json(
            prompts.build_feedback_messages(lang, text, scenario_title=title,
                                            scenario_goal=goal, bot_last=bot_last),
            prompts.feedback_schema(lang),
        )
        out.append((lang, text, bot_last, fb))
    return out


def test_print_samples_for_a_human_to_read(results):
    for lang, text, bot_last, fb in results:
        print(f"\n[{lang}] bot: {bot_last}\n  학생: {text}\n  fixed: {fb.get('fixed')}"
              f"\n  suggestion: {fb.get('suggestion')}")


def test_suggestion_rarely_just_restates_fixed(results):
    """가드(api._drop_if_quoted)를 거치기 전 원본으로 잰다 -- 가드가 지운 뒤를 재면
    프롬프트가 나아졌는지가 아니라 가드가 일했는지를 재게 된다."""
    wrong = [fb for _, _, _, fb in results if fb.get("ok") is False]
    restated = [fb["suggestion"] for fb in wrong
                if isinstance(fb.get("fixed"), str)
                and api._drop_if_quoted(fb.get("suggestion"), fb["fixed"]) is None]
    print(f"\nfixed 되풀이: {len(restated)}/{len(wrong)}")
    assert len(restated) <= 3, restated


def test_suggestion_is_still_korean(results):
    bad = [fb.get("suggestion") for _, _, _, fb in results
           if sum(1 for ch in (fb.get("suggestion") or "") if "가" <= ch <= "힣") < 8]
    assert len(bad) <= 1, bad
