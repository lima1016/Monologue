"""Whisper를 실제 모델로. `-m engine`에서만 돈다.

목(mock) 스위트는 stt.transcribe를 대신하므로, 모델 이름·옵션·CUDA DLL 등록이
망가져도 초록이다. 앱 TTS로 만든 음성은 발음이 깨끗하므로 이것은 "동작하는가"의
계기이지 한국어 화자 발음의 정확도 측정이 아니다.
"""
import re
import unicodedata
from difflib import SequenceMatcher

import pytest

from app import config, stt, tts

pytestmark = pytest.mark.engine

LINES = [
    ("en", "Could you tell me how long it takes to get to the airport?"),
    ("en", "I've been working as a software engineer for about three years."),
    ("ja", "すみません、駅までの道を教えていただけますか。"),
    ("ja", "体調が悪いので、今日は早退してもいいですか。"),
]


def _bare(text):
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\s\W_]+", "", text)


@pytest.fixture(scope="module")
def model():
    stt._reset_for_tests()
    stt.load()
    if stt.status() != "ready":
        pytest.skip("Whisper could not load on this machine (CUDA?)")
    yield
    stt._reset_for_tests()


@pytest.mark.parametrize("language, text", LINES)
def test_whisper_hears_a_clear_sentence(model, language, text):
    wav = tts.synthesize(text, language, config.DEFAULT_VOICE[language])
    heard = stt.transcribe(wav, language)
    ratio = SequenceMatcher(None, _bare(heard), _bare(text)).ratio()
    assert ratio >= 0.9, f"{heard!r} vs {text!r} ({ratio:.2f})"
