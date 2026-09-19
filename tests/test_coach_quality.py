"""코치 한마디 -- 실제 모델. `pytest tests/test_coach_quality.py -m engine -s`
표를 보고 사람이 판단한다: 습관이 구체적인가, 실제 문장과 맞는가, 한국어만인가."""
import pytest

from app import api, prompts, llm

pytestmark = pytest.mark.engine

EN_ROWS = [
    {"text": "Yes water please And this is my first time to visit here Can you recommend Dishes", "fixed": "Yes, water please. And this is my first time to visit here. Can you recommend some dishes?", "tag": "어순", "correction": "문장을 구분해야 합니다."},
    {"text": "I'd like to sit the window. Sit.", "fixed": "I'd like to sit by the window.", "tag": "어순", "correction": "by the를 추가해야 합니다."},
    {"text": "Oh thank you I want to try grilled salmon And can I get Orange juice please", "fixed": "Oh, thank you. I want to try the grilled salmon. And can I get orange juice, please?", "tag": "어순", "correction": "문장 순서와 구분."},
    {"text": "I'd like to see oil seed", "fixed": "I'd like to see the oil seeds.", "tag": "관사", "correction": "the와 복수형."},
    {"text": "Okay I will take a At the bar for now and let me know if The window seat Available", "fixed": "Okay, I will take a seat at the bar for now and let me know if the window seat is available.", "tag": "어순", "correction": "seat, is가 빠짐."},
    {"text": "Yesterday I go to the office early", "fixed": "Yesterday I went to the office early.", "tag": "시제", "correction": "과거형."},
    {"text": "Last week I meet my manager", "fixed": "Last week I met my manager.", "tag": "시제", "correction": "과거형."},
]
JA_ROWS = [
    {"text": "昨日会社に行きます", "fixed": "昨日会社に行きました。", "tag": "시제", "correction": "과거형으로."},
    {"text": "先週友達と会います", "fixed": "先週友達と会いました。", "tag": "시제", "correction": "과거형으로."},
    {"text": "コーヒーをください、あと水もください、それと窓の席がいいです", "fixed": "コーヒーをください。水もお願いします。窓側の席がいいです。", "tag": "어순", "correction": "문장을 나눠야 합니다."},
    {"text": "駅は行きたいです", "fixed": "駅に行きたいです。", "tag": "조사", "correction": "に를 써야 합니다."},
    {"text": "学校は行きます", "fixed": "学校に行きます。", "tag": "조사", "correction": "に를 써야 합니다."},
]


@pytest.mark.parametrize("language,rows", [("en", EN_ROWS), ("ja", JA_ROWS)])
def test_coach_on_the_real_model(language, rows):
    for run in range(3):
        items = api._generate_coach(language, rows)
        print(f"\n[{language} run {run + 1}]")
        for i in items:
            print(f"  - {i['habit']} | {i['tip']} | {i['said']} -> {i['fixed']}")
        assert 1 <= len(items) <= 3
        for i in items:
            assert api._is_korean_meaning(i["habit"]) and i["said"] in [r["text"] for r in rows]
