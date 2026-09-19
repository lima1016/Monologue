"""레벨 테스트 답하기 판정 -- 실제 모델. `pytest tests/test_leveltest_quality.py -m engine -s`
표를 보고 사람이 판단한다: 짧은 답이 A1인가, 평범한 답과 풍부한 답이 벌어지는가, 평이 한국어 한 줄인가.
답은 모두 이 파일을 위해 지어낸 것이다(실제 학습자 문장 아님)."""
import pytest

from app import api, leveltest

pytestmark = pytest.mark.engine

ANSWERS = {
    "en": {
        "short": {"text": "Weekend.", "wpm": 4, "long_pauses": 4},
        "b1": {"text": ("On weekends I usually get up late and have breakfast with my family. "
                        "In the afternoon I go to the gym or I meet my friends. "
                        "Sometimes we watch a movie, it is fun and I can relax."),
               "wpm": 88, "long_pauses": 2},
        "c1": {"text": ("Honestly, my weekends tend to revolve around recovering from the week. "
                        "I'll sleep in on Saturday, then head out for a long walk along the river, "
                        "which really helps me clear my head. Sunday is more of a planning day: "
                        "I batch-cook for the week and catch up with friends I've been neglecting."),
               "wpm": 142, "long_pauses": 0},
    },
    "ja": {
        "short": {"text": "週末。", "wpm": 5, "long_pauses": 4},
        "b1": {"text": ("週末はだいたい遅く起きて、家族と朝ごはんを食べます。午後はジムに行ったり、"
                        "友達に会ったりします。ときどき映画を見ます。楽しいです。"),
               "wpm": 120, "long_pauses": 2},
        "c1": {"text": ("正直に言うと、週末は平日の疲れを取るための時間になっています。土曜日はゆっくり寝て、"
                        "川沿いを長めに散歩すると頭がすっきりします。日曜日は一週間分の作り置きをしながら、"
                        "しばらく連絡していなかった友達と話すようにしています。"),
               "wpm": 210, "long_pauses": 0},
    },
}


@pytest.mark.parametrize("language", ["en", "ja"])
def test_answer_judging_on_the_real_model(language):
    questions = leveltest.load_bank(language)["questions"]
    print(f"\n[{language}]")
    for name, answer in ANSWERS[language].items():
        judged = api._judge_level_answers(language, {0: answer}, questions)
        j = judged.get(0)
        print(f"  {name:5} -> {j['cefr'] if j else None} | {j['comment'] if j else None}")
        assert j is not None, "the model returned no usable judgment"
        # The same rule the server applies: a word from the learner's own answer
        # (週末) may stand in the Korean comment.
        own = api._drop_answers_own_words(j["comment"], answer["text"])
        assert j["comment"] and api._is_korean_meaning(own)
        if name == "short":
            assert j["cefr"] == "A1"
