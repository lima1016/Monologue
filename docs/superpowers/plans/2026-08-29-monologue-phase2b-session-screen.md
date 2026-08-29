# Phase 2B — 세션 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 말하기 한 턴을 클릭 한 번으로 끝내고, 교정을 읽고 넘기는 대신 고쳐서 다시 말하게 만든다.

**Architecture:** 프론트엔드가 주 무대다. `state.busy` 불리언을 순수 함수 상태 머신으로 교체하고(그래야 늘어난 상태 조합이 어긋나지 않는다), 자동 전송·되돌리기·접히는 교정 칩·재발화를 그 위에 올린다. 백엔드는 두 개만 는다 — 마지막 턴 삭제와 학습자 녹음 재생. Node 내장 테스트 러너(`node --test`)로 프론트엔드 순수 로직에 처음으로 테스트를 붙인다. 빌드 도구는 여전히 도입하지 않는다.

**Tech Stack:** Python 3.13, FastAPI, SQLite, pytest, Ollama(`qwen2.5:14b`), Node v24 내장 테스트 러너, 빌드 도구 없는 ES 모듈 + 순수 CSS

**Spec:** `docs/superpowers/specs/2026-08-29-monologue-phase2-design.md`

## Global Constraints

- **자동 전송이 기본이다.** 음성인식이 끝나면 확인 없이 바로 보낸다. 오인식은 방금 보낸 내 말풍선을 클릭해 고치고 다시 보내는 것으로 회수한다. 확인 버튼을 되살리지 않는다 — 그것이 이 단계가 없애려는 클릭이다.
- **재발화 판정은 정확 일치가 아니다.** 브라우저 STT는 문장부호를 돌려주지 않고 대소문자도 제멋대로다. 정규화 후 유사도 **0.9 이상**이면 통과. 영어는 단어 단위, 일본어는 문자 단위(공백으로 나뉘지 않으므로).
- **교정은 접힌 상태가 기본이다.** 말풍선 밑에 한 줄 — 틀렸으면 `고칠 곳 1`, 맞았으면 `✓ 문장 정확`. 누르면 그 자리에서 전문이 펼쳐진다.
- `ok`가 `null`이면 "맞았다"도 "틀렸다"도 아니다. 피드백을 못 받은 턴이므로 칩을 아예 띄우지 않는다. `null`을 `false`로 뭉개면 잘 말한 문장이 틀린 것으로 집계된다.
- 되돌린 턴은 **기록에서 지운다.** 잘못 인식된 문장에 달린 봇 응답과 교정은 학습 기록으로서 가치가 없다.
- 색은 Phase 2A의 토큰만 쓴다. 새 색이 필요하면 `tokens.css`에 토큰으로 추가하고, **라이트와 다크 양쪽에** 정의한다. 어느 색도 다크 블록에만 정의하지 않는다.
- 빌드 도구를 도입하지 않는다. `<script type="module">`과 `.js` 확장자를 포함한 상대 경로.
- 파이썬 테스트: `.\venv\Scripts\python.exe -m pytest -m "not engine"` — 전체 스위트.
- 프론트엔드 테스트: `node --test static/js/` — 의존성 없음.
- 프롬프트를 건드리면 `.\venv\Scripts\python.exe -m pytest tests/test_feedback_quality.py -m engine`도 돌린다.
- 커밋 프리픽스: `feat:` / `fix:` / `docs:` / `refactor:` / `test:`

## Phase 2A가 남긴 것 — 이 계획이 딛고 서는 바닥

- `messages`에 `ok` / `fixed` / `tag` 컬럼. `POST /api/chat` 응답에 다섯 필드 전부.
- `db.MIGRATIONS`는 append-only. 새 컬럼은 **단계를 덧붙여서** 추가한다.
- `static/js/`: `api.js`(`$`, `api`, `getJSON`, `postJSON`, `state`, `notify`), `audio.js`(`play`, `speakInBrowser`, `recognition`, `startRecording`, `stopRecording`, `BCP47`), `session.js`, `settings.js`, `router.js`, `main.js`. import 그래프는 비순환이고 `api.js`가 뿌리다.
- `static/css/`: `tokens.css`, `base.css`, `components.css`.
- `#notice`는 아직 `<section id="session">` 안에 있다 — **이 단계에서 밖으로 뺀다** (Task 5).

---

### Task 1: 마지막 턴 되돌리기 (DB + 엔드포인트)

되돌리기는 마지막 user 발화와 그에 딸린 bot 응답을 지운다. 잘못 인식된 문장에 달린 교정은 학습 기록이 아니다.

**Files:**
- Modify: `app/db.py` (`MIGRATIONS` 아래, `get_messages` 근처에 함수 추가)
- Modify: `app/api.py` (라우트 추가)
- Test: `tests/test_db.py`, `tests/test_api_chat.py`

**Interfaces:**
- Consumes: `db.get_messages`, `db.connect`
- Produces:
  - `db.delete_last_turn(session_id) -> int` — 지운 행 수
  - `DELETE /api/sessions/{session_id}/last-turn` → `{"deleted": <int>}`

- [ ] **Step 1: Write the failing tests**

`tests/test_db.py`에 추가한다:

```python
def test_delete_last_turn_removes_the_user_line_and_its_bot_reply(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    store.add_message(sid, "user", "I go store yesterday.", ok=False, tag="시제")
    store.add_message(sid, "bot", "Nice, what did you buy?")

    assert store.delete_last_turn(sid) == 2
    remaining = store.get_messages(sid)
    assert [m["speaker"] for m in remaining] == ["bot"]
    assert remaining[0]["text"] == "Good evening!"


def test_delete_last_turn_leaves_the_opening_line_alone(store):
    """With no user turn yet there is nothing to undo -- the bot's opening is
    not the learner's mistake to erase."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Good evening!")
    assert store.delete_last_turn(sid) == 0
    assert len(store.get_messages(sid)) == 1


def test_delete_last_turn_frees_the_turn_numbers_for_reuse(store):
    """messages has UNIQUE(session_id, turn); if delete left a gap the next
    INSERT would collide."""
    sid = store.create_session("en", "free")
    store.add_message(sid, "user", "first")
    store.add_message(sid, "bot", "reply")
    store.delete_last_turn(sid)
    store.add_message(sid, "user", "second")
    store.add_message(sid, "bot", "reply again")
    assert [m["text"] for m in store.get_messages(sid)] == ["second", "reply again"]
```

