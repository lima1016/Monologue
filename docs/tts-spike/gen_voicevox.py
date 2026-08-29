"""Generate VOICEVOX samples for comparison against Kokoro."""
import json
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:50021"
TEXT = "いらっしゃいませ。ご予約はされていますか？窓際のお席もご用意できますよ。"

out = Path(__file__).parent / "samples"
out.mkdir(exist_ok=True)


def api(path, data=None, **params):
    url = f"{BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        url, data=body, method="POST" if data is not None or params else "GET",
        headers={"Content-Type": "application/json"} if body else {},
    )
    return urllib.request.urlopen(req, timeout=120)


speakers = json.load(urllib.request.urlopen(f"{BASE}/speakers", timeout=60))
print(f"speakers: {len(speakers)}")

# Pick a handful of distinct, well-known speakers for a fair comparison.
WANTED = ["四国めたん", "ずんだもん", "春日部つむぎ", "青山龍星", "冥鳴ひまり"]
picked = []
for sp in speakers:
    if sp["name"] in WANTED:
        style = sp["styles"][0]
        picked.append((sp["name"], style["name"], style["id"]))

for i, (name, style, sid) in enumerate(picked, 1):
    try:
        q = json.load(api("/audio_query", data=None, text=TEXT, speaker=sid))
        resp = api("/synthesis", data=q, speaker=sid)
        safe = f"vv_{i}_{sid}"
        (out / f"{safe}.wav").write_bytes(resp.read())
        print(f"OK   {safe}.wav  <- {name} / {style} (id={sid})")
    except Exception as e:
        print(f"FAIL {name}: {type(e).__name__}: {e}")
