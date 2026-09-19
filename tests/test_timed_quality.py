"""1분 말하기 질문 -- 실제 모델. `-m engine`에서만 돈다.

에디터 참고: prompts.TIMED_QUESTIONS_SYSTEM을 고치면 이 파일을 돌려본다.
"""
import pytest

from app import api

pytestmark = pytest.mark.engine

_HANGUL = api._HANGUL
_KANA = api._KANA
_LATIN_LETTER = api._LATIN_LETTER

# 테마 3개 x 언어 2개 (data/themes.json의 한국어 제목 그대로).
THEMES = ["카페·음식점 주문", "쇼핑·계산", "호텔"]
LEVELS = ["beginner", "beginner", "intermediate"]


@pytest.fixture(scope="module")
def served():
    """앱의 실제 경로(_generate_timed_questions)가 돌려준 것. 실패는 None."""
    out = []
    for language in ("en", "ja"):
        for theme, level in zip(THEMES, LEVELS):
            try:
                questions = api._generate_timed_questions(language, theme, level)
            except api._NoQuestions:
                questions = None
            out.append((language, theme, level, questions))
    return out


def test_print_samples_for_a_human_to_read(served):
    for language, theme, level, questions in served:
        print(f"\n[{language}/{level}] {theme}")
        for q in questions or []:
            print(f"   - {q['text']}  /  {q['meaning']}  /  {q['starter']}")


def test_every_theme_gets_two_or_three_questions(served):
    short = [(l, t) for l, t, _, qs in served if not qs or len(qs) < 2]
    print(f"\n2개 미만: {len(short)}/{len(served)}")
    assert not short, short


def test_meanings_are_korean(served):
    for language, theme, level, questions in served:
        for q in questions or []:
            assert _HANGUL.search(q["meaning"]), (language, theme, q)


def test_questions_are_in_the_target_language(served):
    for language, theme, level, questions in served:
        for q in questions or []:
            assert not _HANGUL.search(q["text"]), (language, theme, q)
            if language == "ja":
                assert _KANA.search(q["text"]), (language, theme, q)
                assert not _LATIN_LETTER.search(q["text"]), (language, theme, q)
            else:
                assert _LATIN_LETTER.search(q["text"]), (language, theme, q)