`tests/test_api_chat.py`에 추가한다:

```python
def test_undo_last_turn_removes_it_and_lets_the_next_turn_take_its_place(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})

    r = client.delete(f"/api/sessions/{sid}/last-turn")
    assert r.status_code == 200
    assert r.json()["deleted"] == 2

    client.post("/api/chat", json={"session_id": sid, "text": "I went there."})
    texts = [m["text"] for m in db.get_messages(sid) if m["speaker"] == "user"]
    assert texts == ["I went there."]


def test_undo_on_an_unknown_session_is_a_404(client):
    assert client.delete("/api/sessions/9999/last-turn").status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_db.py tests/test_api_chat.py -k "delete_last_turn or undo" -v`
Expected: FAIL — `AttributeError: module 'app.db' has no attribute 'delete_last_turn'`

- [ ] **Step 3: Implement `delete_last_turn`**

`app/db.py`에서 `get_messages` 바로 아래에 추가한다:

```python
def delete_last_turn(session_id) -> int:
    """Drop the most recent learner turn and the bot reply that followed it.

    Undo exists because speech recognition mishears: a turn built on a sentence
    the learner did not say carries a bot reply and a correction that teach
    nothing, so they are removed rather than kept as history. Deleting the rows
    also frees their turn numbers, which matters because messages carries
    UNIQUE(session_id, turn) and add_message derives the next turn from MAX.

    Returns the number of rows removed: 2 for a normal turn, 1 if the bot reply
    never landed, 0 if the learner has not spoken yet.
    """
    with connect() as conn:
        last_user = conn.execute(
            "SELECT turn FROM messages WHERE session_id = ? AND speaker = 'user'"
            " ORDER BY turn DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if last_user is None:
            return 0
        cur = conn.execute(
            "DELETE FROM messages WHERE session_id = ? AND turn >= ?",
            (session_id, last_user["turn"]),
        )
        return cur.rowcount
```

- [ ] **Step 4: Add the route**

`app/api.py`에서 `chat_turn` 아래에 추가한다:

```python
@router.delete("/sessions/{session_id}/last-turn")
def undo_last_turn(session_id: int):
    """Discard the most recent learner turn so it can be spoken again."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    return {"deleted": db.delete_last_turn(session_id)}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine" -q`
Expected: PASS — 전체 스위트

- [ ] **Step 6: Commit**

```bash
git add app/db.py app/api.py tests/test_db.py tests/test_api_chat.py
git commit -m "feat: add undo for the last learner turn"
```

---

### Task 2: 학습자 녹음 재생 엔드포인트

녹음은 이미 저장되고 있는데(`messages.audio_path`) 되받을 방법이 없다. 저장만 하고 아무도 듣지 못하는 상태다.

**Files:**
- Modify: `app/api.py` (`upload_recording` 아래에 라우트 추가)
- Test: `tests/test_api_chat.py`

**Interfaces:**
- Consumes: `db.get_messages`, `config.AUDIO_DIR`
- Produces: `GET /api/messages/{message_id}/audio` → `audio/webm` 바이트, 없으면 404

- [ ] **Step 1: Write the failing test**

`tests/test_api_chat.py`에 추가한다. 이 파일에는 이미 녹음 업로드 테스트가 있으니 그 근처에 둔다:

```python
def test_uploaded_recording_can_be_played_back(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")

    client.post(f"/api/sessions/{sid}/audio",
                data={"message_id": msg["id"]},
                files={"file": ("clip.webm", io.BytesIO(b"webm-bytes"), "audio/webm")})

    r = client.get(f"/api/messages/{msg['id']}/audio")
    assert r.status_code == 200
    assert r.content == b"webm-bytes"
    assert r.headers["content-type"].startswith("audio/webm")


def test_playback_is_404_when_nothing_was_recorded(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "I go there."})
    msg = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    assert client.get(f"/api/messages/{msg['id']}/audio").status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_chat.py -k "playback or played_back" -v`
Expected: FAIL — 404 for the first test (route does not exist)

- [ ] **Step 3: Implement the route**

`app/api.py`에서 `upload_recording` 바로 아래에 추가한다. `db`에 message 단건 조회가 없으므로 여기서는 파일 존재로 판정한다 — `audio_path`의 이름 규칙(`s{session}_m{message}.webm`)이 이미 message id를 담고 있다:

```python
@router.get("/messages/{message_id}/audio")
def get_recording(message_id: int):
    """Serve the learner's own recording back so they can hear themselves.

    Phase 1 stored these and never played them; the session screen now offers
    them beside the bot's native-speaker audio.
    """
    matches = sorted(config.AUDIO_DIR.glob(f"s*_m{message_id}.webm"))
    if not matches:
        raise HTTPException(404, "no recording for this message")
    return Response(content=matches[0].read_bytes(), media_type="audio/webm")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine" -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api.py tests/test_api_chat.py
git commit -m "feat: serve the learner's own recording back for playback"
```

---

### Task 3: 재발화 판정 함수 + 프론트엔드 테스트 하네스

이 저장소의 첫 프론트엔드 테스트다. Node v24 내장 러너를 쓴다 — 의존성 0, 설정 0.

**Files:**
- Create: `static/js/match.js`, `static/js/match.test.js`
- Modify: `README.md` (테스트 절에 프론트엔드 명령 추가)

**Interfaces:**
- Consumes: 없음 (순수 함수, import 없음)
- Produces:
  - `normalize(text) -> string`
  - `similarity(a, b, language) -> number` (0..1)
  - `matches(spoken, target, language) -> boolean` — 0.9 이상

