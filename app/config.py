"""Central configuration. Paths, service endpoints, catalogues, limits."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
AUDIO_DIR = REPO_ROOT / "audio"
TTS_CACHE_DIR = REPO_ROOT / "tts_cache"
STATIC_DIR = REPO_ROOT / "static"
DB_PATH = REPO_ROOT / "monologue.db"

KOKORO_MODEL = REPO_ROOT / "engines" / "kokoro" / "kokoro-v1.0.onnx"
KOKORO_VOICES = REPO_ROOT / "engines" / "kokoro" / "voices-v1.0.bin"

OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_MODEL = "qwen2.5:14b"
VOICEVOX_URL = "http://127.0.0.1:50021"

LANGUAGES = ("en", "ja")
MODES = ("free", "script", "lesson")
LEVELS = ("beginner", "intermediate", "advanced")

# English: US accent only. British voices (bf_/bm_) are deliberately excluded so
# the learner is never modelling a mixed accent.
VOICE_CATALOG = {
    "en": [
        {"id": "am_adam", "label": "Adam", "gender": "male"},
        {"id": "am_fenrir", "label": "Fenrir", "gender": "male"},
        {"id": "af_heart", "label": "Heart", "gender": "female"},
        {"id": "af_bella", "label": "Bella", "gender": "female"},
        {"id": "af_kore", "label": "Kore", "gender": "female"},
    ],
    # VOICEVOX speaker ids, default ("ノーマル") style only.
    "ja": [
        {"id": "21", "label": "剣崎雌雄", "gender": "male"},
        {"id": "13", "label": "青山龍星", "gender": "male"},
        {"id": "74", "label": "琴詠ニア", "gender": "female"},
        {"id": "8", "label": "春日部つむぎ", "gender": "female"},
    ],
}

DEFAULT_VOICE = {"en": "am_adam", "ja": "21"}

PREVIEW_TEXT = {
    "en": "Hi! Do you have a reservation? I can seat you by the window.",
    "ja": "いらっしゃいませ。ご予約はされていますか？",
}

MAX_TTS_CHARS = 400
DEFAULT_MAX_TURNS = 8
