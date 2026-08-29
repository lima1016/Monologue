r"""Generate one sample per VOICEVOX speaker (default style) and build a single
self-contained HTML page with inline audio, so the Japanese voice can be chosen by ear.

Requires the VOICEVOX engine running on 127.0.0.1:50021.
Usage:  venv\Scripts\python.exe docs\tts-spike\gen_ja_picker.py
"""
import base64
import html
import json
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:50021"
TEXT = "いらっしゃいませ。ご予約はされていますか？窓際のお席もご用意できますよ。"

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs" / "tts-spike" / "ja_voices.html"


def post(path, **params):
    url = f"{path}?{urllib.parse.urlencode(params)}"
    return urllib.request.urlopen(
        urllib.request.Request(BASE + url, data=b"", method="POST"), timeout=180
    )


def synth(query, speaker):
    req = urllib.request.Request(
        f"{BASE}/synthesis?{urllib.parse.urlencode({'speaker': speaker})}",
        data=json.dumps(query).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=180).read()


speakers = json.load(urllib.request.urlopen(f"{BASE}/speakers", timeout=60))
print(f"speakers: {len(speakers)}")

rows = []
for sp in speakers:
    # Default style only — extra styles (whisper, angry, ...) are not useful here.
    style = sp["styles"][0]
    sid = style["id"]
    try:
        q = json.load(post("/audio_query", text=TEXT, speaker=sid))
        wav = synth(q, sid)
        rows.append((sp["name"], style["name"], sid, base64.b64encode(wav).decode()))
        print(f"  OK  {sp['name']} / {style['name']} (id={sid})")
    except Exception as e:
        print(f"  FAIL {sp['name']}: {type(e).__name__}: {e}")

cards = "\n".join(
    f"""  <div class="v">
    <div class="meta"><b>{html.escape(n)}</b><span class="s">{html.escape(st)} · id={i}</span></div>
    <audio controls preload="none" src="data:audio/wav;base64,{b}"></audio>
  </div>"""
    for n, st, i, b in rows
)

OUT.write_text(
    f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOICEVOX 화자 {len(rows)}종</title>
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
 .meta {{ min-width:190px; display:flex; flex-direction:column; }}
 .meta b {{ font-size:.92rem; }}
 .s {{ opacity:.6; font-size:.75rem; }}
 audio {{ flex:1; height:34px; }}
</style></head><body>
<h1>VOICEVOX 화자 {len(rows)}종</h1>
<div class="sub">각 화자의 기본 스타일입니다. 전부 같은 문장이에요.</div>
<div class="q">{html.escape(TEXT)}</div>
{cards}
</body></html>""",
    encoding="utf-8",
)
print(f"\nwrote {OUT}  ({OUT.stat().st_size/1024/1024:.1f} MB)")