- [ ] **Step 1: Write the failing test**

`static/js/match.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, similarity, matches } from './match.js';

test('normalize strips the punctuation and case that STT never produces', () => {
  assert.equal(normalize('I went to the STORE, yesterday.'), 'i went to the store yesterday');
  assert.equal(normalize('  spaced   out  '), 'spaced out');
  assert.equal(normalize('きのう、レストランに行きました。'), 'きのうレストランに行きました');
});

test('an exact repeat matches', () => {
  assert.ok(matches('I went to the store yesterday.', 'I went to the store yesterday.', 'en'));
});

test('the punctuation and casing STT drops does not fail the learner', () => {
  // This is the whole reason for the threshold: Chrome returns no full stop
  // and arbitrary casing, so exact comparison would never pass.
  assert.ok(matches('i went to the store yesterday', 'I went to the store yesterday.', 'en'));
});

test('one wrong word in a long sentence still passes', () => {
  assert.ok(matches('I went to a store yesterday morning before work',
                    'I went to the store yesterday morning before work', 'en'));
});

test('saying something different fails', () => {
  assert.ok(!matches('I go store yesterday', 'I went to the store yesterday.', 'en'));
});

test('japanese compares by character because it has no word spaces', () => {
  assert.ok(matches('きのうレストランに行きました', 'きのう、レストランに行きました。', 'ja'));
  assert.ok(!matches('きのうレストランに行きます', 'きのう、レストランに行きました。', 'ja'));
});

test('similarity is symmetric and bounded', () => {
  const a = similarity('one two three', 'one two four', 'en');
  assert.equal(a, similarity('one two four', 'one two three', 'en'));
  assert.ok(a > 0 && a < 1);
});

test('empty input never passes', () => {
  assert.ok(!matches('', 'I went to the store yesterday.', 'en'));
  assert.ok(!matches('   ', 'I went to the store yesterday.', 'en'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test static/js/`
Expected: FAIL — cannot resolve `./match.js`

- [ ] **Step 3: Implement `static/js/match.js`**

```javascript
/* Did the learner actually say the corrected sentence?

   Browser speech recognition returns no punctuation and arbitrary casing, so
   requiring an exact match against `fixed` would fail even when the learner
   said it perfectly. Normalise both sides, then allow a small edit distance:
   the point is to confirm they produced the sentence, not to grade dictation.

   No imports: this file is pure so `node --test` can run it without a DOM. */

const PUNCT = /[.,!?;:'"()\[\]{}\-–—…·、。！？「」『』（）]/g;

export function normalize(text) {
  return (text || '').toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ').trim();
}

/* Tokens are words in English and characters in Japanese, which is not written
   with spaces between words. */
function tokenize(text, language) {
  const cleaned = normalize(text);
  if (!cleaned) return [];
  return language === 'ja' ? [...cleaned.replace(/\s/g, '')] : cleaned.split(' ');
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export function similarity(spoken, target, language) {
  const a = tokenize(spoken, language);
  const b = tokenize(target, language);
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

export const PASS_THRESHOLD = 0.9;

export function matches(spoken, target, language) {
  return similarity(spoken, target, language) >= PASS_THRESHOLD;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test static/js/`
Expected: PASS — 8 tests

If `one wrong word in a long sentence still passes` fails, do **not** lower `PASS_THRESHOLD`. Report the measured similarity — the threshold is the spec's, and a test that disagrees with it is information about the metric, not a licence to move the goalposts.

- [ ] **Step 5: Document the frontend test command**

`README.md`의 Tests 절에 추가한다:

```markdown
프론트엔드 순수 로직은 Node 내장 러너로 돌립니다. 의존성이 없습니다.

```powershell
node --test static/js/
```
```

- [ ] **Step 6: Commit**

```bash
git add static/js/match.js static/js/match.test.js README.md
git commit -m "feat: add re-speak matching with the first frontend tests"
```

---

### Task 4: 턴 상태 머신 (순수 함수 + 테스트)

`state.busy` 불리언 하나가 지금 재진입을 막고 있다. B단계는 상태를 여섯 개로 늘리므로 불리언으로는 조합이 반드시 어긋난다.

**Files:**
- Create: `static/js/turnstate.js`, `static/js/turnstate.test.js`

**Interfaces:**
- Consumes: 없음 (순수)
- Produces:
  - `INITIAL` — `'idle'`
  - `next(state, event) -> string` — 알 수 없는 전이는 현재 상태를 그대로 돌려준다
  - `controls(state) -> { mic, send, undo, next, end, respeak }` — 각 불리언은 "활성"

- [ ] **Step 1: Write the failing test**

`static/js/turnstate.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL, next, controls } from './turnstate.js';

test('a full happy turn returns to idle', () => {
  let s = INITIAL;
  s = next(s, 'MIC');        assert.equal(s, 'listening');
  s = next(s, 'HEARD');      assert.equal(s, 'sending');
  s = next(s, 'REPLY');      assert.equal(s, 'speaking');
  s = next(s, 'AUDIO_DONE'); assert.equal(s, 'idle');
});

test('a failed recognition returns to idle without sending', () => {
  let s = next(INITIAL, 'MIC');
  s = next(s, 'HEARD_NOTHING');
  assert.equal(s, 'idle');
});

test('a failed send returns to idle so the learner can retry', () => {
  let s = next(next(INITIAL, 'MIC'), 'HEARD');
  assert.equal(next(s, 'SEND_FAILED'), 'idle');
});

test('undo runs from idle and comes back to idle', () => {
  assert.equal(next('idle', 'UNDO'), 'undoing');
  assert.equal(next('undoing', 'UNDO_DONE'), 'idle');
});

test('re-speaking is its own state so its result is not sent to the bot', () => {
  assert.equal(next('idle', 'RESPEAK'), 'respeaking');
  assert.equal(next('respeaking', 'HEARD'), 'idle');
  assert.equal(next('respeaking', 'HEARD_NOTHING'), 'idle');
});

test('an event with no transition leaves the state untouched', () => {
  // The guard that state.busy used to provide: a second MIC while already
  // sending must not start a second turn.
  assert.equal(next('sending', 'MIC'), 'sending');
  assert.equal(next('listening', 'MIC'), 'listening');
  assert.equal(next('undoing', 'UNDO'), 'undoing');
});

test('controls are disabled exactly while work is in flight', () => {
  assert.deepEqual(controls('idle'),
    { mic: true, send: true, undo: true, next: true, end: true, respeak: true });
  for (const busy of ['sending', 'undoing']) {
    const c = controls(busy);
    assert.equal(c.mic, false, `${busy} must not allow a new turn`);
    assert.equal(c.send, false);
    assert.equal(c.undo, false);
    assert.equal(c.next, false);
    assert.equal(c.respeak, false);
  }
});

test('the session can always be ended, even mid-flight', () => {
  // Trapping a learner in a hung turn with no way out is worse than an
  // interrupted request.
  for (const s of ['idle', 'listening', 'sending', 'speaking', 'undoing', 'respeaking']) {
    assert.equal(controls(s).end, true, `end must stay available in ${s}`);
  }
});

test('the mic is free again while the bot is still speaking', () => {
  assert.equal(controls('speaking').mic, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test static/js/`
