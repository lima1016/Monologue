import wave
from io import BytesIO

import pytest

from app import config, tts


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")


def test_cache_key_is_stable_for_identical_input():
    assert tts.cache_key("hello", "en", "am_adam") == tts.cache_key("hello", "en", "am_adam")


def test_cache_key_changes_with_text_language_or_voice():
    base = tts.cache_key("hello", "en", "am_adam")
    assert tts.cache_key("hello!", "en", "am_adam") != base
    assert tts.cache_key("hello", "ja", "am_adam") != base
    assert tts.cache_key("hello", "en", "af_kore") != base


def test_cache_key_is_filesystem_safe():
    key = tts.cache_key("窓際のお席／" + "x" * 500, "ja", "21")
    assert key.isalnum()
    assert len(key) <= 64


def test_unknown_language_is_rejected():
    with pytest.raises(tts.TTSError):
        tts.synthesize("hello", "fr", "am_adam")


def test_voice_outside_the_catalog_is_rejected():
    with pytest.raises(tts.TTSError):
        tts.synthesize("hello", "en", "bm_george")


def test_empty_text_is_rejected():
    with pytest.raises(tts.TTSError):
        tts.synthesize("   ", "en", "am_adam")


def test_dispatch_routes_by_language(monkeypatch):
    calls = {}

    def fake_en(text, voice):
        calls["en"] = (text, voice)
        return b"EN"

    def fake_ja(text, voice):
        calls["ja"] = (text, voice)
        return b"JA"

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    monkeypatch.setattr(tts.voicevox_backend, "synthesize_ja", fake_ja)

    assert tts.synthesize("hello", "en", "am_adam") == b"EN"
    assert tts.synthesize("こんにちは", "ja", "21") == b"JA"
    assert calls["en"] == ("hello", "am_adam")
    assert calls["ja"] == ("こんにちは", "21")


def test_markdown_is_stripped_before_reaching_the_backend(monkeypatch):
    seen = {}

    def fake_en(text, voice):
        seen["text"] = text
        return b"EN"

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    tts.synthesize("That's **great**", "en", "am_adam")
    assert seen["text"] == "That's great"


def test_synthesize_to_cache_writes_once_and_reuses(monkeypatch):
    hits = []

    def fake_en(text, voice):
        hits.append(1)
        return b"RIFFfake"

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    key1 = tts.synthesize_to_cache("hello", "en", "am_adam")
    key2 = tts.synthesize_to_cache("hello", "en", "am_adam")
    assert key1 == key2
    assert tts.cached_path(key1).read_bytes() == b"RIFFfake"
    assert len(hits) == 1


def test_no_cache_file_written_when_synthesis_fails(monkeypatch):
    def fake_en(text, voice):
        raise RuntimeError("boom")

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    with pytest.raises(tts.TTSError):
        tts.synthesize_to_cache("hello", "en", "am_adam")

    cache_files = list(config.TTS_CACHE_DIR.glob("*")) if config.TTS_CACHE_DIR.exists() else []
    assert cache_files == []


def test_no_scratch_file_left_when_cache_replace_fails(monkeypatch):
    """A disk failure during the cache write is surfaced as TTSError, not a raw OSError,
    so callers (see app.api._speak) can fall back to browser speech instead of a 500.
    The cleanup guarantee — no leftover .part scratch file — must still hold either way."""
    def fake_en(text, voice):
        return b"RIFFfake"

    def boom(src, dst):
        raise OSError("simulated failure")

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    monkeypatch.setattr(tts.os, "replace", boom)

    with pytest.raises(tts.TTSError):
        tts.synthesize_to_cache("hello", "en", "am_adam")

    assert list(config.TTS_CACHE_DIR.iterdir()) == []


@pytest.mark.engine
def test_kokoro_produces_real_playable_audio():
    data = tts.synthesize("Hello there, how are you today?", "en", "am_adam")
    with wave.open(BytesIO(data)) as w:
        assert w.getnchannels() == 1
        assert w.getnframes() / w.getframerate() > 0.5


@pytest.mark.engine
def test_voicevox_produces_real_playable_audio():
    if not tts.voicevox_backend.is_healthy():
        pytest.skip("VOICEVOX not running (docker compose up -d)")
    data = tts.synthesize("いらっしゃいませ。ご予約はされていますか？", "ja", "21")
    with wave.open(BytesIO(data)) as w:
        assert w.getnframes() / w.getframerate() > 0.5
