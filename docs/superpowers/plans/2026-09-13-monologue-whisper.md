# Whisper 최종 받아쓰기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 턴이 끝나면 녹음을 서버의 faster-whisper(large-v3-turbo)로 받아써 그 문장으로 턴을 보내고, 실패하면 브라우저 인식 결과로 대신한다.

**Architecture:** 서버에 `app/stt.py`(모델 적재·받아쓰기)와 `POST /api/transcribe`를 둔다. 브라우저는 `audio.js`가 녹음이 완전히 끝난 Blob을 Promise로 넘기고, `session.js`의 `finalTranscript`가 Whisper→브라우저 순으로 문장을 정한 뒤 기존 흐름(`sendText`, `nextScriptLine`, 다시 말하기 비교)으로 잇는다. 상태 머신에 `transcribing`을 더한다.

**Tech Stack:** FastAPI, faster-whisper 1.2.1 (ctranslate2, CUDA 12, cuDNN 9), vanilla ES modules, pytest, `node --test`

**Spec:** `docs/superpowers/specs/2026-09-13-monologue-whisper-design.md`

## Global Constraints

- 모델: `large-v3-turbo`, `device="cuda"`, `compute_type="int8_float16"` (spec "서버")
- 받아쓰기 옵션: `language` 고정, `vad_filter=True`, `beam_size=1`, `condition_on_previous_text=False`
- 대본 문장을 Whisper에 힌트(initial_prompt)로 주지 않는다
- 브라우저 쪽 받아쓰기 타임아웃 8초, 실패하면 브라우저 인식 결과로 대신 — 연습은 절대 막히지 않는다
- `/api/transcribe`는 파일을 저장하지 않는다. 25MB 초과는 413, 준비 전·실패는 503
- 서버 시작은 모델 적재를 기다리지 않는다(백그라운드 스레드)
- 테스트 기준선(시작 시점 main): pytest `-m "not engine"` 379 passed / 10 deselected, node 90 pass
- node 스위트는 `node --test --test-force-exit 'static/js/*.test.js'` 로 돌린다 (audio.test.js 실패 시 90초 안전 타이머가 프로세스를 붙잡는다)
- 모든 새 테스트는 먼저 실패하는 것을 보이고, 구현 뒤 일부러 깨뜨려 빨개지는지 확인한다
- 사용자 앱 서버가 8000에서 `--reload`로 돈다. 서버를 띄워야 하면 8010 + DB 복사본
- `dom-shim.js`는 `querySelector`가 null이다 — 프론트 코드는 `$('id')`만 쓴다
- 커밋 전 `git branch --show-current`가 `whisper-stt`인지 확인한다 (사용자가 IDE에서 브랜치를 바꾸기도 한다)

---

### Task 1: `app/stt.py` — 모델 적재와 받아쓰기

**Files:**
- Create: `app/stt.py`
- Modify: `app/config.py` (STT 설정 3줄)
- Modify: `app/main.py` (`lifespan`에서 `stt.start_loading()`)
- Modify: `requirements.txt`
- Modify: `README.md` (First-time setup에 한 단락)
- Test: `tests/test_stt.py`

**Interfaces:**
- Produces:
  - `class SttUnavailable(Exception)`
  - `status() -> str` — `"idle" | "loading" | "ready" | "unavailable"`
  - `load(factory=None) -> None` — 동기 적재. `factory()`는 `.transcribe(file, **kw) -> (segments, info)`를 가진 객체를 돌려준다
  - `start_loading(factory=None) -> threading.Thread | None` — 이미 loading/ready면 None
  - `transcribe(audio: bytes, language: str) -> str` — ready가 아니면 `SttUnavailable`
  - `_reset_for_tests() -> None`

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `tests/test_stt.py`