Expected: FAIL — cannot resolve `./turnstate.js`

- [ ] **Step 3: Implement `static/js/turnstate.js`**

```javascript
/* One turn's lifecycle, as a pure state machine.

   Phase 1 guarded re-entrancy with a single `state.busy` boolean, and a bug
   fixed in 07caa64 came from exactly that: one flag cannot describe which of
   several overlapping activities is in flight. This file owns the answer to
   both "what is happening" and "which controls may be pressed", so the two can
   never disagree.

   No imports and no DOM: `node --test` runs it directly. */

export const INITIAL = 'idle';

const TRANSITIONS = {
  idle:       { MIC: 'listening', SEND: 'sending', UNDO: 'undoing', RESPEAK: 'respeaking' },
  listening:  { HEARD: 'sending', HEARD_NOTHING: 'idle' },
  sending:    { REPLY: 'speaking', SEND_FAILED: 'idle' },
  speaking:   { AUDIO_DONE: 'idle', MIC: 'listening' },
  undoing:    { UNDO_DONE: 'idle', UNDO_FAILED: 'idle' },
  respeaking: { HEARD: 'idle', HEARD_NOTHING: 'idle' },
};

export function next(state, event) {
  const to = TRANSITIONS[state] && TRANSITIONS[state][event];
  return to || state;
}

/* Work is in flight during `sending` and `undoing`: a request is out and the
   conversation's shape depends on its answer. Everything else is interactive. */
const IN_FLIGHT = new Set(['sending', 'undoing']);

export function controls(state) {
  const free = !IN_FLIGHT.has(state) && state !== 'listening' && state !== 'respeaking';
  return {
    // The mic stays live while the bot is speaking so the learner can answer
    // before the clip finishes, which is what happens in a real conversation.
    mic: state === 'idle' || state === 'speaking',
    send: free,
    undo: free,
    next: free,
    respeak: free,
    // Ending must never be blocked -- a hung request should not trap the
    // learner in a session with no exit.
    end: true,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test static/js/`
Expected: PASS — match.js와 turnstate.js 합쳐 17 tests

- [ ] **Step 5: Commit**

```bash
git add static/js/turnstate.js static/js/turnstate.test.js
git commit -m "feat: replace the busy flag with a tested turn state machine"
```

---

### Task 5: 세션 화면 마크업과 스타일

대화 + 우측 패널 골격을 세운다. 자바스크립트는 아직 붙이지 않는다 — 이 태스크는 뼈대만 만들고 기존 동작을 깨뜨리지 않는다.

**Files:**
- Modify: `static/index.html` (`#session` 섹션 재구성, `#notice` 이동)
- Modify: `static/css/components.css`, `static/css/tokens.css`
- Modify: `static/js/session.js` (새 id를 쓰도록 최소 수정)

**Interfaces:**
- Consumes: Phase 2A의 토큰
- Produces: 새 요소 id — `#session-goal`, `#panel-title`, `#panel-body`, `#mic-dock`, `#mic-hint`, `#thinking`

- [ ] **Step 1: Restructure the session section in `static/index.html`**

`<section id="session" hidden>` 전체를 아래로 교체한다. **`#notice`는 이 섹션 밖으로 나가 `<main>` 바로 아래에 놓인다** — 지금 위치에서는 설정 화면의 에러가 숨겨진 섹션 안에 쓰여 아무에게도 보이지 않는다.

```html
  <p id="notice" class="notice" hidden></p>

  <section id="session" hidden>
    <div class="session-grid">
      <div class="conversation-col">
        <div id="conversation"></div>
        <div id="thinking" class="thinking" hidden><i></i><i></i><i></i></div>
      </div>

      <aside class="side-panel">
        <p class="label" id="panel-title">목표</p>
        <div id="panel-body"></div>
      </aside>
    </div>

    <div id="mic-dock">
      <button id="btn-mic" class="mic" aria-label="말하기"></button>
      <p id="mic-hint" class="hint">누르고 말하면 자동으로 전송됩니다</p>
      <div id="controls">
        <input id="text-input" type="text" placeholder="직접 입력해도 됩니다">
        <button id="btn-send">보내기</button>
        <button id="btn-next" hidden>다음 →</button>
        <button id="btn-end" class="ghost">세션 끝내기</button>
      </div>
    </div>
  </section>
```

기존 `#script-panel` / `#script-lines`는 제거한다 — 대본은 이제 우측 패널(`#panel-body`)에 렌더된다. `#feedback` / `#feedback-list` aside도 제거한다 — 교정은 Task 7에서 말풍선 밑으로 옮긴다.

- [ ] **Step 2: Add the tokens the new layout needs**

`static/css/tokens.css`의 라이트 `:root` 블록에 추가한다:

```css
  --panel-w: 300px;
  --dock-h: 92px;
```

