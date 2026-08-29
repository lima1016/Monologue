"""Generate Kokoro TTS samples for the Monologue bot-voice decision."""
from pathlib import Path
import soundfile as sf
from kokoro_onnx import Kokoro

root = Path(__file__).parent
out = root / "samples"
out.mkdir(exist_ok=True)

k = Kokoro(str(root / "kokoro-v1.0.onnx"), str(root / "voices-v1.0.bin"))

EN = "Hey, do you have a reservation? I can seat you by the window if you'd like."
JA_KANJI = "いらっしゃいませ。ご予約はされていますか？窓際のお席もご用意できますよ。"
JA_KANA = "いらっしゃいませ。ごよやくはされていますか？まどぎわのおせきもごようい できますよ。"

JOBS = [
    ("en-us", "af_heart",      EN,       "en_1_af_heart"),
    ("en-us", "af_bella",      EN,       "en_2_af_bella"),
    ("en-us", "am_michael",    EN,       "en_3_am_michael"),
    ("en-gb", "bm_george",     EN,       "en_4_bm_george_UK"),
    ("ja",    "jf_alpha",      JA_KANJI, "ja_1_jf_alpha_kanji"),
    ("ja",    "jf_gongitsune", JA_KANJI, "ja_2_jf_gongitsune_kanji"),
    ("ja",    "jm_kumo",       JA_KANJI, "ja_3_jm_kumo_kanji"),
    ("ja",    "jf_alpha",      JA_KANA,  "ja_4_jf_alpha_kana"),
]

for lang, voice, text, name in JOBS:
    try:
        audio, sr = k.create(text, voice=voice, speed=1.0, lang=lang)
        path = out / f"{name}.wav"
        sf.write(path, audio, sr)
        print(f"OK   {name}.wav  ({len(audio)/sr:.1f}s)")
    except Exception as e:
        print(f"FAIL {name}: {type(e).__name__}: {e}")