```python
"""app/stt.py -- 가짜 모델로 적재 상태와 받아쓰기 계약을 고정한다.
실제 모델은 tests/test_stt_quality.py(-m engine)가 본다."""
import pytest

from app import stt


class Segment:
    def __init__(self, text):
        self.text = text


class FakeModel:
    def __init__(self, segments):
        self.segments = segments
        self.calls = []

    def transcribe(self, audio, **kw):
        self.calls.append((audio.read(), kw))
        return iter([Segment(t) for t in self.segments]), object()


@pytest.fixture(autouse=True)
def reset():
    stt._reset_for_tests()
    yield
    stt._reset_for_tests()


def test_transcribe_joins_the_segments_and_strips():
    model = FakeModel([" I went there", " yesterday. "])
    stt.load(lambda: model)
    assert stt.status() == "ready"
    assert stt.transcribe(b"webm-bytes", "en") == "I went there yesterday."


def test_transcribe_pins_the_language_and_the_options_the_spike_measured():
    model = FakeModel(["こんにちは"])
    stt.load(lambda: model)
    stt.transcribe(b"x", "ja")
    audio, kw = model.calls[0]
    assert audio == b"x"
    assert kw == {"language": "ja", "vad_filter": True, "beam_size": 1,
                  "condition_on_previous_text": False}


def test_silence_is_an_empty_string_not_an_error():
    stt.load(lambda: FakeModel([]))
    assert stt.transcribe(b"x", "en") == ""


def test_not_ready_means_unavailable():
    with pytest.raises(stt.SttUnavailable):
        stt.transcribe(b"x", "en")


def test_a_model_that_cannot_load_leaves_the_feature_off():
    """CUDA가 없는 PC, DLL이 없는 설치, 내려받기 실패 -- 전부 여기로 온다.
    앱은 브라우저 인식으로 계속 돈다."""
    def boom():
        raise RuntimeError("no CUDA")
    stt.load(boom)
    assert stt.status() == "unavailable"
    with pytest.raises(stt.SttUnavailable):
        stt.transcribe(b"x", "en")


def test_start_loading_runs_in_the_background_and_only_once():
    model = FakeModel(["ok"])
    thread = stt.start_loading(lambda: model)
    thread.join(timeout=5)
    assert stt.status() == "ready"
    assert stt.start_loading(lambda: model) is None
```

- [ ] **Step 2: 실패 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_stt.py -v`
Expected: 수집 오류 — `ImportError: cannot import name 'stt'`

- [ ] **Step 3: `app/config.py`에 설정을 더한다** (`VOICEVOX_URL` 줄 아래)

```python
# Final transcripts (app/stt.py). Measured on this machine next to qwen2.5:14b:
# +1.2GB VRAM, ~0.2s per 3s clip, Japanese punctuation intact. `small` was
# faster by 0.1s but misheard Japanese and dropped most punctuation.
STT_MODEL = "large-v3-turbo"
STT_DEVICE = "cuda"
STT_COMPUTE_TYPE = "int8_float16"
```

- [ ] **Step 4: `app/stt.py`를 만든다**

```python
"""The final transcript of a spoken turn, from faster-whisper.

Chrome's recognition stays as the live preview; this is what the turn is
actually sent as. It is an accuracy layer, never a required path: while the
model loads, on a machine without CUDA, or when anything here fails, the
browser falls back to its own transcript (static/js/session.js).

One model for the process, loaded on a background thread at startup so the
server does not wait ~5-40s before it can serve the page, and a lock so two
requests never share it at once.
"""
import io
import os
import site
import threading
from pathlib import Path

from app import config


class SttUnavailable(Exception):
    """The model is not loaded (yet, or at all)."""


_lock = threading.Lock()
_model = None
_status = "idle"  # idle | loading | ready | unavailable


def status() -> str:
    return _status


def _register_cuda_dlls():
    """pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 put their DLLs under
    site-packages/nvidia/*/bin, which Windows does not search. ctranslate2
    fails to load without them (confirmed in the 2026-09-13 spike)."""
    if os.name != "nt":
        return
    for base in site.getsitepackages():
        for bin_dir in (Path(base) / "nvidia").glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


def _default_factory():
    _register_cuda_dlls()
    from faster_whisper import WhisperModel
    return WhisperModel(config.STT_MODEL, device=config.STT_DEVICE,
                        compute_type=config.STT_COMPUTE_TYPE)


def load(factory=None) -> None:
    global _model, _status
    _status = "loading"
    try:
        model = (factory or _default_factory)()
    except Exception:
        _model, _status = None, "unavailable"
        return
    _model, _status = model, "ready"


def start_loading(factory=None):
    global _status
    if _status in ("loading", "ready"):
        return None
    _status = "loading"
    thread = threading.Thread(target=load, args=(factory,), name="stt-loader", daemon=True)
    thread.start()
    return thread


def transcribe(audio: bytes, language: str) -> str:
    if _status != "ready" or _model is None:
        raise SttUnavailable(_status)
    with _lock:
        # Never pass a script line as initial_prompt: a hint makes a misread
        # line come back as the script, which inflates the accuracy score.
        segments, _info = _model.transcribe(
            io.BytesIO(audio), language=language, vad_filter=True,
            beam_size=1, condition_on_previous_text=False,
        )
        return "".join(segment.text for segment in segments).strip()


def _reset_for_tests() -> None:
    global _model, _status
    _model, _status = None, "idle"
```

- [ ] **Step 5: 통과 확인**

Run: `venv/Scripts/python.exe -m pytest tests/test_stt.py -v`
Expected: 6 passed

- [ ] **Step 6: `app/main.py`의 `lifespan`에서 적재를 시작한다**

`from app import config, db` 를 `from app import config, db, stt` 로 바꾸고, `lifespan` 안 디렉터리 생성 루프 다음 줄에:

```python
    # Background: the page must not wait for a 1.6GB model. Until it is ready
    # /api/transcribe answers 503 and the browser uses its own transcript.
    stt.start_loading()
