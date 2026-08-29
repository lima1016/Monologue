"""Japanese synthesis via the VOICEVOX HTTP engine (Docker).

VOICEVOX handles kanji and pitch accent internally, which is why Japanese goes
here rather than through Kokoro.
"""
import httpx

from app import config

_TIMEOUT = httpx.Timeout(60.0, connect=5.0)


def is_healthy() -> bool:
    try:
        r = httpx.get(f"{config.VOICEVOX_URL}/version", timeout=3.0)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def synthesize_ja(text: str, speaker_id: str) -> bytes:
    with httpx.Client(timeout=_TIMEOUT) as client:
        query = client.post(
            f"{config.VOICEVOX_URL}/audio_query",
            params={"text": text, "speaker": speaker_id},
        )
        query.raise_for_status()
        audio = client.post(
            f"{config.VOICEVOX_URL}/synthesis",
            params={"speaker": speaker_id},
            json=query.json(),
        )
        audio.raise_for_status()
        return audio.content
