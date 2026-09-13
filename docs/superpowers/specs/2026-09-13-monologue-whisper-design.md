# Monologue — Whisper 최종 받아쓰기 설계

- 날짜: 2026-09-13
- 상태: 사용자 승인(방향 A, 설계 1/2·2/2)
- 선행: 녹음 취소(`cancelListening`, `CANCEL`), 녹음 세대 번호(`recordingGeneration`)가 main에 있다

## 왜

사용자가 **모든 모드**에서 인식 정확도가 나쁘다고 했다. 한국어 화자의 영어·일본어는 Chrome
음성 인식이 약한 자리다. 앱은 이미 인식과 동시에 녹음하고(`▶ 내 발음`), 한 턴이 끝나는
순간도 분명하다(마이크를 다시 누름). 최종 받아쓰기만 Whisper로 바꾸면 된다.

Whisper는 구두점을 붙인다 -- "쉼표·문장 구분 자동으로" 요청이 여기서 같이 풀린다.

## 스파이크 결과 (2026-09-13, 이 PC, 버린 코드)

RTX 4060 Ti 16GB, qwen2.5:14b 적재 상태(9.27GB). 앱 TTS로 만든 영어 4 + 일본어 4 문장(각 3~4초).

| | large-v3-turbo | small |
|---|---|---|
| 문장당 받아쓰기 | 0.17~0.35초 | 0.08~0.12초 |
| 추가 VRAM (int8_float16) | +1.2GB (합 10.5GB) | +0.5GB |
| 영어 | 4/4 원문 그대로, 구두점 포함 | 4/4, 쉼표 하나 누락 |
| 일본어 | 4/4 원문 그대로, `、。` 포함 | 早退→総体 1건, 구두점 대부분 누락 |
| 첫 로딩 | 39초(내려받기 포함) | 1초 |

**large-v3-turbo로 한다.** 속도 차이는 체감되지 않고 일본어 정확도·구두점 차이는 분명하다.
한계: TTS 음성은 발음이 깨끗하다. 한국어 화자 발음에서의 정확도는 구현 뒤 사용자가 직접
말해서 확인한다.

Windows에서 CUDA DLL은 pip의 `nvidia-cublas-cu12`, `nvidia-cudnn-cu12`가 설치하는
`site-packages/nvidia/*/bin`을 `os.add_dll_directory`로 등록해야 로드된다(스파이크에서 확인).

## 흐름

### 자유·수업 모드 한 턴

1. 마이크를 누르고 말한다. 브라우저 인식이 실시간 미리보기를 `#mic-hint`에 보여준다(지금과 같다).
2. 다시 누르면 인식이 끝나고(`onend`), 녹음이 **완전히** 끝나기를 기다린 뒤 파일 하나를 만든다.
3. 상태가 `transcribing`이 되고 힌트는 "받아쓰는 중...".
4. `POST /api/transcribe`로 녹음을 보낸다. 결과 문장으로 턴을 보낸다(`sendText`) --
   말풍선·교정·통계가 전부 이 문장 기준이다.
5. 녹음은 지금처럼 그 메시지에 붙여 저장된다(`uploadPendingRecording`).

### 무엇으로 보낼지 (`finalTranscript`)

| Whisper | 브라우저 인식 | 보내는 것 |
|---|---|---|
| 문장 | 무엇이든 | Whisper 문장 |
| 빈 문자열(무음) | 문장 | 브라우저 문장 |
| 빈 문자열 | 없음 | 없음 → "못 알아들음", idle |
| 실패(503·네트워크·8초 초과) | 문장 | 브라우저 문장 |
| 실패 | 없음 | 없음 → idle |
| 녹음 없음(마이크 권한 거부 등) | — | Whisper를 건너뛰고 브라우저 문장 |

Whisper가 빈 문자열을 줬는데 브라우저가 문장을 들었다면 브라우저를 믿는다: VAD가 작은
목소리를 무음으로 잘랐을 가능성이 Whisper가 소리를 지어낼 가능성보다 크다.

연습은 절대 막히지 않는다. Whisper는 정확도를 올리는 층이지 필수 경로가 아니다.

### 대본 모드

Whisper 결과를 `#text-input`에 넣고 `nextScriptLine()`으로 넘긴다(지금 브라우저 결과가 가는
길과 같다). **대본 문장을 Whisper에 힌트(initial_prompt)로 주지 않는다** -- 틀리게 읽어도
대본대로 받아써 정확도가 부풀려진다.

### 다시 말하기

같은 `finalTranscript`를 거친 문장으로 `matches()` 비교를 한다. 받아쓰는 동안 칩의 결과
줄에 "받아쓰는 중..."을 쓴다. 상태는 `respeaking`에 머문다(조작은 이미 잠겨 있다).

### 취소

- `transcribing`(그리고 받아쓰는 중인 `respeaking`)에서도 취소(버튼·Esc)가 된다.
- 이때는 인식 세션이 이미 끝나 `recognition.abort()`가 아무 이벤트도 내지 않는다. 그래서
  받아쓰기 **세대 번호**를 올리고 `handleCancelled()`를 직접 부른다. 늦게 도착한 결과는
  세대 번호가 달라 버려진다. 녹음은 `discardRecording()`으로 버린다.

## 상태 머신 (`turnstate.js`)

```
listening:    HEARD_AUDIO -> transcribing   (녹음이 있어 받아쓰기로)
              HEARD -> sending              (녹음이 없어 바로 보냄 -- 지금과 같다)
              HEARD_NOTHING -> idle, CANCEL -> idle
transcribing: HEARD -> sending, HEARD_NOTHING -> idle, CANCEL -> idle
```

`controls('transcribing')`: mic/send/undo/next/respeak/stop 모두 false, `end`와 `cancel`은 true.