```

(TestClient는 `with` 없이 쓰이므로 테스트에서는 lifespan이 돌지 않는다 — 확인: `grep -rn "with TestClient" tests/` 가 비어 있어야 한다. 비어 있지 않으면 그 테스트 파일에서 `stt.start_loading`을 no-op으로 monkeypatch 한다.)

- [ ] **Step 7: `requirements.txt`에 추가**

```
faster-whisper==1.2.1
nvidia-cublas-cu12==12.9.2.10
nvidia-cudnn-cu12==9.26.0.51
```

- [ ] **Step 8: `README.md` First-time setup 3번 뒤에 한 단락**

```markdown
4. Whisper (final transcripts) downloads `large-v3-turbo` (~1.6GB) the first
   time the server starts, so that first start needs the internet. It runs on
   the GPU next to Ollama (+1.2GB VRAM). Without CUDA the app still works —
   turns are sent with Chrome's own transcript.
```

- [ ] **Step 9: 역방향 확인** — `vad_filter=True`를 `vad_filter=False`로 바꿔 `test_transcribe_pins_the_language...`가 빨개지는지, `load`의 except를 지워 `test_a_model_that_cannot_load...`가 빨개지는지 본다. 되돌린다.

- [ ] **Step 10: 전체 스위트** — `venv/Scripts/python.exe -m pytest -m "not engine" -q` → 385 passed / 10 deselected

- [ ] **Step 11: 커밋**

```bash
git add app/stt.py app/config.py app/main.py requirements.txt README.md tests/test_stt.py
git commit -m "feat: load faster-whisper in the background for final transcripts"
```

---

### Task 2: `POST /api/transcribe`

**Files:**
- Modify: `app/api.py` (`from app import ... stt` 추가, 라우트 추가 — `/translate` 라우트 근처)
- Test: `tests/test_api_transcribe.py`

**Interfaces:**
- Consumes: `stt.transcribe(audio: bytes, language: str) -> str`, `stt.SttUnavailable`
- Produces: `POST /api/transcribe` multipart `language` (Form, `en`|`ja`), `file` (UploadFile) → `200 {"text": str}` | `503` | `413` | `422`

- [ ] **Step 1: 실패하는 테스트** — `tests/test_api_transcribe.py`

```python
import pytest
from fastapi.testclient import TestClient

from app import api, config, stt
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    return TestClient(app)


def post(client, language="en", data=b"webm"):
    return client.post("/api/transcribe", data={"language": language},
                       files={"file": ("clip.webm", data, "audio/webm")})


def test_returns_the_whisper_text(client, monkeypatch):
    seen = []
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: seen.append((audio, language)) or "I went there.")
    res = post(client, "en", b"abc")
    assert res.status_code == 200
    assert res.json() == {"text": "I went there."}
    assert seen == [(b"abc", "en")]


def test_silence_comes_back_as_an_empty_string(client, monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: "")
    assert post(client).json() == {"text": ""}


def test_503_while_the_model_is_not_ready(client, monkeypatch):
    def not_ready(audio, language):
        raise stt.SttUnavailable("loading")
    monkeypatch.setattr(stt, "transcribe", not_ready)
    assert post(client).status_code == 503


def test_503_when_transcription_itself_fails(client, monkeypatch):
    def boom(audio, language):
        raise RuntimeError("cuda out of memory")
    monkeypatch.setattr(stt, "transcribe", boom)
    assert post(client).status_code == 503


def test_an_unknown_language_is_refused(client, monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: "x")
    assert post(client, "ko").status_code == 422


def test_an_oversized_upload_is_refused(client, monkeypatch):
    monkeypatch.setattr(stt, "transcribe", lambda audio, language: "x")
    monkeypatch.setattr(api, "_MAX_TRANSCRIBE_BYTES", 10)
    assert post(client, "en", b"x" * 11).status_code == 413
```

- [ ] **Step 2: 실패 확인** — `venv/Scripts/python.exe -m pytest tests/test_api_transcribe.py -v` → 6 FAILED (404)

- [ ] **Step 3: 라우트를 더한다** — `app/api.py`

`from app import config, db, llm, prompts, reading, scenarios, text_cleanup, tts` 에 `stt`를 더하고, 파일 위쪽 import에 `from starlette.concurrency import run_in_threadpool` 을 더한다. `/translate` 라우트 앞에:

```python
# 90초 안전 제한까지 녹음해도 webm/opus는 수 MB다. 넉넉한 상한.
_MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024


