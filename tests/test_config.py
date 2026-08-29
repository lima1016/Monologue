from app import config


def test_languages_and_modes_are_exactly_as_specified():
    assert config.LANGUAGES == ("en", "ja")
    assert config.MODES == ("free", "script", "lesson")
    assert config.LEVELS == ("beginner", "intermediate", "advanced")


def test_english_catalog_has_five_us_voices_and_no_british_ones():
    ids = [v["id"] for v in config.VOICE_CATALOG["en"]]
    assert ids == ["am_adam", "am_fenrir", "af_heart", "af_bella", "af_kore"]
    assert not any(i.startswith(("bf_", "bm_")) for i in ids)


def test_japanese_catalog_has_four_voicevox_speakers():
    ids = [v["id"] for v in config.VOICE_CATALOG["ja"]]
    assert ids == ["21", "13", "74", "8"]


def test_defaults_point_at_catalog_entries():
    assert config.DEFAULT_VOICE == {"en": "am_adam", "ja": "21"}
    for lang, voice in config.DEFAULT_VOICE.items():
        assert voice in [v["id"] for v in config.VOICE_CATALOG[lang]]


def test_kokoro_model_files_are_present():
    assert config.KOKORO_MODEL.exists()
    assert config.KOKORO_VOICES.exists()