다크 블록에는 추가하지 않는다 — 치수는 스킴에 따라 달라지지 않는다. 색은 하나도 새로 필요하지 않다.

- [ ] **Step 3: Add the layout rules to `static/css/components.css`**

```css
/* --- session screen --- */

.session-grid {
  display: grid;
  grid-template-columns: 1fr var(--panel-w);
  gap: var(--space-4);
  align-items: start;
}

.conversation-col { min-width: 0; }  /* let long words wrap instead of stretching the grid */

.side-panel {
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-3);
  font-size: var(--text-sm);
  position: sticky;
  top: var(--space-4);
}

/* The bot is thinking. Without this the screen is frozen for the seconds the
   local model takes, which reads as a hang rather than as waiting. */
.thinking { display: flex; gap: var(--space-1); padding: var(--space-2) var(--space-3); }
.thinking i {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--text-faint); display: block;
  animation: thinking-pulse 1.2s infinite ease-in-out;
}
.thinking i:nth-child(2) { animation-delay: .15s; }
.thinking i:nth-child(3) { animation-delay: .3s; }
@keyframes thinking-pulse {
  0%, 60%, 100% { opacity: .25; }
  30%           { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .thinking i { animation: none; opacity: .5; }
}

#mic-dock {
  position: sticky; bottom: 0;
  background: var(--bg);
  border-top: 1px solid var(--line);
  padding: var(--space-3) 0 var(--space-4);
  margin-top: var(--space-4);
  text-align: center;
}

.mic {
  width: 52px; height: 52px; border-radius: 50%;
  background: var(--accent); border-color: var(--accent);
  padding: 0; position: relative;
  box-shadow: 0 2px 10px rgba(76, 95, 215, .3);
}
.mic::after {
  content: ""; position: absolute; inset: 18px 21px;
  border-radius: 3px; background: #fff;
}
.mic.listening { background: #c0392b; border-color: #c0392b; box-shadow: none; }
.mic.listening::after { inset: 19px; border-radius: 2px; }
.mic:disabled { opacity: .4; }

#mic-hint { font-size: var(--text-xs); color: var(--text-faint); margin: var(--space-2) 0 0; }

#controls { justify-content: center; margin-top: var(--space-3); }
#controls input { max-width: 420px; flex: 0 1 420px; }

@media (max-width: 720px) {
  .session-grid { grid-template-columns: 1fr; }
  .side-panel { position: static; }
}
```

- [ ] **Step 4: Point `session.js` at the surviving ids**

`session.js`에서 사라진 요소를 참조하는 곳을 고친다. 이 태스크의 목표는 **기존 동작을 유지**하는 것이므로 최소한만 고친다:

- `startSession`의 `$('feedback').hidden = false;` 와 `$('feedback-list').innerHTML = '';` 삭제
- `startSession`의 `$('script-panel').hidden = true;` 삭제
- `startScript`의 `$('script-panel').hidden = false;` 삭제, `$('script-lines').innerHTML = ...`를 `$('panel-body').innerHTML = ...`로 바꾸고 그 위에 `$('panel-title').textContent = '대본';` 추가
- `advanceScript`의 `$('script-lines').children`를 `$('panel-body').querySelectorAll('li')`로 바꾸고, `innerHTML`이 `<ol>...</ol>`을 포함하도록 감싼다
- `addFeedback`은 이번 태스크에서 **호출부만 남기고 본문을 비운다** (`return;` 한 줄) — Task 7이 다시 채운다. 지우지 않는 이유는 `sendTurn`/`nextScriptLine`이 아직 호출하기 때문이다
- 자유·수업 모드에서는 `startSession`이 `$('panel-title').textContent = '목표';`, `$('panel-body').textContent = <시나리오 목표 또는 topic>`을 설정한다. 시나리오 목표는 `POST /api/sessions` 응답에 없으므로, 없으면 패널을 비워둔다 — 채우는 것은 Task 6의 범위다

`static/css/components.css`에서 `#script-lines` 규칙의 선택자를 `#panel-body li`로 바꾼다.

- [ ] **Step 5: Verify**

프론트엔드 순수 테스트와 파이썬 스위트는 이 변경에 영향받지 않아야 한다:

```powershell
node --test static/js/
.\venv\Scripts\python.exe -m pytest -m "not engine" -q
```

그다음 포트 **8010**에 서버를 띄우고(사용자 서버는 8000에 있다) 확인한다:
- `/`, `/css/*.css`, `/js/*.js` 모두 200
- 서빙된 HTML에 `#panel-body`, `#mic-dock`, `#thinking`이 있고 `#script-panel`, `#feedback-list`는 없다
- `session.js`에 사라진 id(`script-panel`, `script-lines`, `feedback`, `feedback-list`)를 참조하는 곳이 남아 있지 않다 — grep으로 확인하고 결과를 보고한다

**자유 식별자 감사**도 다시 돌린다: 건드린 파일의 함수 본문이 호출하는 모든 식별자에 바인딩이 있는지 확인하고, 받아들인 브라우저 전역을 이름으로 열거한다. Phase 2A에서 이 검사를 빠뜨려 페이지가 죽는 버그가 나왔다.

- [ ] **Step 6: Commit**

```bash
git add static/index.html static/css/ static/js/session.js
git commit -m "feat: lay out the session screen as conversation plus side panel"
```

---

### Task 6: 자동 전송과 되돌리기

**Files:**
- Modify: `static/js/session.js`, `static/js/audio.js`, `static/js/main.js`
- Modify: `static/css/components.css`

**Interfaces:**
- Consumes: `turnstate.next` / `turnstate.controls` (Task 4), `DELETE /api/sessions/{id}/last-turn` (Task 1)
- Produces:
  - `session.setTurnState(event)` — 상태를 전이시키고 컨트롤 활성 상태를 DOM에 반영
  - `session.sendText(text)` — 입력창을 거치지 않고 곧바로 한 턴을 보낸다
  - `session.undoLastTurn()` — 마지막 턴을 지우고 화면에서 제거