@router.post("/transcribe")
async def transcribe_turn(language: Language = Form(...), file: UploadFile = File(...)):
    """한 턴 녹음의 최종 받아쓰기. 저장하지 않는다 -- 녹음 보관은
    /sessions/{id}/audio의 몫이고, 이 요청은 턴을 보내기 전에 온다.

    503은 "브라우저 인식으로 보내라"는 뜻이다(모델 적재 중, CUDA 없음, 실패).
    받아쓰기는 GPU를 몇백 ms 붙잡으므로 이벤트 루프 밖에서 돈다.
    """
    audio = await file.read(_MAX_TRANSCRIBE_BYTES + 1)
    if len(audio) > _MAX_TRANSCRIBE_BYTES:
        raise HTTPException(413, "녹음이 너무 큽니다")
    try:
        text = await run_in_threadpool(stt.transcribe, audio, language)
    except Exception:
        raise HTTPException(503, "받아쓰기를 할 수 없습니다")
    return {"text": text}
```

- [ ] **Step 4: 통과 확인** — 6 passed

- [ ] **Step 5: 역방향 확인** — `except Exception:`을 `except stt.SttUnavailable:`로 좁혀 `test_503_when_transcription_itself_fails`가 빨개지는지 본다. 되돌린다.

- [ ] **Step 6: 전체 스위트** — 391 passed / 10 deselected

- [ ] **Step 7: 커밋**

```bash
git add app/api.py tests/test_api_transcribe.py
git commit -m "feat: POST /api/transcribe for a turn's final transcript"
```

---

### Task 3: 상태 머신에 `transcribing`

**Files:**
- Modify: `static/js/turnstate.js`
- Test: `static/js/turnstate.test.js`

**Interfaces:**
- Produces: 이벤트 `HEARD_AUDIO` (listening → transcribing); 상태 `transcribing` { HEARD → sending, HEARD_NOTHING → idle, CANCEL → idle }; `controls('transcribing')` = 전부 false, `end: true`, `cancel: true`

- [ ] **Step 1: 실패하는 테스트** — `turnstate.test.js`

`every state pins exactly which controls are live` 테스트의 마지막 `assert.deepEqual(controls('respeaking'), ...)` 다음 줄에 추가:

```js
  // Whisper is working on the recording. Nothing may start a new turn over
  // it, but the learner can still throw it away.
  assert.deepEqual(controls('transcribing'), { ...F, cancel: true });
```

`the session can always be ended` 와 `every enabled control has a transition` 의 상태 배열에 `'transcribing'` 을 더한다.

파일 끝에:

```js
test('a listen with a recording goes through transcribing before it is sent', () => {
  assert.equal(next('listening', 'HEARD_AUDIO'), 'transcribing');
  assert.equal(next('transcribing', 'HEARD'), 'sending');
  assert.equal(next('transcribing', 'HEARD_NOTHING'), 'idle');
  assert.equal(next('transcribing', 'CANCEL'), 'idle');
  // A listen with no recording still sends straight away, as before.
  assert.equal(next('listening', 'HEARD'), 'sending');
  for (const s of ['idle', 'sending', 'speaking', 'undoing', 'respeaking']) {
    assert.equal(next(s, 'HEARD_AUDIO'), s, `HEARD_AUDIO must do nothing in ${s}`);
  }
});
```

- [ ] **Step 2: 실패 확인** — `node --test --test-force-exit static/js/turnstate.test.js` → 새 테스트와 controls 테스트 FAIL

- [ ] **Step 3: 구현** — `turnstate.js`

```js
  listening:    { HEARD: 'sending', HEARD_AUDIO: 'transcribing', HEARD_NOTHING: 'idle', CANCEL: 'idle' },
  transcribing: { HEARD: 'sending', HEARD_NOTHING: 'idle', CANCEL: 'idle' },
```

`controls()`의 `cancel` 줄을:

```js
    // ... (기존 주석 유지) Also live while Whisper transcribes: the recording
    // is on its way to the server, and cancelling drops whatever comes back.
    cancel: state === 'listening' || state === 'respeaking' || state === 'transcribing',
```

- [ ] **Step 4: 통과 확인** — turnstate.test.js 전부 pass

- [ ] **Step 5: 역방향 확인** — `transcribing`의 `CANCEL`을 지워 새 테스트가 빨개지는지 본다. 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add static/js/turnstate.js static/js/turnstate.test.js
git commit -m "feat: a transcribing state between listening and sending"
```

---

### Task 4: `audio.js` — 녹음이 완전히 끝난 Blob을 넘긴다

**Files:**
- Modify: `static/js/audio.js`
- Test: `static/js/audio.test.js`

