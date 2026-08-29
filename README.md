# Monologue

English and Japanese speaking practice with a local bot. Three modes — free
roleplay, script roleplay, and a lesson with a teacher persona — plus grammar
corrections, phrasing suggestions, and an end-of-session report that also
estimates your level.

Everything runs locally. Running cost is zero.

## What runs where

| Component | Form | Why |
|---|---|---|
| Ollama (`qwen2.5:14b`) | native install | uses the GPU directly, no WSL2 passthrough layer |
| VOICEVOX (Japanese TTS) | Docker | official image, one-line setup, restarts with the machine |
| Kokoro (English TTS) | in-process | a Python library, not a service |
| SQLite | a file | single user, tiny data, nothing to run |

## First-time setup

1. Install [Ollama](https://ollama.com) and pull the model:

   ```powershell
   winget install --id Ollama.Ollama -e
   ollama pull qwen2.5:14b
   ```

2. Download the Kokoro model files into `engines/kokoro/`:

   - `kokoro-v1.0.onnx`
   - `voices-v1.0.bin`

   Both come from the `kokoro-onnx` releases (`model-files-v1.0`).

3. Create the virtualenv and install dependencies:

   ```powershell
   python -m venv venv
   .\venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

## Running

```powershell
.\run.ps1
```

Then open <http://127.0.0.1:8000> in **Chrome** (speech recognition needs it).

The two dots in the header show whether Ollama and VOICEVOX are up.

## 개발 중 주의

`uvicorn`을 `--reload` 없이 띄우면 프로세스가 시작될 때 읽어들인 파이썬 코드를
계속 서빙합니다. `app/` 아래를 고치고 나면 반드시 서버를 재시작하세요 — 안
그러면 옛날 코드를 테스트하게 됩니다. 이번 빌드 중에도 프롬프트를 고쳤는데
반영이 안 된 것처럼 보여서 시간을 꽤 썼습니다.

Chrome은 `app.js`와 `style.css`를 캐싱합니다. `static/` 아래를 고친 뒤에는
하드 리로드(Ctrl+Shift+R)를 하세요 — 안 그러면 옛날 파일을 테스트하게
됩니다. 이것도 마찬가지로 제대로 고친 게 안 고쳐진 것처럼 보이게 만든
원인이었습니다.

`app/db.py`의 `SCHEMA` 상수를 바꿔서 컬럼을 추가하는 것은 이미 존재하는
데이터베이스에는 아무 효과도 없습니다 — `SCHEMA`의 모든 문장이 `CREATE
TABLE IF NOT EXISTS`이기 때문에 이미 생성된 테이블은 그냥 건너뜁니다.
새로운 컬럼을 추가하려면 `MIGRATIONS` 리스트에 새로운 스텝을 추가해야
합니다. 그리고 한 번 적용된 스텝을 나중에 수정하면 안 됩니다 — 수정
전에 만든 데이터베이스와 수정 후에 만든 데이터베이스가 조용히 다른 스키마를
갖게 됩니다.

## Tests

```powershell
.\venv\Scripts\python.exe -m pytest -m "not engine"
```

`-m engine` runs the tests that hit the real Kokoro and VOICEVOX engines; they
need the model files present and VOICEVOX running.

## Voices

English uses Kokoro with US-accent voices only — British voices are excluded on
purpose so the accent being modelled stays consistent. Japanese uses VOICEVOX.
Change either in 설정.

| English | Japanese (VOICEVOX) |
|---|---|
| `am_adam` (default), `am_fenrir`, `af_heart`, `af_bella`, `af_kore` | 剣崎雌雄 (default), 青山龍星, 琴詠ニア, 春日部つむぎ |

Japanese speech is produced with [VOICEVOX](https://voicevox.hiroshiba.jp/).

## 무엇을 확인했나

`run.ps1`로 VOICEVOX(Docker)와 Ollama 상태 확인 후 uvicorn이 올라오는 것을
확인했고, 전체 테스트 스위트(엔진 테스트 포함) 123개가 통과했습니다. 브라우저를
직접 열 수 없는 환경이라 여섯 조합(영어/일본어 × free/script/lesson) 전부를
HTTP API로 직접 재현해 세션 시작 → 턴 진행 → 세션 종료까지 실제 백엔드 경로를
통과시켰고, 매번 `audio_key`가 채워지는 것을 확인해 Kokoro/VOICEVOX 합성이
실제로 동작함을 확인했습니다. 세션 종료 후 리포트가 한국어로 오고 레벨이
저장되며, 그 레벨이 `db.latest_level()`에 그대로 반영되는 것도 확인했습니다.

확인하지 못한 것: 실제 오디오를 귀로 들어보는 것, 마이크 녹음 UX, 브라우저
화면의 시각적 레이아웃(하이라이트 이동 등)은 API 호출만으로는 검증할 수
없습니다. 또한 채점 피드백(`correction`/`suggestion`)이 한국어로 오는지는
API 응답 텍스트로 확인했지만, 로컬 14B 모델이 지시를 얼마나 안정적으로
따르는지는 실행마다 달라질 수 있어 이번 6회 샘플의 결과일 뿐입니다
(자세한 수치는 task-13-report.md 참고).

**수정 라운드 1 (한국어 준수 / 문장 수 캡 / 일본어 스크립트 오염):**
`app/prompts.py`의 피드백 프롬프트에 언어별 few-shot 예시 2개(오류 문장,
이미 맞는 문장)를 추가하고, `SPOKEN_STYLE`의 문장 수 캡을 더 강한 표현으로
바꾸고 문단 나눔 금지 규칙을 추가했으며, 대화·피드백 프롬프트 양쪽에 "일본어는
한자·히라가나·가타카나로만 쓰고 중국어 단어나 로마자를 쓰지 말라"는 규칙을
추가했습니다. 전체 매트릭스를 다시 돌리는 대신 피드백 4턴(영어 오류/영어
정답/일본어 오류/일본어 정답)과 오프닝 4개(영어·일본어 × free/lesson)로
타겟 검증했습니다.

결과는 절반만 성공입니다. 영어 피드백은 2/2 모두 한국어로 나왔고(이전에
실패했던 "이미 맞는 문장" 케이스도 포함), 이 부분은 고쳐졌습니다. 하지만
**일본어 피드백은 여전히 2/2 모두 일본어로만 나왔고 한국어 설명이 전혀
없었습니다** — few-shot 예시가 일본어 세션에는 적용되지 않았습니다. 문장 수
캡도 4개 오프닝 중 2개(영어 free 4문장, 일본어 lesson 약 4~5문장)가 여전히
1~3문장을 넘었습니다. 중국어 단어 유입은 이번 샘플에서는 발견되지 않았지만,
일본어 lesson 오프닝에서 "レッスン"(레슨)이 로마자와 섞여 `レッsson`처럼
깨진 형태로 나오는 로마자 유입이 한 건 관찰됐습니다. 자세한 원문과 근거는
task-13-report.md의 "Fix round 1" 절 참고.

**수정 라운드 2 (한국어 준수, 마지막 시도):** 일본어 피드백이 여전히
한국어를 지키지 않는 문제에 대해, 피드백 프롬프트의 화자 정체성을 "당신은
{언어} 교사입니다"에서 "당신은 한국어로 생각하고 쓰는 한국인 튜터입니다"로
뒤집어봤습니다(few-shot 예시·스키마·문장 수 캡은 그대로 유지). 같은 4턴으로
다시 검증한 결과, 영어는 여전히 2/2 한국어로 유지됐고, 일본어는 "이미 맞는
문장" 케이스가 이번에는 한국어로 나왔지만(0/2 → 1/2), **문법 오류가 있는
문장에 대한 설명은 여전히 일본어로만 나왔습니다.** 즉 부분적으로만
개선됐고, 더 중요한 케이스(오류 설명)는 여전히 고쳐지지 않아 "고쳐졌다"고
말할 수 없습니다. 코디네이터의 지침에 따라 세 번째 시도는 하지 않았고, 아래
"알려진 한계" 절에 남겨둡니다. 자세한 원문은 task-13-report.md의 "Fix round
2" 절 참고.

## 알려진 한계

로컬 `qwen2.5:14b`에서, 영어 세션의 `correction`/`suggestion`은 의도대로
한국어로 설명됩니다. 일본어 세션에서는 이미 맞는 문장에 대한 피드백은
한국어로 나오는 경우가 있지만, 문법 오류를 설명해야 하는 더 흔하고 중요한
경우에는 여전히 일본어로만 나오는 경향이 있습니다 — 프롬프팅(직접 지시),
few-shot 예시, 화자 정체성 반전까지 시도했지만 완전히 고쳐지지 않았습니다.
우회책은 세션 종료 시 나오는 `report`가 두 언어 모두에서 안정적으로
한국어로 나온다는 점입니다 — 학습자는 턴별 피드백이 아니더라도 세션이
끝날 때 한국어 요약을 받습니다. 더 크거나 다른 베이스 모델을 쓰면 다르게
동작할 수 있습니다. 이는 다음에 다시 다뤄볼 만한 한계로 남겨두는 것이지,
사과할 결함으로 취급하지는 않습니다.

## Design notes

See `docs/superpowers/specs/2026-08-29-monologue-design.md` for why each engine
was chosen, including the listening comparison and the finding that Kokoro
cannot read kanji without a separate G2P step.