- [ ] **Step 1: Route recognition straight into a send**

`audio.js`의 인식 부분을 아래로 교체한다. 지금은 결과를 입력창에 넣고 끝난다. `session.js`를 import하면 `audio.js → session.js → audio.js` 순환이 되므로 콜백을 주입받는다.

```javascript
/* session.js injects these. Importing it here would close a cycle.

   Two handlers, not one: a recognised sentence normally becomes a turn, but
   during re-speak it must be compared against the correction instead and never
   reach the bot. Whoever set `respeakHandler` last owns the next result, and
   it is cleared after one use so a stray later result cannot be misrouted. */
let heardHandler = null;
let respeakHandler = null;

export function setHeardHandler(fn) { heardHandler = fn; }
export function setRespeakHandler(fn) { respeakHandler = fn; }

function deliver(transcript) {
  const handler = respeakHandler || heardHandler;
  respeakHandler = null;
  if (handler) handler(transcript);
}

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    notify('이 브라우저는 음성 인식을 지원하지 않습니다. 아래 입력창에 직접 입력하세요.');
    return null;
  }
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  let heard = false;
  recognition.onstart = () => { heard = false; };
  recognition.onresult = (e) => { heard = true; deliver(e.results[0][0].transcript); };
  recognition.onerror = (e) => notify(`음성 인식 실패(${e.error}). 입력창에 직접 입력하세요.`);
  // onend fires whether or not anything was recognised, and it is the only
  // event that always arrives -- so it is where the "heard nothing" path has
  // to live, or a failed recognition would strand the state machine in
  // `listening` with every control disabled.
  recognition.onend = () => {
    stopRecording();
    if (!heard) deliver(null);
  };
  return recognition;
}
```

`$('btn-mic').disabled = true;`를 `setupRecognition`에서 뺀다 — 컨트롤 활성 상태는 이제 상태 머신 한 곳이 정한다. 브라우저가 인식을 지원하지 않으면 `recognition`이 `null`이고, `main.js`의 마이크 핸들러가 그때 안내만 띄운다.

- [ ] **Step 2: Wire the state machine into `session.js`**

```javascript
import * as turn from './turnstate.js';

let turnState = turn.INITIAL;

/* The one place that knows what is in flight. Callers ask it rather than
   keeping their own copy -- two sources of truth about "is a turn running"
   is exactly the bug the busy flag produced. */
export function canDo(control) {
  return turn.controls(turnState)[control];
}

export function setTurnState(event) {
  turnState = turn.next(turnState, event);
  const c = turn.controls(turnState);
  $('btn-mic').disabled = !c.mic;
  $('btn-send').disabled = !c.send;
  $('btn-next').disabled = !c.next;
  $('btn-end').disabled = !c.end;
  $('btn-mic').classList.toggle('listening', turnState === 'listening' || turnState === 'respeaking');
  $('thinking').hidden = turnState !== 'sending';
  return turnState;
}
```

`sendTurn`의 `state.busy` 검사와 대입을 전부 이 함수 호출로 교체한다. `nextScriptLine`도 같다. `state.busy`는 `api.js`의 `state`에서 삭제한다 — 남겨두면 두 개의 진실이 생긴다.

- [ ] **Step 3: Split `sendTurn` into `sendText(text)`**

지금 `sendTurn`은 입력창에서 값을 읽는다. 자동 전송은 입력창을 거치지 않으므로 본문을 `sendText(text)`로 빼고, `sendTurn`은 입력창을 읽어 그것을 호출하는 얇은 껍데기로 남긴다. 인식 콜백은 `sendText(transcript)`를 직접 부른다.

`sendText`는 성공한 턴의 user 말풍선에 `data-turn-text`와 되돌리기 진입점을 붙인다:

```javascript
  const bubble = addMessage('user', text);
  bubble.classList.add('undoable');
  bubble.title = '잘못 인식됐다면 눌러서 고치세요';
```

- [ ] **Step 4: Implement undo**

```javascript
export async function undoLastTurn(bubble) {
  if (!canDo('undo')) return;
  setTurnState('UNDO');
  try {
    await api(`/sessions/${state.sessionId}/last-turn`, { method: 'DELETE' });
    // Drop the learner bubble, its chip, and the bot reply that followed.
    let node = bubble.nextSibling;
    while (node) { const gone = node; node = node.nextSibling; gone.remove(); }
    bubble.remove();
  } catch (err) {
    notify(`되돌리지 못했습니다: ${err.message}`);
  } finally {
    setTurnState('UNDO_DONE');
  }
}
```

되돌린 뒤 고친 문장을 입력창에 넣고 포커스를 준다 — 사용자는 대개 같은 문장을 고쳐 다시 말한다.

- [ ] **Step 5: Wire the click in `main.js`**

```javascript
$('conversation').addEventListener('click', (e) => {
  const bubble = e.target.closest('.msg.user.undoable');
  if (bubble) undoLastTurn(bubble);
});
```

마지막 user 말풍선에만 `undoable`을 남긴다 — 새 턴을 보낼 때 이전 말풍선에서 그 클래스를 제거한다. 중간 턴을 지우면 그 뒤의 대화가 말이 안 되게 된다.

- [ ] **Step 6: Style it**

```css
.msg.user.undoable { cursor: pointer; }
.msg.user.undoable:hover { outline: 1px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 7: Verify**

```powershell
node --test static/js/
.\venv\Scripts\python.exe -m pytest -m "not engine" -q
```

포트 8010에서: 자유 모드로 세션을 시작하고, 입력창에 문장을 넣어 보내고, 방금 보낸 말풍선을 클릭해 되돌리고, DB에서 그 턴이 사라졌는지 확인한다. 자유 식별자 감사를 다시 돌린다.

- [ ] **Step 8: Commit**

```bash
git add static/js static/css
git commit -m "feat: send a recognised turn automatically, with undo on the bubble"
```

---

### Task 7: 접히는 교정 칩

**Files:**
- Modify: `static/js/session.js`, `static/css/components.css`

**Interfaces:**
- Consumes: `/api/chat` 응답의 `ok` / `fixed` / `tag` / `correction` / `suggestion`
- Produces: `session.addChip(bubble, feedback)` — user 말풍선 뒤에 칩 한 줄을 붙인다

- [ ] **Step 1: Implement `addChip`**

```javascript
/* One line under the learner's bubble, expanding in place.

   The prose the model returns is two Korean sentences per field, and it comes
   back on every single turn -- rendered in full it buries the conversation
   within two exchanges. Collapsed, a correct turn reads as praise rather than
   as the model's boilerplate "고칠 부분이 없습니다". */
