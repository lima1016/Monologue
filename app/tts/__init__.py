"""Speech synthesis: one entry point, a backend per language, an on-disk cache.

Callers never choose an engine. They pass a language and a voice id, and this
module routes to Kokoro (English, in-process) or VOICEVOX (Japanese, HTTP).
Swapping an engine means editing one backend module.
"""
import hashlib
import os
import tempfile
from pathlib import Path

import httpx

from app import config
from app.text_cleanup import clean_for_tts
from app.tts import kokoro_backend, voicevox_backend


class TTSError(Exception):
    """Synthesis could not be performed. The caller should fall back to browser TTS."""


def _valid_voice(language: str, voice: str) -> bool:
    return any(v["id"] == voice for v in config.VOICE_CATALOG.get(language, []))


def cache_key(text: str, language: str, voice: str) -> str:
    raw = f"{language}\x00{voice}\x00{text}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def cached_path(key: str) -> Path:
    return config.TTS_CACHE_DIR / f"{key}.wav"


def synthesize(text: str, language: str, voice: str) -> bytes:
    """Return WAV bytes for `text`. Raises TTSError if it cannot be produced."""
    if language not in config.LANGUAGES:
        raise TTSError(f"unsupported language: {language}")
    if not _valid_voice(language, voice):
        raise TTSError(f"voice {voice!r} is not in the {language} catalogue")

    spoken = clean_for_tts(text)
    if not spoken:
        raise TTSError("nothing to speak after sanitisation")

    try:
        if language == "en":
            return kokoro_backend.synthesize_en(spoken, voice)
        return voicevox_backend.synthesize_ja(spoken, voice)
    except httpx.HTTPError as exc:
        raise TTSError(f"VOICEVOX unreachable: {exc}") from exc
    except Exception as exc:  # engine-level failure — caller falls back
        raise TTSError(str(exc)) from exc


def synthesize_to_cache(text: str, language: str, voice: str) -> str:
    """Synthesise if needed, store under a content hash, return the cache key.

    Script mode replays fixed lines, so the second run of a scenario is free.
    """
    key = cache_key(clean_for_tts(text), language, voice)
    path = cached_path(key)
    if not path.exists():
        data = synthesize(text, language, voice)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Write to a temp file and move it into place, so an interrupted write
            # never leaves a truncated .wav that later reads would treat as valid.
            fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".part")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                os.replace(tmp, path)
            except BaseException:
                # Do not leave the scratch file behind if the move never happened.
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
        except OSError as exc:
            # The caller falls back to browser speech on TTSError. A disk problem
            # is still a TTS problem from the learner's seat — but keep the cause
            # in the message so it stays diagnosable.
            raise TTSError(f"could not write the audio cache: {exc}") from exc
    return key
