"""Look up VOICEVOX speaker/style IDs for the chosen Japanese voices."""
import json
import urllib.request

WANT = ["琴詠ニア", "剣崎雌雄", "青山龍星", "春日部つむぎ"]

speakers = json.load(urllib.request.urlopen("http://127.0.0.1:50021/speakers", timeout=60))
for s in speakers:
    if s["name"] in WANT:
        for st in s["styles"]:
            print(f'{s["name"]}\t{st["name"]}\tid={st["id"]}')