**Interfaces:**
- Produces:
  - `export function finishRecording(): Promise<Blob | null>` — 녹음기가 없으면 `null`; `stop` 이벤트 뒤 `state.chunks`로 `Blob(type 'audio/webm')`, 조각이 없으면 `null`. `state.chunks`는 비우지 않는다
  - heard/respeak 핸들러 호출이 `handler(transcript, audioPromise)` 두 인자가 된다 (`audioPromise`는 `finishRecording()`의 Promise)

- [ ] **Step 1: 테스트 파일의 가짜 녹음기를 실제 이벤트 순서에 맞춘다** — `audio.test.js`의 `FakeRecorder`를:

```js
class FakeRecorder {
  constructor(stream) { this.stream = stream; this.state = 'inactive'; this.listeners = {}; }
  start() { this.state = 'recording'; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  // 실제 MediaRecorder처럼 stop()이 마지막 dataavailable을 한 번 쏜 뒤 stop 이벤트를 낸다.
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: 'late' });
    for (const fn of this.listeners.stop || []) fn();
  }
}
```

`heard` 기록을 `audio.setHeardHandler((t, audioPromise) => heard.push(t))` 로 두되, 새 테스트에서 두 번째 인자를 쓴다.

- [ ] **Step 2: 실패하는 테스트** — 파일 끝에:

```js
test('the heard handler gets the finished recording, last chunk included', async () => {
  let got = null;
  audio.setHeardHandler((t, audioPromise) => { got = { t, audioPromise }; });
  const recorder = new FakeRecorder(fakeStream());
  recorder.ondataavailable = (e) => state.chunks.push(e.data);
  recorder.start();
  state.recorder = recorder;
  state.chunks = ['early'];

  audio.beginListening();
  rec.onstart();
  rec.onresult(finalResult('hello'));
  rec.onend();

  assert.equal(got.t, 'hello');
  const blob = await got.audioPromise;
  assert.ok(blob instanceof Blob);
  assert.equal(await blob.text(), 'earlylate', 'stop() 뒤에 오는 마지막 조각까지 담겨야 한다');
  assert.deepEqual(state.chunks, ['early', 'late'], '업로드가 뒤에서 쓰므로 비우지 않는다');
});

test('with no recorder the recording is null', async () => {
  let got = null;
  audio.setHeardHandler((t, audioPromise) => { got = audioPromise; });
  audio.beginListening();
  rec.onstart();
  rec.onend();
  assert.equal(await got, null);
});
```

- [ ] **Step 3: 실패 확인** — `node --test --test-force-exit static/js/audio.test.js` → 새 두 테스트 FAIL

- [ ] **Step 4: 구현** — `audio.js`

`deliver`를:

```js
function deliver(transcript, audioPromise) {
  const handler = respeakHandler || heardHandler;
  respeakHandler = null;
  if (handler) handler(transcript, audioPromise);
}
```

`onend`의 `stopRecording();` 줄을 지우고, 취소 분기 안 첫 줄에 `stopRecording();`을 두고, 마지막 `deliver(utt.text() || null);` 를:

```js
    // The recording has not finished yet: MediaRecorder hands over its last
    // chunk asynchronously after stop(). Whisper needs that chunk, so the
    // turn gets a Promise of the finished file rather than a file.
    deliver(utt.text() || null, finishRecording());
```

`stopRecording` 앞에:

```js
/* Stops the recorder and resolves with everything it recorded, including the
   chunk MediaRecorder delivers after stop(). Null when there is no recorder
   (microphone denied) or nothing was captured. state.chunks is left alone --
   uploadPendingRecording attaches the same audio to the message afterwards. */
export function finishRecording() {
  const recorder = state.recorder;
  const build = () => (state.chunks.length ? new Blob(state.chunks, { type: 'audio/webm' }) : null);
  if (!recorder) return Promise.resolve(null);
  if (recorder.state === 'inactive') return Promise.resolve(build());
  return new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve(build()), { once: true });
    recorder.stop();
  });
}
```

- [ ] **Step 5: 통과 확인** — audio.test.js 전부 pass (기존 테스트 포함)

- [ ] **Step 6: 역방향 확인** — `finishRecording`에서 `addEventListener('stop', ...)` 대신 `recorder.stop(); return Promise.resolve(build());` 순서를 `build()` 먼저로 바꿔(`const b = build(); recorder.stop(); return Promise.resolve(b);`) 첫 새 테스트가 `'early'`만 담아 빨개지는지 본다. 되돌린다.

- [ ] **Step 7: 전체 node** — `node --test --test-force-exit 'static/js/*.test.js'` 전부 pass

- [ ] **Step 8: 커밋**

```bash
git add static/js/audio.js static/js/audio.test.js
git commit -m "feat: hand the turn the finished recording, last chunk included"
```

---

### Task 5: `session.js` — Whisper로 문장을 정하고 기존 흐름으로 잇는다