대본 모드는 지금처럼 받아쓰기 뒤 HEARD_NOTHING으로 idle에 돌려놓고 `nextScriptLine()`이
자기 사이클을 돈다.

## 서버

### `app/stt.py` (신설)

- `config.STT_MODEL = "large-v3-turbo"`, `config.STT_DEVICE = "cuda"`,
  `config.STT_COMPUTE_TYPE = "int8_float16"`.
- 모델 하나를 모듈 전역에 둔다. `start_loading()`이 백그라운드 스레드에서 적재하고,
  `lifespan` 시작 때 부른다 -- 서버 시작은 기다리지 않는다.
- 상태: `loading` / `ready` / `unavailable`(적재 실패: CUDA 없음, DLL 없음, 내려받기 실패).
  실패는 한 번 기록하고 앱은 브라우저 인식으로 돈다.
- `transcribe(audio_bytes, language) -> str`: `ready`가 아니면 `SttUnavailable`.
  `threading.Lock`으로 한 번에 하나. `language` 고정, `vad_filter=True`,
  `beam_size=1`, `condition_on_previous_text=False`. 세그먼트 텍스트를 이어 붙여 strip.
- Windows DLL 경로 등록은 적재 직전에 한 번.
- 테스트는 가짜 모델을 주입한다(`stt._model` 교체 또는 팩토리 인자).

### `POST /api/transcribe`

- multipart: `language` (Form, `en`|`ja`), `file` (UploadFile).
- 성공: `200 {"text": "..."}` (무음이면 `""`).
- `SttUnavailable` 또는 받아쓰기 예외: `503`.
- 파일을 저장하지 않는다. 녹음 저장은 기존 `/sessions/{id}/audio`의 몫이다.
- 25MB 넘는 파일은 413 (90초 안전 제한 녹음을 넉넉히 넘는 크기).

## 브라우저

### `audio.js`

- `finishRecording(): Promise<Blob|null>` -- 녹음기가 `stop` 이벤트를 낼 때까지(마지막
  `dataavailable` 포함) 기다려 `state.chunks`로 Blob을 만든다. 녹음기가 없거나 비었으면 `null`.
  `state.chunks`는 비우지 않는다(업로드가 뒤에서 쓴다).
- `onend`는 `deliver(utt.text() || null, finishRecording())` -- 두 번째 인자는 Promise.
- 받아쓰기 요청은 audio.js가 아니라 session.js가 한다(audio.js는 녹음·인식만).

### `session.js`

- `finalTranscript(browserText, audioPromise)` -- 위 표 그대로. `fetch`에 8초 타임아웃
  (`AbortController`). 예외를 던지지 않는다.
- `handleHeard(browserText, audioPromise)`는 async가 된다:
  녹음이 있으면 `HEARD_AUDIO` → `transcribing` → 결과에 따라 `HEARD`/`HEARD_NOTHING`,
  대본 모드는 결과를 입력칸에 넣고 기존 흐름.
- 받아쓰기 세대 번호 `transcribeGeneration` -- 시작 때 캡처, 결과 도착 때 비교, 취소 때 증가.
- `syncControls`: `transcribing`이면 힌트 "받아쓰는 중...", `thinking` 표시는 `sending`에서만.
- 다시 말하기 핸들러도 `(spoken, audioPromise)`를 받아 `finalTranscript`를 거친다.

## 의존성·문서

- `requirements.txt`: `faster-whisper==1.2.1`, `nvidia-cublas-cu12`, `nvidia-cudnn-cu12==9.*`
  (설치 확인된 버전 기준으로 고정).
- README: 첫 실행 때 모델을 내려받는다(약 1.6GB, 인터넷 필요), CUDA가 없으면 브라우저
  인식으로 동작한다.

## 테스트

- `tests/test_stt.py`: 가짜 모델로 `transcribe`가 세그먼트를 잇는다 / `loading`이면
  `SttUnavailable` / 적재 실패면 `unavailable` / 무음(세그먼트 없음)이면 `""`.
- `tests/test_api_transcribe.py`: 200 텍스트, 준비 전 503, 예외 503, 언어 검증 422, 과대 파일 413.
- `static/js/turnstate.test.js`: `HEARD_AUDIO`, `transcribing`의 전이와 controls, cancel 가능.
- `static/js/session.test.js` (가짜 fetch):
  - Whisper 문장이 `/chat` 본문에 실린다
  - 503·타임아웃이면 브라우저 문장
  - Whisper 빈 문자열 + 브라우저 문장 → 브라우저 문장
  - 둘 다 없으면 HEARD_NOTHING, 요청 없음
  - 녹음이 없으면 `/transcribe`를 부르지 않는다
  - 받아쓰는 중 취소 → 늦은 결과로 턴이 생기지 않는다
  - 대본 모드는 Whisper 문장이 `/script-turn`에 실린다
  - 다시 말하기는 Whisper 문장으로 비교한다
- `static/js/audio.test.js`: `finishRecording`이 `stop` 이후의 마지막 조각까지 담는다, 녹음기가 없으면 null.
- `tests/test_stt_quality.py` (`-m engine`): 앱 TTS로 만든 영어·일본어 음성을 실제 모델로
  받아써 원문과 문자 기준 90% 이상 일치(구두점·공백 무시).
- 역방향 확인: 새 테스트마다 일부러 깨뜨려 빨개지는지 본다.

## 비목표

- 발음 채점(음소 단위 점수) -- 별도 작업.
- 실시간 스트리밍 받아쓰기 -- 브라우저 인식이 미리보기를 계속 맡는다.
- 대본 문장 힌트 -- 정확도가 부풀려지므로 하지 않는다.
- 모델 선택 UI.