export function addChip(bubble, fb) {
  if (fb.ok === null || fb.ok === undefined) return; // no feedback for this turn
  const wrap = document.createElement('div');
  wrap.className = 'chip-row';

  const summary = document.createElement('button');
  summary.className = `chip ${fb.ok ? 'ok' : 'fix'}`;
  summary.textContent = fb.ok ? '✓ 문장 정확' : `고칠 곳 · ${fb.tag || '문법'}`;

  const detail = document.createElement('div');
  detail.className = 'chip-detail';
  detail.hidden = true;
  if (fb.correction) detail.appendChild(block('교정', fb.correction, 'corr'));
  if (fb.suggestion) detail.appendChild(block('이렇게도', fb.suggestion, 'sug'));

  summary.addEventListener('click', () => { detail.hidden = !detail.hidden; });

  wrap.append(summary, detail);
  bubble.after(wrap);
  return wrap;
}

function block(label, text, kind) {
  const el = document.createElement('div');
  el.className = `chip-block ${kind}`;
  el.innerHTML = `<span class="label"></span> `;
  el.firstChild.textContent = label;
  el.append(document.createTextNode(text));
  return el;
}
```

`innerHTML`로 모델 출력을 넣지 않는다 — `textContent`와 `createTextNode`로만 넣는다. 모델이 돌려준 문자열에 `<`가 있으면 마크업으로 해석된다.

`addFeedback`(Task 5에서 비워둔 것)을 삭제하고 `sendText`/`nextScriptLine`의 호출을 `addChip(bubble, data)`로 바꾼다.

- [ ] **Step 2: Style the chips**

```css
.chip-row { max-width: 78%; margin: calc(var(--space-1) * -1) 0 var(--space-3) auto; }

.chip {
  font-size: var(--text-xs); font-weight: 600;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill); border: 0; cursor: pointer;
}
.chip.ok  { background: var(--suggest-bg); color: var(--suggest-ink); }
.chip.fix { background: var(--correct-bg); color: var(--correct-ink); }

.chip-detail { margin-top: var(--space-2); }
.chip-block {
  font-size: var(--text-sm); line-height: 1.5;
  border-left: 2px solid; border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2);
}
.chip-block.corr { background: var(--correct-bg); color: var(--correct-ink); border-color: var(--correct); }
.chip-block.sug  { background: var(--suggest-bg); color: var(--suggest-ink); border-color: var(--suggest); }
```

`--correct` / `--suggest` / `--suggest-bg` / `--suggest-ink`는 Phase 2A가 정의해두고 아직 안 쓰던 토큰이다. 이제 쓴다.

- [ ] **Step 3: Verify**

포트 8010에서 세션을 시작하고 일부러 틀린 문장(`I go store yesterday.`)과 맞는 문장(`My father is a doctor.`)을 각각 보낸다. 확인할 것:
- 틀린 턴에 `고칠 곳 · 시제` 칩이 접힌 채로 뜨고, 누르면 한국어 교정이 펼쳐진다
- 맞은 턴에 `✓ 문장 정확` 칩이 뜬다
- 두 칩의 색이 서로 다르고, 다크 모드에서도 읽힌다

`node --test static/js/`와 파이썬 스위트도 돌린다.

- [ ] **Step 4: Commit**

```bash
git add static/js static/css
git commit -m "feat: collapse corrections into a chip that expands in place"
```

---

### Task 8: 재발화

교정을 읽는 것과 고쳐서 다시 말하는 것은 다르다. 읽고 넘기면 다음 턴에 똑같이 틀린다.

**Files:**
- Modify: `static/js/session.js`, `static/js/audio.js`, `static/css/components.css`

**Interfaces:**
- Consumes: `match.matches` (Task 3), `turnstate` 의 `respeaking` (Task 4), `fb.fixed`
- Produces: `session.startRespeak(target, resultEl)`

- [ ] **Step 1: Add the button to the expanded chip**

`addChip`의 `detail`에, `fb.fixed`가 있고 `fb.ok`가 거짓일 때만 붙인다:

```javascript
  if (!fb.ok && fb.fixed) {
    const row = document.createElement('div');
    row.className = 'respeak-row';
    const btn = document.createElement('button');
    btn.className = 'respeak';
    btn.textContent = '🎤 고쳐서 다시 말해보기';
    const target = document.createElement('div');
    target.className = 'respeak-target';
    target.textContent = fb.fixed;
    const result = document.createElement('p');
    result.className = 'respeak-result';
    result.hidden = true;
    btn.addEventListener('click', () => startRespeak(fb.fixed, result));
    row.append(target, btn, result);
    detail.appendChild(row);
  }
```

- [ ] **Step 2: Implement `startRespeak`**

```javascript
import { matches } from './match.js';

/* Re-speaking is deliberately a different state from a normal turn: the
   recognised text is compared against `fixed` and never sent to the bot. */
