# 이어서 하기 (Resume)

마지막 작업: 2026-08-29. 브랜치 `phase1-implementation` (master 대비 커밋 20개).

## 지금 어디까지 왔나

13개 태스크 중 **10개 완료, 11번 진행 중**. 백엔드는 전부 끝났고 테스트 119개가 통과합니다.

| # | 태스크 | 상태 |
|---|---|---|
| 1 | 환경 구축 (Ollama, config) | 완료 |
| 2 | SQLite 데이터 계층 | 완료 |
| 3 | 시나리오 카탈로그 | 완료 |
| 4 | TTS 텍스트 정제 | 완료 |
| 5 | TTS 엔진 계층 (Kokoro/VOICEVOX) | 완료 |
| 6 | Ollama 클라이언트 | 완료 |
| 7 | 프롬프트 조립 | 완료 |
| 8 | FastAPI 뼈대 | 완료 |
| 9 | 세션·대화 엔드포인트 | 완료 |
| 10 | 리포트·수준 추정 | 완료 |
| 11 | 프론트엔드 | **커밋됨, 수정 2건 남음** |
| 12 | 설정 UI·음성 미리듣기 | 대기 |
| 13 | README·종단 점검 | 대기 |

**앱은 이미 동작합니다.** 브라우저에서 실제로 영어 자유 상황극을 한 세션 끝까지
돌려봤고, 봇 응답·문법 교정·한국어 리포트·수준 추정까지 전부 정상이었습니다.

## 실행 방법

```bash
docker compose up -d
```

```bash
C:\git\Monologue\venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Ollama는 이미 설치돼 있고 `qwen2.5:14b`가 받아져 있습니다. 안 떠 있으면 `ollama serve`.
그다음 Chrome에서 <http://127.0.0.1:8000>.

테스트:

```bash
C:\git\Monologue\venv\Scripts\python.exe -m pytest -m "not engine" -q
```

## 다음에 할 일 (순서대로)

### 1. Task 11 수정 2건 — 브라우저로 확인하다 찾은 진짜 버그입니다

curl로는 절대 잡히지 않는 것들이라, 실제로 페이지를 띄워서 발견했습니다.

**(a) `hidden` 속성이 label에서 안 먹습니다** — `static/style.css`

`label { display: block; }` 규칙이 브라우저 기본 `[hidden] { display: none }`을
이깁니다. 그래서 모드와 상관없이 시나리오 드롭다운과 "오늘 배우고 싶은 것" 입력창이
**둘 다 항상 보입니다**. 둘 중 하나는 그 모드에서 아무 의미가 없는데도요.

고치는 법: `static/style.css`에 한 줄 추가

```css
[hidden] { display: none !important; }
```

**(b) 교정 피드백이 한국어가 아니라 영어로 나옵니다** — `app/prompts.py`

실제로 관찰된 출력: 교정 라벨은 한국어인데 내용이 영어였습니다.

원인이 명확합니다. **리포트** 프롬프트는 첫 문장에 "in Korean"을 넣어서
완벽한 한국어 리포트를 만들어냅니다. 반면 **피드백** 프롬프트는 "Explain in Korean"이
형식 지시 뒤 문단 중간에 묻혀 있어서 모델이 무시합니다.

고치는 법: `build_feedback_messages`의 system 문자열 **첫 문장**으로 한국어 요구를
끌어올리기. 리포트 프롬프트에서 실제로 통하는 형태를 그대로 따라가면 됩니다.

수정 후 `tests/test_prompts.py`의 피드백 관련 단언도 같이 확인해야 합니다.

### 2. Task 11 리뷰 (아직 안 돌림)

수정이 끝나면 태스크 리뷰를 돌리고, 그다음 브라우저에서 아직 못 본 것들을 확인:
소리 실제로 들어보기, 마이크(Web Speech), 스크립트 모드 UI, 레이아웃.

### 3. Task 12 — 설정 UI (`static/app.js`에 append)
### 4. Task 13 — README, `run.ps1`, 6가지 조합(2언어 × 3모드) 종단 점검

## 작업 방식

`superpowers:subagent-driven-development`로 진행 중입니다. 태스크마다 새 서브에이전트가
구현하고, 별도 리뷰어가 검토하고, 발견된 문제는 fix round로 돌립니다.

- 계획서: `docs/superpowers/plans/2026-08-29-monologue-phase1.md`
- 설계 스펙: `docs/superpowers/specs/2026-08-29-monologue-design.md`
- **진행 기록: `.superpowers/sdd/2026-08-29-monologue-phase1/progress.md`** — 여기에
  지금까지 내린 모든 판단(ruling)과 그 근거, 미뤄둔 minor 이슈들이 다 적혀 있습니다.
  이어서 할 때 이 파일부터 읽으면 됩니다.

각 태스크의 브리프와 구현 리포트도 같은 폴더에 있습니다.

## 참고: 이 프로젝트에서 내린 주요 결정

- **영어 TTS = Kokoro, 일본어 TTS = VOICEVOX.** 실제로 샘플을 뽑아 들어보고 정했습니다.
  Kokoro는 한자를 못 읽어서 일본어 문장이 3~4배로 늘어집니다.
- **VOICEVOX만 Docker, Ollama는 네이티브.** GPU 패스스루 계층을 줄이려고요.
- **SQLite, ORM 없음.** 하루 100행 규모에 서버 DB는 비용만 늘어납니다.
- **파인튜닝 안 함.** 프롬프트·few-shot·구조화 출력이 먼저입니다.
- 영어 음성 5종(기본 `am_adam`), 일본어 화자 4종(기본 `剣崎雌雄`, id 21).
