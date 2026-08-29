"""Kokoro Japanese with proper G2P: convert kanji -> kana via pyopenjtalk first."""
from pathlib import Path
import soundfile as sf
import pyopenjtalk
from kokoro_onnx import Kokoro

root = Path(__file__).parent
out = root / "samples"
out.mkdir(exist_ok=True)

TEXT = "いらっしゃいませ。ご予約はされていますか？窓際のお席もご用意できますよ。"


def kata_to_hira(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


kata = pyopenjtalk.g2p(TEXT, kana=True)
hira = kata_to_hira(kata)
print("original :", TEXT)
print("katakana :", kata)
print("hiragana :", hira)
print()

k = Kokoro(str(root / "kokoro-v1.0.onnx"), str(root / "voices-v1.0.bin"))

JOBS = [
    ("jf_alpha", hira, "ja_5_jf_alpha_FIXED"),
    ("jf_gongitsune", hira, "ja_6_jf_gongitsune_FIXED"),
    ("jm_kumo", hira, "ja_7_jm_kumo_FIXED"),
]

for voice, text, name in JOBS:
    try:
        audio, sr = k.create(text, voice=voice, speed=1.0, lang="ja")
        sf.write(out / f"{name}.wav", audio, sr)
        print(f"OK   {name}.wav  ({len(audio)/sr:.1f}s)")
    except Exception as e:
        print(f"FAIL {name}: {type(e).__name__}: {e}")