export function startRespeak(target, resultEl) {
  if (!recognition) { notify('이 브라우저는 음성 인식을 지원하지 않습니다.'); return; }
  setTurnState('RESPEAK');
  resultEl.hidden = false;
  resultEl.className = 'respeak-result';
  resultEl.textContent = '듣는 중...';

  setRespeakHandler((spoken) => {
    setTurnState('HEARD');
    if (spoken === null) {
      resultEl.textContent = '못 알아들었습니다. 다시 해보세요.';
      return;
    }
    const good = matches(spoken, target, state.language);
    resultEl.classList.add(good ? 'good' : 'bad');
    resultEl.textContent = good ? `좋습니다 — "${spoken}"` : `"${spoken}" — 조금 다릅니다. 다시 해보세요.`;
  });
  recognition.lang = BCP47[state.language];
  recognition.start();
}
```

`setRespeakHandler`는 Task 6에서 이미 `audio.js`에 만들어져 있다. `audio.js`의 `deliver`가 재발화 핸들러를 우선하고 한 번 쓴 뒤 비우므로, 재발화 결과가 자동 전송 경로로 새지 않는다. `startRespeak`는 그 계약에 기대므로 `audio.js` 쪽을 다시 고칠 필요가 없다 — 고쳐야 한다고 느껴지면 Task 6의 `deliver` 구현을 먼저 다시 읽는다.

`session.js` 상단의 import에 `recognition`, `BCP47`, `setRespeakHandler`를 추가한다. 지금은 `play`만 가져오고 있다.

- [ ] **Step 3: Style it**

```css
.respeak-row { margin-top: var(--space-2); }
.respeak-target {
  font-size: var(--text-base); font-weight: 600;
  padding: var(--space-2) 0;
}
.respeak {
  font-size: var(--text-xs); padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
}
.respeak-result { font-size: var(--text-sm); margin: var(--space-2) 0 0; color: var(--text-dim); }
.respeak-result.good { color: var(--suggest-ink); }
.respeak-result.bad  { color: var(--correct-ink); }
```

- [ ] **Step 4: Verify**

포트 8010에서 틀린 문장을 보내고 칩을 펼친 뒤 「고쳐서 다시 말해보기」를 눌러 실제로 말해본다 (마이크 권한이 필요하다). 확인할 것:
- 고친 문장을 정확히 말하면 통과로 표시된다
- 다른 문장을 말하면 통과하지 않는다
- 재발화 중 인식 결과가 **봇에게 전송되지 않는다** — 대화에 새 턴이 생기지 않아야 한다. 이것이 이 태스크에서 가장 깨지기 쉬운 부분이다

`node --test static/js/`와 파이썬 스위트도 돌린다.

- [ ] **Step 5: Commit**

```bash
git add static/js static/css
git commit -m "feat: let the learner re-speak the corrected sentence"
```

---

### Task 9: 내 녹음 재생

이미 저장되고 있는데 아무도 듣지 못하던 데이터를 화면에 연결한다.

**Files:**
- Modify: `static/js/session.js`, `static/css/components.css`

**Interfaces:**
- Consumes: `GET /api/messages/{id}/audio` (Task 2)
- Produces: user 말풍선에 붙는 재생 버튼

- [ ] **Step 1: Attach the message id to the bubble**

`uploadPendingRecording`은 업로드한 message id를 이미 알고 있다. 그것을 말풍선에 실어준다:

```javascript
export async function uploadPendingRecording(bubble) {
  if (!state.chunks.length) return;
  ...
    await api(`/sessions/${state.sessionId}/audio`, { method: 'POST', body: form });
    if (bubble) addPlayButton(bubble, lastUser.id);
  ...
}
```

`sendText`와 `nextScriptLine`이 자기 말풍선을 넘기도록 고친다.

- [ ] **Step 2: Implement `addPlayButton`**

```javascript
/* The learner's own recording, next to the bot's native-speaker clip. Hearing
   the two back to back is what makes pronunciation differences audible.
   Phase 1 stored these and never played them. */
function addPlayButton(bubble, messageId) {
  const btn = document.createElement('button');
  btn.className = 'play-mine';
  btn.textContent = '▶ 내 발음';
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // the bubble itself is the undo target
    new Audio(`/api/messages/${messageId}/audio`).play()
      .catch(() => notify('녹음을 재생할 수 없습니다.'));
  });
  bubble.appendChild(btn);
}
```

- [ ] **Step 3: Style it**

```css
.play-mine {
  display: block; margin-top: var(--space-2);
  font-size: var(--text-xs); padding: 2px var(--space-2);
  border-radius: var(--radius-pill); color: var(--text-dim);
}
```

- [ ] **Step 4: Verify**

포트 8010에서 마이크로 한 턴 말한 뒤 확인한다:
- 말풍선에 `▶ 내 발음` 버튼이 생긴다
- 눌러서 내 목소리가 재생된다
- 버튼을 눌러도 **되돌리기가 발동하지 않는다** (`stopPropagation`이 실제로 듣는지)
- 녹음이 없는 턴(텍스트로 입력한 턴)에는 버튼이 안 생긴다

- [ ] **Step 5: Commit**

```bash
git add static/js static/css
git commit -m "feat: play the learner's own recording back beside the bot's"
```

---

## B단계 완료 확인

- [ ] **테스트 전부**

```powershell
node --test static/js/
.\venv\Scripts\python.exe -m pytest -m "not engine"
.\venv\Scripts\python.exe -m pytest tests/test_feedback_quality.py -m engine
```

- [ ] **손으로 한 바퀴** (브라우저, Ctrl+Shift+R 후)

자유 모드로 시작 → 마이크로 말하기 → 자동 전송 확인 → 틀린 문장에 칩이 접혀 뜨는지 → 펼쳐서 재발화 → 내 녹음 재생 → 말풍선 클릭으로 되돌리기 → 세션 끝내기 → 리포트.

스크립트 모드로도 한 번 — 우측 패널에 대본이 뜨고 진행되는지.

- [ ] **`state.busy`가 저장소에 남아 있지 않은지**

```powershell
Select-String -Path static/js/*.js -Pattern "busy"
```
결과가 없어야 한다. 남아 있으면 상태 머신과 옛 플래그가 공존하는 것이고, 그 둘은 반드시 어긋난다.

---

## 다음 단계

B단계가 끝나면 **C단계(홈)** 계획을 따로 쓴다. C는 통합 입력창과 LLM 시나리오 생성, 이어서 하기, i+1을 다룬다. 그다음 D(마이페이지), E(새 모드) 순이다.