**Files:**
- Modify: `static/js/session.js`
- Test: `static/js/session.test.js`

**Interfaces:**
- Consumes: `POST /api/transcribe` (Task 2), `HEARD_AUDIO`/`transcribing` (Task 3), `handler(transcript, audioPromise)` (Task 4), `discardRecording` (audio.js, 기존)
- Produces:
  - `export async function finalTranscript(browserText: string|null, audioPromise: Promise<Blob|null>|undefined): Promise<string|null>`
  - `export async function handleHeard(browserText, audioPromise)` (테스트용 export)
  - `cancelTurn()`이 `transcribing`에서도 동작

- [ ] **Step 1: 실패하는 테스트** — `session.test.js` 끝에. 자유 세션을 여는 헬퍼는 파일의 기존 자유 세션 테스트(`a free session with a genuine grading failure still reports it`)가 쓰는 `/api/sessions` 응답 모양을 그대로 따른다 — 아래 `openFree`의 응답 필드를 그 테스트와 맞춘다.

```js
/* Whisper 최종 받아쓰기. 브라우저 인식은 미리보기이고, 턴은 받아쓴 문장으로 간다.
   실패하면 브라우저 문장으로 -- 연습이 막히면 안 된다. */
async function openFree(extraRoutes = {}) {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const chats = [];
  const transcribes = [];
  stubFetch(async (url, options) => {
    if (url === '/api/sessions') {
      return jsonResponse({ session_id: 5, mode: 'free', opening: 'Hi.', audio_key: null, goal: null });
    }
    if (url === '/api/transcribe') {
      transcribes.push(options.body);
      return extraRoutes.transcribe ? extraRoutes.transcribe() : jsonResponse({ text: 'I went there yesterday.' });
    }
    if (url === '/api/chat') {
      chats.push(JSON.parse(options.body).text);
      return jsonResponse({ bot_reply: 'Nice.', audio_key: null, ok: true, fixed: '', tag: '없음', correction: '', suggestion: '' });
    }
    return jsonResponse({});
  });
  await startSession({ language: 'en', mode: 'free', scenarioId: 'x' });
  return { chats, transcribes };
}
const clip = () => Promise.resolve(new Blob(['audio']));

test('a turn is sent as Whisper heard it, not as the browser did', async () => {
  const { chats, transcribes } = await openFree();
  session.setTurnState('MIC');
  await session.handleHeard('I go there yesterday', clip());
  assert.equal(transcribes.length, 1);
  assert.deepEqual(chats, ['I went there yesterday.']);
});

test('when Whisper is unavailable the browser transcript is sent', async () => {
  const { chats } = await openFree({ transcribe: () => jsonResponse({ detail: 'loading' }, { ok: false, status: 503 }) });
  session.setTurnState('MIC');
  await session.handleHeard('I go there yesterday', clip());
  assert.deepEqual(chats, ['I go there yesterday']);
});

test('silence from Whisper falls back to what the browser heard', async () => {
  const { chats } = await openFree({ transcribe: () => jsonResponse({ text: '' }) });
  session.setTurnState('MIC');
  await session.handleHeard('I go there', clip());
  assert.deepEqual(chats, ['I go there']);
});

test('nothing from either returns to idle without sending', async () => {
  const { chats } = await openFree({ transcribe: () => jsonResponse({ text: '' }) });
  session.setTurnState('MIC');
  await session.handleHeard(null, clip());
  assert.deepEqual(chats, []);
  assert.equal(session.canDo('send'), true);
});

test('with no recording Whisper is not asked', async () => {
  const { chats, transcribes } = await openFree();
  session.setTurnState('MIC');
  await session.handleHeard('I go there', Promise.resolve(null));
  assert.equal(transcribes.length, 0);
  assert.deepEqual(chats, ['I go there']);
});

test('cancelling while Whisper works drops the late result', async () => {
  let release;
  const { chats } = await openFree({
    transcribe: () => new Promise((resolve) => { release = () => resolve(jsonResponse({ text: 'late' })); }),
  });
  session.setTurnState('MIC');
  const pending = session.handleHeard('browser', clip());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal($('btn-cancel').hidden, false, '받아쓰는 중에도 취소할 수 있어야 한다');
  session.cancelTurn();
  release();
  await pending;
  assert.deepEqual(chats, [], '취소한 뒤 도착한 받아쓰기로 턴이 생기면 안 된다');
  assert.equal(session.canDo('send'), true);
});

test('a script line is read back as Whisper heard it', async () => {
  resetDom();
  router.register('session', 'session');
  state.language = 'en';
  const turns = [];
  stubFetch(async (url, options) => {
    if (url === '/api/sessions') {
      return jsonResponse({ session_id: 8, mode: 'script', lines: [{ speaker: 'user', text: 'Hello there.' }] });
    }
    if (url === '/api/transcribe') return jsonResponse({ text: 'Hello there.' });
    if (url === '/api/script-turn') { turns.push(JSON.parse(options.body).text); return jsonResponse({ turn: 1 }); }
    return jsonResponse({});
  });
  await startSession({ language: 'en', mode: 'script', scenarioId: 'x' });
  session.setTurnState('MIC');
  await session.handleHeard('hello dare', clip());
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(turns, ['Hello there.']);
});
```

