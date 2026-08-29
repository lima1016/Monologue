"""English synthesis via Kokoro, running in-process.

The model is ~310 MB and takes a moment to load, so it is created once on first
use and kept. Japanese is deliberately NOT routed here: kokoro-onnx phonemises
with espeak, which cannot read kanji and stretches a sentence to three or four
times its correct length.
"""
import io
import threading

import soundfile as sf

from app import config

_lock = threading.Lock()
_engine = None


def _get_engine():
    global _engine
    with _lock:
        if _engine is None:
            from kokoro_onnx import Kokoro

            _engine = Kokoro(str(config.KOKORO_MODEL), str(config.KOKORO_VOICES))
        return _engine


def synthesize_en(text: str, voice: str) -> bytes:
    samples, sample_rate = _get_engine().create(text, voice=voice, speed=1.0, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
