r"""Generate every American-accent Kokoro voice and build a single self-contained
HTML page with inline audio, so the voice can be chosen by ear.

Usage:  venv\Scripts\python.exe docs\tts-spike\gen_us_picker.py
"""
import base64
import html
import io
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

REPO = Path(__file__).resolve().parents[2]
ENGINES = REPO / "engines" / "kokoro"
OUT = REPO / "docs" / "tts-spike" / "us_voices.html"

TEXT = "Hi! Do you have a reservation? I can seat you by the window."

k = Kokoro(str(ENGINES / "kokoro-v1.0.onnx"), str(ENGINES / "voices-v1.0.bin"))

# af_ = American female, am_ = American male. bf_/bm_ are British — excluded.
us = sorted(v for v in k.get_voices() if v.startswith(("af_", "am_")))
print(f"American voices: {len(us)}")

rows = []
for name in us:
    audio, sr = k.create(TEXT, voice=name, speed=1.0, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    b64 = base64.b64encode(buf.getvalue()).decode()
    sex = "여성" if name.startswith("af_") else "남성"
    rows.append((name, sex, len(audio) / sr, b64))
    print(f"  {name}  {len(audio)/sr:.1f}s")

cards = "\n".join(
    f"""  <div class="v">
    <div class="meta"><b>{html.escape(n)}</b><span class="s">{s} · {d:.1f}s</span></div>
    <audio controls preload="none" src="data:audio/wav;base64,{b}"></audio>
  </div>"""
    for n, s, d, b in rows
)

OUT.write_text(
    f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kokoro 미국 발음 음성 {len(rows)}종</title>
<style>
 :root {{ color-scheme: light dark; }}
 body {{ font-family: system-ui,-apple-system,"Segoe UI",sans-serif;
        max-width:820px; margin:0 auto; padding:24px; line-height:1.5; }}
 h1 {{ font-size:1.3rem; margin-bottom:2px; }}
 .sub {{ opacity:.7; font-size:.9rem; margin-bottom:20px; }}
 .q {{ background:rgba(128,128,128,.12); padding:10px 14px; border-radius:8px;
      margin-bottom:22px; font-size:.92rem; }}
 .v {{ display:flex; align-items:center; gap:14px; padding:9px 4px;
      border-bottom:1px solid rgba(128,128,128,.2); }}
 .meta {{ min-width:180px; display:flex; flex-direction:column; }}
 .meta b {{ font-family:ui-monospace,Consolas,monospace; font-size:.9rem; }}
 .s {{ opacity:.6; font-size:.75rem; }}
 audio {{ flex:1; height:34px; }}
 h2 {{ font-size:1rem; margin:26px 0 4px; opacity:.75; }}
</style></head><body>
<h1>Kokoro 미국 발음 음성 {len(rows)}종</h1>
<div class="sub">영국 발음(<code>bf_</code>/<code>bm_</code>)은 제외했습니다. 전부 같은 문장입니다.</div>
<div class="q">&ldquo;{html.escape(TEXT)}&rdquo;</div>
{cards}
</body></html>""",
    encoding="utf-8",
)
print(f"\nwrote {OUT}  ({OUT.stat().st_size/1024/1024:.1f} MB)")