- [ ] **Step 2: 실패 확인** — `node --test --test-force-exit static/js/session.test.js` → 새 테스트들 FAIL (`handleHeard`/`finalTranscript` 없음)

- [ ] **Step 3: 구현** — `session.js`

import에 `discardRecording` 추가:

```js
import { play, setHeardHandler, recognition, BCP47, setRespeakHandler, setInterimHandler,
         setCancelHandler, cancelListening, beginListening, discardRecording } from './audio.js';
```

(현재 import 줄의 이름들을 유지한 채 `discardRecording`만 더한다.)

`handleHeard` 를 다음으로 교체한다:

```js
/* Whisper's answer beats the browser's, but never blocks the turn: on any
   failure, after 8s, or when Whisper hears silence, the browser's transcript
   is used. No recording (microphone denied) means Whisper is not asked. */
const TRANSCRIBE_TIMEOUT_MS = 8000;

export async function finalTranscript(browserText, audioPromise) {
  const audio = audioPromise ? await audioPromise : null;
  if (!audio) return browserText || null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('language', state.language);
    form.append('file', audio, 'clip.webm');
    const res = await api('/transcribe', { method: 'POST', body: form, signal: controller.signal });
    const { text } = await res.json();
    return (text && text.trim()) || browserText || null;
  } catch {
    return browserText || null;
  } finally {
    clearTimeout(timer);
  }
}

/* Bumped when a transcription starts and when one is cancelled, so a result
   that arrives after a cancel is recognised as stale and dropped. */
let transcribeGeneration = 0;

export async function handleHeard(browserText, audioPromise) {
  setTurnState('HEARD_AUDIO');
  const generation = ++transcribeGeneration;
  const transcript = await finalTranscript(browserText, audioPromise);
  if (generation !== transcribeGeneration || turnState !== 'transcribing') return;
  sendHeard(transcript);
}

/* A recognised sentence becomes a turn automatically. Hearing nothing just
   returns control to the learner. Re-speak takes priority over this handler
   via audio.js's `deliver` and never reaches it. */
function sendHeard(transcript) {
  if (!transcript) { setTurnState('HEARD_NOTHING'); return; }
  // (기존 handleHeard의 대본 모드 주석과 분기를 그대로 옮긴다)
  if (state.mode === 'script') {
    $('text-input').value = transcript;
    setTurnState('HEARD_NOTHING'); // release the turn; nextScriptLine runs its own cycle
    nextScriptLine();
    return;
  }
  setTurnState('HEARD');
  sendText(transcript);
}
setHeardHandler(handleHeard);
```

`cancelTurn` 을:

```js
export function cancelTurn() {
  if (!canDo('cancel')) return;
  // The recognition session is already over while Whisper works, so abort()
  // would raise no onend and nothing would report the cancel. Invalidate the
  // pending result and report it here instead.
  if (turnState === 'transcribing' || respeakTranscribing) {
    transcribeGeneration += 1;
    respeakTranscribing = false;
    discardRecording();
    handleCancelled();
    return;
  }
  cancelListening();
}
```

`syncControls`의 힌트 줄을:

```js
  $('mic-hint').textContent = listening
    ? (respeakTranscribing ? '받아쓰는 중...' : (liveHeard || '듣고 있습니다...'))
    : turnState === 'transcribing'
      ? '받아쓰는 중...'
      : '누르고 말한 뒤, 다 말하면 다시 눌러서 전송하세요';
```

다시 말하기 핸들러(`setRespeakHandler((spoken) => { ... })`)를:

```js
  setRespeakHandler(async (browserSpoken, audioPromise) => {
    // Stay in `respeaking` while Whisper works -- every control but cancel is
    // already locked there. The chip says what is happening.
    respeakTranscribing = true;
    resultEl.textContent = '받아쓰는 중...';
    syncControls();
    const generation = ++transcribeGeneration;
    const spoken = await finalTranscript(browserSpoken, audioPromise);
    if (generation !== transcribeGeneration) return; // cancelled meanwhile
    respeakTranscribing = false;
    clearActiveRespeak();
    if (spoken === null) {
      setTurnState('HEARD_NOTHING');
      resultEl.textContent = '못 알아들었습니다. 다시 해보세요.';
      return;
    }
    setTurnState('HEARD');
    const good = matches(spoken, target, state.language);
    resultEl.classList.add(good ? 'good' : 'bad');
    resultEl.textContent = good ? `좋습니다 — "${spoken}"` : `"${spoken}" — 조금 다릅니다. 다시 해보세요.`;
  });
```

