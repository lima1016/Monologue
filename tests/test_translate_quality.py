"""번역 뜻의 품질을 실제 모델로. `-m engine`에서만 돈다.

목(mock) 스위트는 모델을 대신하므로 build_translate_messages가 망가져도
초록으로 남는다. 이 파일이 그걸 보는 유일한 계기다 -- 번역 프롬프트를 고친
뒤에는 반드시 돌린다.

문턱값은 측정치보다 낮게 둔다: 2026-09-13 실제 모델, 이 경로 그대로 일본어
29줄 x 3회에서 75%, 영어 10줄 x 2회에서 95%가 한국어 뜻으로 나왔다. 아래 줄들은
그 벤치마크에서 규칙만 있던 프롬프트가 새던 줄을 섞어 골랐다.
"""
import pytest

from app import api

pytestmark = pytest.mark.engine

JA = [
    "おはようございます。今日は早いですね。",
    "何か気になるところはありましたか。",
    "体調が悪いので、今日は早退してもいいですか。",
    "会議の資料は明日までに部長へ提出してください。",
    "駅の東口を出て、信号を渡った先に郵便局があります。",
    "週末は天気が良ければ、公園で写真を撮りたいです。",
    "薬は食後に一日三回飲んでください。",
    "この問題について、担当者から改めて連絡いたします。",
]

EN = [
    "Would you like your coffee for here or to go?",
    "The meeting has been moved to Thursday afternoon.",
    "Sorry, I didn't catch that. Could you say it again?",
    "What made you want to apply for this position?",
]


def _served(language, lines):
    meanings = []
    for line in lines:
        api._cached_translation.cache_clear()
        meanings.append(api._cached_translation(language, line))
    return [m for m in meanings if m is not None]


def test_japanese_lines_mostly_come_back_as_korean_meanings():
    served = _served("ja", JA)
    assert len(served) >= 5, f"{len(served)}/{len(JA)} -- 번역 프롬프트 회귀를 의심할 것"
    assert all(api._is_korean_meaning(m) for m in served)


def test_english_lines_come_back_as_korean_meanings():
    served = _served("en", EN)
    assert len(served) >= 3, f"{len(served)}/{len(EN)}"
    assert all(api._is_korean_meaning(m) for m in served)