모듈 상단 상태 변수들 옆에:

```js
/* True while Whisper transcribes a re-speak. The turn stays in `respeaking`
   (its controls are already locked), so this flag is what tells cancelTurn
   and the hint that the recognition session is over and a result is pending. */
let respeakTranscribing = false;
```

- [ ] **Step 4: 통과 확인** — `node --test --test-force-exit static/js/session.test.js` 전부 pass. 기존 취소 테스트(`cancelling a listen returns to idle...`)도 통과해야 한다.

- [ ] **Step 5: 역방향 확인**
  - `finalTranscript`의 `return (text && text.trim()) || browserText || null;` 을 `return browserText || null;` 로 → 첫 새 테스트 FAIL
  - `handleHeard`의 세대 비교 줄을 지워 → 취소 테스트 FAIL
  각각 되돌린다.

- [ ] **Step 6: 전체 스위트** — node 전부 pass, pytest 391 passed

- [ ] **Step 7: 커밋**

```bash
git add static/js/session.js static/js/session.test.js
git commit -m "feat: send each turn as Whisper transcribed it, falling back to the browser"
```

---

### Task 6: 실제 모델 테스트와 화면 확인

**Files:**
- Create: `tests/test_stt_quality.py`

**Interfaces:**
- Consumes: `stt.load()`, `stt.transcribe()`, `tts.synthesize(text, language, voice)`, `config.DEFAULT_VOICE`

- [ ] **Step 1: engine 테스트를 쓴다**

```python
"""Whisper를 실제 모델로. `-m engine`에서만 돈다.

목(mock) 스위트는 stt.transcribe를 대신하므로, 모델 이름·옵션·CUDA DLL 등록이
망가져도 초록이다. 앱 TTS로 만든 음성은 발음이 깨끗하므로 이것은 "동작하는가"의
계기이지 한국어 화자 발음의 정확도 측정이 아니다.
"""
import re
import unicodedata
from difflib import SequenceMatcher

import pytest

from app import config, stt, tts

pytestmark = pytest.mark.engine

LINES = [
    ("en", "Could you tell me how long it takes to get to the airport?"),
    ("en", "I've been working as a software engineer for about three years."),
    ("ja", "すみません、駅までの道を教えていただけますか。"),
    ("ja", "体調が悪いので、今日は早退してもいいですか。"),
]


def _bare(text):
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[\s\W_]+", "", text)


@pytest.fixture(scope="module")
def model():
    stt._reset_for_tests()
    stt.load()
    if stt.status() != "ready":
        pytest.skip("Whisper could not load on this machine (CUDA?)")
    yield
    stt._reset_for_tests()


@pytest.mark.parametrize("language, text", LINES)
def test_whisper_hears_a_clear_sentence(model, language, text):
    wav = tts.synthesize(text, language, config.DEFAULT_VOICE[language])
    heard = stt.transcribe(wav, language)
    ratio = SequenceMatcher(None, _bare(heard), _bare(text)).ratio()
    assert ratio >= 0.9, f"{heard!r} vs {text!r} ({ratio:.2f})"
```

- [ ] **Step 2: 실행** — Ollama·VOICEVOX가 떠 있어야 한다.

Run: `venv/Scripts/python.exe -m pytest tests/test_stt_quality.py -m engine -v`
Expected: 4 passed (첫 실행은 모델 적재로 수십 초)

- [ ] **Step 3: 커밋**

```bash
git add tests/test_stt_quality.py
git commit -m "test: Whisper on real audio, under -m engine"
```

- [ ] **Step 4: 화면 확인 (컨트롤러)** — 8010 + DB 복사본으로 서버를 띄우고 Chrome에서:
  - 서버 로그에 모델 적재 완료 전후로 `/api/transcribe`가 503 → 200으로 바뀌는지
  - 자유 세션에서 `handleHeard`를 앱 모듈로 호출해(마이크 권한이 없으므로) 힌트가 "받아쓰는 중..."으로 바뀌고, Whisper 문장이 말풍선에 실리는지
  - 다시 말하기: `startRespeak`는 `recognition`이 필요해 node 스위트로 몰 수 없다 -- 화면에서 앱 모듈로
    `setRespeakHandler`에 걸린 핸들러를 호출해 칩이 "받아쓰는 중..." 뒤 Whisper 문장으로 비교되는지 본다
  - 실제 마이크 확인은 사용자에게 요청한다 (8000, 머지 후)
