# 1분 말하기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 모드 `1분 말하기` — 테마에서 레벨에 맞는 질문을 골라 60초 동안 끊지 않고 말하고, 끝난 뒤 문장별 교정·원어민 답·유창성 수치를 보고, 같은 주제로 다시 말해 1회차와 비교한다.

**Architecture:** 세션 `mode='timed'`. 한 회차 = 연속 녹음 1개 → 서버가 Whisper 구간(segment)으로 받아쓰고 순수 함수(`app/timed.py`)로 문장 분리·단어 수·긴 멈춤을 계산해 `timed_rounds`(v9)에 저장. 클라이언트가 문장마다 기존 `_feedback`을 부르는 엔드포인트를 차례로 호출(진행률), 이어서 `원어민이라면`+레벨 1회. 1회차 문장만 `messages`에 들어가 기존 정확도·약점·복습·코치가 그대로 동작. 화면은 전용 `#timed` + `static/js/timed.js`(자체 MediaRecorder·SpeechRecognition, 기존 턴 인식과 분리).

**Tech Stack:** FastAPI + SQLite, faster-whisper(`app/stt.py`), Ollama qwen2.5:14b(`app/llm.py`), vanilla JS ES modules, node:test + dom-shim, pytest.

**Spec:** `docs/superpowers/specs/2026-09-19-monologue-timed-speaking-design.md`

## Global Constraints

- 기준 main `76846ac`(스키마 v8). 이 계획이 v9를 더한다. 워크트리 `C:/git/Monologue-wt/timed`, 브랜치 `timed`.
- **1회차만 기록**: messages 행·복습 큐·레벨은 round 1에서만. 2회차~는 `timed_rounds`에만.
- 녹음은 잃지 않는다: 받아쓰기·교정 실패는 재시도 가능, 녹음 파일은 세션 끝(`_sweep_recordings`)에서만 지운다 — `timed_rounds.audio_path`도 정리 대상.
- 긴 멈춤 기준 3.0초. 60초 자동 정지(클라이언트), 서버 안전 상한 90초 분량 허용(기존 `_MAX_TRANSCRIBE_BYTES` 재사용).
- 일본어 단어 수 = 구두점·공백 제외 글자 수, 표시 단위 `자`. 영어 = 공백 기준 단어, 단위 `단어`.
- 한국어 설명·뜻은 `api._is_korean_meaning`으로 검사(중국어 누출 금지).
- 화면: 단계 전환 때 크기 고정(자리 예약, 짧은 opacity 페이드, **transform 금지**). 오래 걸리는 것은 문구로 알린다(`질문을 만들고 있어요`, `받아쓰는 중이에요`, `교정하는 중이에요 · 3/9문장`, `원어민 답을 만드는 중이에요`). 내 말은 취소선 없음(`.said`/`.fix-row` 클래스 쓰지 말 것).
- dom-shim: selector 엔진 없음, `closest()` null, `dataset` 비어 있음, **`children`이 Array**(실제 브라우저는 HTMLCollection — `Array.from(el.children)`을 쓸 것; 새 코드에서 `.children.filter/map` 금지).
- CSS 토큰은 `static/css/tokens.css`에 있는 것만.
- pytest: `cd <worktree> && PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/git/Monologue/venv/Scripts/python.exe -m pytest -m "not engine" -q -p no:cacheprovider` (워크트리에선 kokoro 1개 실패가 정상). node: `node --test --test-force-exit static/js/*.test.js`. engine 테스트는 실행하지 말 것(컨트롤러가 돌림).
- 새 테스트마다 구현을 일부러 부숴 빨개지는지 확인하고 보고서에 적는다. 브라우저로 보지 않았으면 봤다고 쓰지 않는다.
- 커밋: 소문자 `feat:`/`fix:` 문장, 끝줄 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. 커밋 전 `git branch --show-current`가 `timed`.

---

### Task 1: 서버 토대 — 순수 계산, 구간 받아쓰기, v9 테이블

**Files:**
- Create: `app/timed.py`, `tests/test_timed.py`
- Modify: `app/stt.py` (`transcribe_segments`), `app/db.py` (v9, round 함수들, 녹음 정리), `app/config.py` (`MODES`에 `"timed"`)
- Test: `tests/test_db.py`, `tests/test_stt.py`

**Interfaces — Produces:**
- `stt.transcribe_segments(audio: bytes, language) -> list[{"start": float, "end": float, "text": str}]` — `transcribe`와 같은 옵션(vad_filter=True, beam_size=1, condition_on_previous_text=False, initial_prompt 없음), 구간 텍스트는 strip. 기존 `transcribe`는 이 함수를 써서 `"".join`하도록 바꾸지 말고 그대로 둔다(회귀 위험 없이).
- `timed.split_sentences(segments, language) -> list[str]`
- `timed.count_words(text, language) -> int`
- `timed.long_pauses(segments, threshold=3.0) -> int`
- `timed.round_stats(segments, language, seconds) -> {"words": int, "wpm": int, "long_pauses": int, "sentences": list[str]}`
- db: `add_round(session_id, round, seconds, words, long_pauses, sentences, audio_path) -> int(round)`, `get_rounds(session_id) -> list[dict]` (round 오름차순; `sentences`는 파싱된 list[dict]), `set_round_sentences(session_id, round, sentences)`, `set_round_native(session_id, round, native, level)`, `next_round(session_id) -> int`. `clear_session_audio`가 `timed_rounds.audio_path`도 NULL로 하고 경로를 돌려준다.
- `config.MODES = ("free", "script", "lesson", "timed")`.

**timed.py 규칙(정확히):**

```python
"""1분 말하기의 계산. 모델도 DB도 부르지 않는 순수 함수만 -- 테스트가 숫자를 못박는다."""
import re

_END = re.compile(r"(?<=[.?!。？！])\s*")
_JA_SKIP = re.compile(r"[\s、。，．？！?!「」『』（）()・…ー~〜]")
_MIN_WORDS = {"en": 3, "ja": 4}   # 이보다 짧은 조각은 앞 문장에 붙인다(ja는 글자 수)
LONG_PAUSE = 3.0


def count_words(text, language) -> int:
    if language == "ja":
        return len(_JA_SKIP.sub("", text))
    return len([w for w in text.split() if re.search(r"[A-Za-z0-9]", w)])


def split_sentences(segments, language) -> list[str]:
    joiner = "" if language == "ja" else " "
    text = joiner.join(s["text"].strip() for s in segments if s["text"].strip())
    parts = [p.strip() for p in _END.split(text) if p.strip()]
    out: list[str] = []
    for p in parts:
        if out and count_words(p, language) < _MIN_WORDS[language]:
            out[-1] = f"{out[-1]}{joiner}{p}"
        else:
            out.append(p)
    return out


def long_pauses(segments, threshold=LONG_PAUSE) -> int:
    ordered = sorted(segments, key=lambda s: s["start"])
    return sum(1 for a, b in zip(ordered, ordered[1:]) if b["start"] - a["end"] >= threshold)


def round_stats(segments, language, seconds) -> dict:
    sentences = split_sentences(segments, language)
    words = sum(count_words(s, language) for s in sentences)
    minutes = max(seconds, 1) / 60
    return {"words": words, "wpm": round(words / minutes), "long_pauses": long_pauses(segments),
            "sentences": sentences}
```

(첫 조각이 짧으면 붙일 앞 문장이 없으므로 그대로 둔다. 구두점 없는 긴 받아쓰기는 한 문장이 된다 — 그대로 둔다; 교정이 문장을 나눠 준다.)

**v9 마이그레이션(MIGRATIONS 끝):**

```python
    # v8 -> v9: 1분 말하기 회차 (docs/superpowers/specs/2026-09-19-monologue-
    # timed-speaking-design.md, "데이터"). Every round lives here; only round
    # 1's sentences also become messages rows, so level/accuracy/weak spots/
    # reviews count a minute once, not once per retelling.
    ["""
    CREATE TABLE IF NOT EXISTS timed_rounds (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER NOT NULL REFERENCES sessions(id),
        round          INTEGER NOT NULL,
        seconds        REAL    NOT NULL,
        words          INTEGER NOT NULL,
        long_pauses    INTEGER NOT NULL,
        sentences_json TEXT    NOT NULL,
        native         TEXT,
        level          TEXT,
        audio_path     TEXT,
        created_at     TEXT    NOT NULL,
        UNIQUE(session_id, round)
    );
    """],
```

`sentences_json`은 `[{"text": str, "graded": bool, "ok": bool|None, "fixed": str|None, "correction": str|None, "suggestion": str|None, "tag": str|None, "message_id": int|None}]`. `add_round`는 문장 문자열 목록을 받아 `graded: False`, 나머지 None으로 저장.

- [ ] **Step 1: 실패하는 테스트** — `tests/test_timed.py`:

```python
from app import timed

SEG = lambda s, e, t: {"start": s, "end": e, "text": t}


def test_english_words_ignore_punctuation_only_tokens():
    assert timed.count_words("Well, I went there -- yesterday.", "en") == 5


def test_japanese_counts_characters_without_punctuation():
    assert timed.count_words("昨日、公園に行きました。", "ja") == 10


def test_sentences_split_on_end_marks_and_short_tails_join_the_previous():
    segs = [SEG(0, 3, "I went to the park yesterday."), SEG(3.2, 5, "It was fun. Yes."), SEG(5.5, 8, "Then I ate lunch with my friend.")]
    assert timed.split_sentences(segs, "en") == [
        "I went to the park yesterday.", "It was fun. Yes.", "Then I ate lunch with my friend."]


def test_a_short_first_piece_stays():
    assert timed.split_sentences([SEG(0, 1, "Okay. I like trains a lot.")], "en") == ["Okay.", "I like trains a lot."]


def test_japanese_splits_on_japanese_marks():
    segs = [SEG(0, 2, "昨日は雨でした。"), SEG(2, 4, "だから家で本を読みました。")]
    assert timed.split_sentences(segs, "ja") == ["昨日は雨でした。", "だから家で本を読みました。"]


def test_long_pauses_count_gaps_of_three_seconds_or_more():
    segs = [SEG(0, 2, "a"), SEG(5, 6, "b"), SEG(7, 8, "c"), SEG(11.5, 12, "d")]
    assert timed.long_pauses(segs) == 2


def test_round_stats_per_minute():
    segs = [SEG(0, 10, "I went to the park and played soccer with my friends.")]
    s = timed.round_stats(segs, "en", 30)
    assert s["words"] == 11 and s["wpm"] == 22 and s["long_pauses"] == 0 and len(s["sentences"]) == 1


def test_empty_recording():
    assert timed.round_stats([], "en", 5) == {"words": 0, "wpm": 0, "long_pauses": 0, "sentences": []}
```

`"Okay."`은 1단어라 앞 문장이 있으면 붙지만 첫 조각이라 남는다 — 이 기대가 규칙과 맞는지 구현 후 확인하고, 규칙 문장과 테스트가 어긋나면 **규칙(위 코드)**을 따른다.

`tests/test_db.py`에: v9 테이블 생성·`schema_version()==9`·v8 DB가 v9로 올라가며 기존 행 유지(Task 1의 v7→v8 테스트 방식 그대로), `add_round`/`get_rounds`/`next_round`(빈 세션 1, 하나 있으면 2)/`set_round_sentences`/`set_round_native` 왕복, `clear_session_audio`가 round 녹음 경로도 돌려주고 NULL로 만듦. 기존 `schema_version()==8` 기대는 9로.

`tests/test_stt.py`에: 가짜 모델(기존 테스트의 목 패턴을 따름)이 구간 두 개를 주면 `transcribe_segments`가 `[{"start","end","text"}]`(strip됨)를 돌려주고, 모델이 준비 안 됐으면 `SttUnavailable`.

- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — 위 코드와 인터페이스대로. `stt.transcribe_segments`는 `transcribe`와 같은 `_status`/`_lock` 가드.
- [ ] **Step 4: 통과 확인** — 대상 파일 + 전체 `-m "not engine"`.
- [ ] **Step 5: 부숴 보기** — (a) `long_pauses`의 `>=`를 `>`로 → 3.0초 경계 테스트가 있어야 빨갛다(없으면 `SEG(2,5)` 경계 케이스를 추가), (b) 짧은 조각 붙이기 제거 → 빨강, (c) `clear_session_audio`에서 rounds 제외 → 빨강.
- [ ] **Step 6: 커밋** — `feat: 1분 말하기 groundwork -- words, sentences and long pauses from whisper segments, and a table for rounds (v9)`

---

### Task 2: 서버 — 질문 만들기와 timed 세션 시작

**Files:** Modify `app/prompts.py`, `app/api.py`, `app/db.py`(`resumable_session`에서 timed 제외); Create `tests/test_api_timed.py`, `tests/test_timed_quality.py`(engine)

**Interfaces — Consumes:** `library.get_theme(theme_id)`(있는지 확인; 없으면 `library.load_themes()`에서 찾기), `db.stable_level`, `_is_korean_meaning`, `_first_line`, `llm.chat_json`.
**Produces:**
- `Mode = Literal["free", "script", "lesson", "timed"]`.
- `GET /api/timed/questions?language=&theme_id=` → `{"questions": [{"text", "meaning", "starter"}]}` (2~3개), 503 `"지금은 질문을 만들 수 없어요"`, 404 모르는 테마.
- `POST /api/sessions {"language", "mode": "timed", "topic": "<질문>"}` → `{"session_id", "mode": "timed", "topic"}`. topic 없거나 공백이면 400. 모델 호출·봇 첫마디 없음. scenario_id를 주면 400.
- `db.resumable_session`은 `mode='timed'`를 제외한다(이어하기 카드는 대화 세션용 — timed를 대화처럼 열면 깨진다; 버려진 timed 세션은 기존 stale 정리가 처리).

**프롬프트(prompts.py 끝):**

```python
# Editing this string? Run `pytest tests/test_timed_quality.py -m engine`.
TIMED_QUESTIONS_SYSTEM = """당신은 한국인 학생의 {lang} 말하기 연습을 돕는 한국어 원어민 교사입니다.
설명은 한국어로만 씁니다.

학생이 1분 동안 혼자 말할 질문을 3개 주세요. 주제: {theme}. 학생 수준: {level}.
- text: 학생에게 묻는 {lang} 질문 한 문장. 학생 수준에 맞는 쉬운 단어로, 자기 경험이나 생각을 1분 동안 말할 수 있게 열린 질문으로
- meaning: 그 질문의 뜻을 자연스러운 한국어 한 줄로. 한글로만 씁니다
- starter: 학생이 말을 시작할 수 있는 {lang} 첫 마디(문장 앞부분, "..."으로 끝남)
세 질문은 서로 다른 방향이어야 합니다(경험, 계획, 의견처럼).
마크다운과 이모지는 쓰지 않습니다."""

TIMED_QUESTIONS_EXAMPLES = {
    "en": ("일상 · 주말", [
        {"text": "What did you do last weekend?", "meaning": "지난 주말에 뭐 했어요?", "starter": "Last weekend, I..."},
        {"text": "What is your plan for this weekend?", "meaning": "이번 주말 계획이 뭐예요?", "starter": "This weekend, I'm going to..."},
        {"text": "Do you like to stay home or go out on weekends? Why?", "meaning": "주말엔 집에 있는 게 좋아요, 나가는 게 좋아요? 왜요?", "starter": "I like to... because..."},
    ]),
    "ja": ("日常 · 週末", [
        {"text": "先週末は何をしましたか。", "meaning": "지난 주말에 뭐 했어요?", "starter": "先週末は..."},
        {"text": "今週末の予定は何ですか。", "meaning": "이번 주말 계획이 뭐예요?", "starter": "今週末は..."},
        {"text": "週末は家にいるのと出かけるのと、どちらが好きですか。", "meaning": "주말엔 집에 있는 것과 나가는 것 중 어느 쪽이 좋아요?", "starter": "私は...が好きです。なぜなら..."},
    ]),
}


def timed_questions_schema() -> dict:
    return {"type": "object", "properties": {"questions": {"type": "array", "items": {
        "type": "object",
        "properties": {"text": {"type": "string"}, "meaning": {"type": "string"}, "starter": {"type": "string"}},
        "required": ["text", "meaning", "starter"]}}}, "required": ["questions"]}


def build_timed_questions_messages(language, theme_title, level) -> list[dict]:
    system = TIMED_QUESTIONS_SYSTEM.format(lang=KOREAN_LANGUAGE_NAMES[language], theme=theme_title,
                                           level=_LEVEL_KOREAN.get(level, "초급"))
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    example_theme, example = TIMED_QUESTIONS_EXAMPLES[language]
    ask = lambda t: f"주제: {t}\n1분 말하기 질문 3개를 주세요."
    return [{"role": "system", "content": system},
            {"role": "user", "content": ask(example_theme)},
            {"role": "assistant", "content": json.dumps({"questions": example}, ensure_ascii=False)},
            {"role": "user", "content": ask(theme_title)}]
```

(`JAPANESE_SCRIPT_ONLY_RULE`, `_LEVEL_KOREAN`이 이 파일에 이미 있다.) 테마 제목은 themes.json의 한국어 제목 필드(파일을 읽고 맞는 키를 쓸 것).

**검사(api.py `_valid_questions(raw, language) -> list[dict]`):** 최대 3개. `text`: `_first_line` 후 비어 있지 않고, en이면 라틴 문자 포함·한글 없음, ja면 가나 포함·한글·라틴 없음(기존 `_valid_replies`의 언어 판정 정규식 `_KANA`, `_LATIN_LETTER`, `_HANGUL` 재사용). `meaning`: `_is_korean_meaning(meaning, source=text)`. `starter`: 비면 버리지 말고 `""`로(힌트 없이 보여줌), 한글이 섞이면 `""`. 같은 text 중복 제거. 2개 미만이면 1회 더(`_generate_suggestions`와 같은 규칙: 죽은 모델은 재시도 안 함), 0개면 503.
**캐시:** `functools.lru_cache`로 `(language, theme_id, level, today_iso)` 키 → 성공만 캐시(예외는 캐시 안 됨).

- [ ] **Step 1: 실패하는 테스트** — `tests/test_api_timed.py`(fixture는 `tests/test_api_coach.py`의 client fixture를 따른다; `llm.chat_json`을 목):
  - 질문 3개 정상 → 200, 3개, 필드 그대로.
  - 한 개가 중국어 뜻 / 한글 섞인 영어 질문 / 빈 text → 그 항목만 빠짐.
  - 1개만 유효 → 모델 2회 호출, 두 번째 결과로 채움. 모델 예외 → 1회 호출 후 503.
  - 같은 날 같은 테마 두 번 → 모델 1회.
  - 모르는 테마 → 404.
  - timed 세션 시작: topic 필수(400), scenario_id 주면 400, 성공 시 봇 메시지 없음(`db.get_messages` 빈 목록), 응답 모양.
  - `resumable`이 timed 세션을 돌려주지 않음(메시지가 있어도).
- [ ] **Step 2~4:** 실패 확인 → 구현 → 통과(대상 + 전체).
- [ ] **Step 5: 품질 테스트 파일** `tests/test_timed_quality.py`(`pytestmark = pytest.mark.engine`): en/ja 각각 테마 3개에 대해 `_generate_timed_questions`를 불러 표를 출력하고, 질문 2~3개·뜻 한국어·목표 언어 질문을 단언. 실행하지 말 것.
- [ ] **Step 6: 부숴 보기** — `_is_korean_meaning` 검사 제거 → 빨강, 캐시 제거 → 빨강, resumable 제외 조건 제거 → 빨강.
- [ ] **Step 7: 커밋** — `feat: 1분 말하기 starts from a theme -- three level-sized questions, and a timed session with no opening line`

---

### Task 3: 서버 — 회차 올리기, 문장 교정, 원어민 답

**Files:** Modify `app/api.py`, `app/prompts.py`; Test `tests/test_api_timed.py`

**Interfaces — Consumes:** Task 1 (`stt.transcribe_segments`, `timed.round_stats`, db round 함수), 기존 `_feedback(language, text, topic=...)`, `db.add_message`, `db.enqueue_review`, `_today`.
**Produces:**
- `POST /api/sessions/{id}/timed/rounds` multipart `file`, `seconds`(float, 클라이언트가 잰 말한 시간) → 녹음 저장(`AUDIO_DIR/s{id}_r{n}.webm`) + 받아쓰기 + `add_round` →
  `{"round": n, "seconds", "words", "wpm", "long_pauses", "sentences": [{"text"}]}`. 받아쓰기 불가 → 503 `{"detail": "받아쓰기를 할 수 없어요", ...}` 이지만 **녹음은 저장되고 회차 번호도 예약**: 이 경우 `add_round`를 sentences=[]로 저장하고 응답 503 본문에 `round` 포함(FastAPI `HTTPException(503, detail={"message": ..., "round": n})`).
- `POST /api/sessions/{id}/timed/rounds/{n}/transcribe` → 저장된 녹음으로 다시 받아쓰기(성공 시 문장·통계 갱신, 위와 같은 응답). 이미 문장이 있으면 409.
- `POST /api/sessions/{id}/timed/rounds/{n}/grade/{i}` → 문장 i를 `_feedback(language, text, topic=session.topic)`으로 교정 →
  `{"i", "text", "ok", "fixed", "correction", "suggestion", "tag"}`, `set_round_sentences`로 저장(`graded: True`). 이미 교정된 문장이면 저장된 값을 그대로(모델 호출 없음). **round 1이면** `db.add_message(sid, "user", text, …)`로 행을 만들고 `message_id` 기록, `ok is False and fixed`면 `enqueue_review(message_id, language, today+1)`. `_feedback`이 교정 실패(ok None)를 돌려주면 `graded: False`로 남기고 200 `{"i", "text", "ok": None, ...}` — 클라이언트가 `교정하지 못했어요` + 재시도.
- `POST /api/sessions/{id}/timed/rounds/{n}/native` → `{"native": str, "level": str|None}`. 모델 1회: 학생 문장들(교정된 fixed가 있으면 fixed, 없으면 text)과 주제를 주고, 같은 내용을 원어민이 1분 답으로 말하듯 자연스럽게(학생 수준 +1, 120~160단어 / ja 250~350자) + round 1이면 level(`config.LEVELS` enum). 검사: native가 목표 언어(한글 없음, ja는 가나 포함), 길이 상한(en 220단어 / ja 450자 넘으면 자름 대신 거절→503). `set_round_native` 저장, 이미 있으면 저장된 값. 실패 503 `"지금은 원어민 답을 만들 수 없어요"`.
- 공통: 세션 없음 404, timed 아님 400, 끝난 세션 409, 없는 회차/문장 404.

**프롬프트:** `TIMED_NATIVE_SYSTEM`(한국어 지시, 위 규칙), `timed_native_schema()` = `{native: string, level: enum LEVELS}`, `build_timed_native_messages(language, topic, sentences, level)`. few-shot 1개(en/ja 각각, 짧은 합성 예 — **실제 학습자 문장 쓰지 말 것**).

- [ ] **Step 1: 실패하는 테스트** (stt·llm·tts 목):
  - 업로드 → 문장·통계, 파일이 AUDIO_DIR에 생김, `get_rounds`에 1회차. 두 번째 업로드 → round 2.
  - 받아쓰기 불가 → 503 + detail.round, 녹음 파일 있음, 이어서 `/transcribe` 성공 → 문장 채워짐; 두 번째 `/transcribe` → 409.
  - grade: round 1 문장 교정 → messages 행 1개(ok/fixed/tag), 틀리면 review_queue에 내일; 같은 문장 다시 grade → 모델 추가 호출 없음·행 추가 없음. round 2 grade → messages 행 없음·review 없음·`timed_rounds` 2회차 문장에만 저장.
  - `_feedback` 실패(ok None) → 200 ok None, `graded` False, messages 행 없음.
  - native: round 1 → level 저장, round 2 → level None 저장; 한글 섞인 native → 503; 캐시(두 번째 호출 모델 없음).
  - 끝난 세션 → 409, 다른 모드 세션 → 400.
- [ ] **Step 2~4.**
- [ ] **Step 5: 부숴 보기** — round 2에서도 add_message 하도록 → 빨강; grade 재호출 캐시 제거 → 빨강; 503 경로에서 녹음 저장 안 하게 → 빨강.
- [ ] **Step 6: 커밋** — `feat: a round of 1분 말하기 -- one recording, sentences graded one by one, a native answer; only round one is kept as practice`

---

### Task 4: 서버 — 끝내기, 리포트, 기록

**Files:** Modify `app/api.py`, `app/db.py`(`history`에 `rounds`), Test `tests/test_api_timed.py`, `tests/test_api_mypage.py`

**Produces:**
- `/sessions/{id}/end` timed 분기(`session["mode"] == "timed"`, shadowing 분기 다음): 레벨 = round 1의 level(없으면 None) → `db.end_session(id, json.dumps({"kind": "timed"}), level)` → `_sweep_recordings(id)` → 응답 `_timed_report(session)`.
- `_timed_report(session) -> {"kind": "timed", "topic", "level", "rounds": [{"round", "seconds", "words", "wpm", "long_pauses", "fixed": <ok False 개수>, "graded": <graded 개수>, "sentences": [...], "native"}], "summary": "", "weak_points": [], "expressions": [], "next_focus": "", "stats": {"turns": <round1 문장 수>, "wrong": <round1 ok False>, "minutes": <합계 초/60 반올림>}}`.
- `GET /sessions/{id}/report`: 저장된 report가 `{"kind": "timed"}`면 `_timed_report` 재구성(쉐도잉이 하는 방식을 따른다 — 코드를 읽고 같은 자리에 분기).
- `db.history` 행에 `rounds`(timed_rounds 개수; 다른 모드는 0) 추가. timed의 `wrong`/`graded`는 기존 비-script 계산 그대로(1회차 messages).
- 회차가 하나도 없는 timed 세션을 끝내면: 리포트 rounds 빈 배열, level None(오류 아님).

- [ ] **Step 1: 실패하는 테스트:** 2회차 세션 end → kind timed, rounds 2개, level = round1 level, 녹음 파일 삭제됨·audio_path NULL; end 후 report GET 같은 모양; history 행 `rounds == 2`, mode timed; 회차 없는 세션 end; mypage stats의 accuracy/tags가 round 1 문장만 셈(2회차 틀린 문장이 늘리지 않음).
- [ ] **Step 2~4.** **Step 5: 부숴 보기** — sweep에서 rounds 제외 → 빨강; report GET 분기 제거 → 빨강.
- [ ] **Step 6: 커밋** — `feat: ending 1분 말하기 -- a report of every round, level from the first, recordings swept`

---

### Task 5: 화면 — 홈 카드와 질문 고르기

**Files:** Modify `static/index.html`, `static/js/pick.js`, `static/js/home.js`(모드 이름), `static/js/mypage.js`(`MODE_NAMES`·`historySub`), `static/css/components.css`; Test `static/js/pick.test.js`, `static/js/home.test.js`, `static/js/mypage.test.js`, `tests/test_ui_stability_css.py`

**Produces:**
- 홈 `.modes`에 `<button type="button" data-mode="timed" class="mode"><span class="n">1분 말하기</span><span class="d">질문 하나에 1분 동안 말하고 다시 말해 비교</span></button>` (기존 카드 마크업 모양을 따른다). 폰(≤480px) 2열 그리드에서 5번째 카드는 `grid-column: 1 / -1`.
- `openPick('timed')`: `MODE_LABELS.timed = '1분 말하기'`. 테마 목록은 기존 그대로. 테마를 고르면(시나리오 목록 대신) `#pick-questions` 영역에 `질문을 만들고 있어요` + 스켈레톤 3개(자리 예약) → `GET /api/timed/questions` → 질문 카드 3개(`text` / `meaning` / `힌트: starter`). 카드를 누르면 선택(aria-pressed), `직접 입력` 입력칸(`#pick-own`, 기존 `#wish` 스타일)에 쓰면 그게 질문. 실패 → 그 영역만 `질문을 만들지 못했어요` + `다시 시도`; 직접 입력은 계속 가능.
- `startFromPick()`의 timed 분기: 질문(선택 카드의 text 또는 직접 입력, trim) 없으면 시작 버튼 비활성. `POST /api/sessions {language, mode: 'timed', topic}` → `openTimed({ sessionId, topic, meaning, starter })`(Task 6이 만든다 — 이 태스크에서는 `timed.js`에 `export function openTimed(ctx) {}` 빈 함수와 `router.register('timed','timed')`, 빈 `<section id="timed" hidden>`만 두고, 호출되는지 테스트).
- `startTheme('timed', themeId)`(홈 추천 등에서 테마로 바로 올 때)도 질문 고르기 화면으로 간다(바로 시작하지 않는다).
- mypage `MODE_NAMES.timed = '1분 말하기'`; `historySub`: timed면 `${rounds}회 · 고친 곳 ${wrong}` (graded 0이면 `${rounds}회`). home.js `MODE_NAMES`에도 timed.

- [ ] 테스트(node): 홈 카드 클릭 → openPick('timed') 모드 라벨; 테마 선택 → 질문 요청 URL(language, theme_id), 로딩 문구, 3개 렌더, 선택/직접 입력 → 시작 버튼 활성, 시작 → POST 본문(mode timed, topic) → openTimed 호출 인자; 질문 실패 → 다시 시도로 재요청; 다른 테마로 바꾸면 늦게 온 이전 응답이 그려지지 않음(토큰 가드); 기록 행 라벨·부제. CSS 테스트: ≤480px에서 5번째 모드 카드 `grid-column: 1 / -1`.
- [ ] 부숴 보기 3개 이상(토큰 가드, 시작 비활성, 라벨) → 빨강 → 복구.
- [ ] 커밋 — `feat: 1분 말하기 on home and in the picker -- a theme, then three questions to choose from`

---

### Task 6: 화면 — `#timed`: 준비, 60초 녹음, 채점, 결과, 한 번 더

**Files:** Create `static/js/timed.js`, `static/js/timed.test.js`; Modify `static/index.html`(`#timed`), `static/js/main.js`(연결·떠날 때 정리), `static/css/components.css`, `static/js/dom-shim.js`(필요한 가짜 MediaRecorder/getUserMedia/SpeechRecognition이 없으면 추가 — 기존 테스트가 쓰는 가짜를 먼저 찾아 재사용)

**Produces:**
- `export function openTimed({ sessionId, topic, meaning, starter })` — 라우터 `timed` 표시, 단계 `prep`.
- 순수 단계 함수 `export function nextStage(stage, event)` — 표:

| stage | event | next |
|---|---|---|
| prep | `START` / `PREP_DONE` | rec |
| rec | `STOP` / `TIME_UP` | upload |
| upload | `UPLOADED` | grading |
| upload | `TRANSCRIBE_FAILED` | retry-transcribe |
| retry-transcribe | `RETRY` | upload |
| grading | `GRADED` | result |
| result | `AGAIN` | prep |
| * | `LEAVE` | idle |
그 밖의 조합은 stage 그대로.

- 화면 구성(`#timed` 안 한 카드 `.timed-card`, 자리 고정): 머리 = 주제(`topic`)·뜻·힌트(항상 보임). 몸 = 단계별 슬롯 하나(같은 min-height, opacity 페이드):
  - prep: 큰 숫자 10→0 카운트다운 + `바로 시작`. 0이 되면 자동 START.
  - rec: 큰 타이머 `0:42`(남은 시간, 60→0), 빨간 점, 실시간 인식 줄(마지막 두 줄만, 높이 고정), `다 말했어요`. 60초에 TIME_UP. 녹음은 자체 `MediaRecorder`(getUserMedia 한 번, 끝나면 트랙 정지), 인식은 자체 `SpeechRecognition`(continuous, interimResults; Chrome이 조용하면 끊으므로 rec 동안 onend에서 다시 start). 기존 `audio.js`의 턴 인식 핸들러를 건드리지 않는다. 시작 전에 `stopPlayback()`.
  - upload: `받아쓰는 중이에요` + 점 애니메이션.
  - retry-transcribe: `받아쓰기를 하지 못했어요` + `받아쓰기 다시 시도`(→ `/rounds/{n}/transcribe`).
  - grading: 문장 목록을 먼저 그리고(내 말만), `교정하는 중이에요 · i/N문장`, 문장마다 `/grade/{i}`를 **차례로** 호출하며 각 줄 아래에 결과를 채움(`고친 문장` + 설명, 맞으면 `✓ 좋아요`, 실패면 `교정하지 못했어요` + 그 줄 `다시 시도`). 다 끝나면 `/native` 호출(`원어민 답을 만드는 중이에요`) → GRADED. native 실패해도 GRADED(그 자리만 `원어민 답을 만들지 못했어요` + 다시 시도).
  - result: 수치 줄 `단어 87 · 분당 87 · 긴 멈춤 5 · 고친 곳 4`(ja는 `글자`), 2회차부터는 1회차와 비교 `단어 87 → 112` 형식(좋아지면 강조 색 — 단어·분당은 늘면, 긴 멈춤·고친 곳은 줄면). 문장 목록(내 말 / 고친 문장 / 설명, 취소선 없음), `원어민이라면`(▶ 듣기 — 기존 `play(key)`; 서버가 음성 key를 안 주면 `speakInBrowser` fallback — Task 3 native 응답에 `audio_key` 추가가 필요하면 이 태스크에서 서버에 `_speak(native, language)` 한 줄 추가하고 테스트), `▶ 내 녹음`(방금 녹음 blob을 objectURL로), 버튼 `같은 주제로 다시 1분`(AGAIN) / `끝내기`(→ `/end` → 기존 `renderReport` 경로로 리포트 화면; Task 7이 timed 리포트를 그린다).
  - 일본어: 고친 문장·원어민 답에 기존 `reading.annotate` 적용(새 span에 — 늦은 응답이 다른 요소를 덮지 않게).
- 마이크 권한 거부/`MediaRecorder` 없음: prep에서 `마이크를 쓸 수 없어요 — 브라우저 설정에서 마이크를 허용해 주세요` 안내, 시작 버튼 비활성.
- 떠나기(홈·마이페이지·헤더 버튼): rec 중이면 녹음·인식 중단, 업로드 안 함(그 회차 버림), 타이머 정리, LEAVE. 끝난 회차는 서버에 남는다. `main.js`의 화면 전환 공통 정리 자리에 `leaveTimed()` 연결.
- 모든 비동기 응답은 `(sessionId, round, attempt)` 토큰으로 가드 — 떠난 뒤/다음 회차의 늦은 응답은 그리지 않는다.

- [ ] 테스트(node, 가짜 시계 `mock.timers` 또는 주입한 `now`/`setInterval`):
  - `nextStage` 표 전부(허용·불허 조합).
  - prep 10초 후 자동 녹음 시작, `바로 시작`은 즉시.
  - rec: 60초에 자동 정지 → 업로드 요청(FormData에 file·seconds≈60), `다 말했어요`는 즉시 정지·seconds가 경과 시간.
  - 업로드 503 → retry-transcribe, `다시 시도` → `/transcribe` 호출.
  - grading: 문장 3개 → `/grade/0`, `/grade/1`, `/grade/2` 순서(동시에 아님), 진행 문구 `1/3`→`3/3`, 한 문장 실패 → 그 줄만 실패+재시도, 이어서 `/native`.
  - result: 1회차 수치, AGAIN 후 2회차 결과에 `→` 비교와 강조 방향.
  - 떠나기: rec 중 떠나면 업로드 없음, 인식·녹음 정지 호출, 늦은 grade 응답이 그려지지 않음.
  - 마이크 없음 → 안내·시작 비활성.
  - 내 말 요소에 `said` 클래스·`<s>` 없음.
  - CSS 테스트: `.timed-card` 슬롯 min-height, 페이드에 transform 없음, reduced-motion.
- [ ] 부숴 보기 5개 이상 → 빨강 → 복구.
- [ ] 커밋 — `feat: 1분 말하기 on screen -- ten seconds to think, a minute to speak, graded line by line, then once more`

---

### Task 7: 화면 — timed 리포트

**Files:** Modify `static/js/session.js`(`renderReport` 분기 → `renderTimedReport`), `static/css/components.css`; Test `static/js/session.test.js`

- `renderReport(data)`에서 `data.kind === 'timed'`면 `renderTimedReport(data)`: 헤드라인 `1분 말하기 ${rounds.length}회`, 부제 = topic. 회차 표(회차 · 단어 · 분당 · 긴 멈춤 · 고친 곳), 1회차 대비 변화 강조(Task 6과 같은 방향 규칙 — 공용 함수로 `timed.js`에서 `export function compareRounds(first, cur)`를 내보내 둘 다 쓴다). 1회차 문장 목록(내 말 / 고친 문장 / 설명), 마지막 회차의 `원어민이라면`. 녹음은 없다(세션 끝에 지움). 회차 0개면 `말한 기록이 없어요`.
- 마이페이지 기록 탭에서 연 리포트도 같은 경로(`openReport`가 `renderReport`를 부른다 — 확인).
- [ ] 테스트: 2회차 데이터 → 표 2줄, 강조 방향, 문장 목록, native; 회차 0; 내 말 취소선 없음.
- [ ] 부숴 보기 2개 → 빨강 → 복구.
- [ ] 커밋 — `feat: the 1분 말하기 report -- every round side by side, the first one's sentences, the native answer`

---

## 컨트롤러 마무리

1. 실제 모델: `tests/test_timed_quality.py -m engine`(질문), native 몇 개(한국어 누출·길이·수준).
2. 실제 Whisper: TTS로 만든 60초 en/ja 말(문장 사이 1초, 중간에 4초 무음 두 번)을 `/timed/rounds`에 올려 문장 분리·긴 멈춤 2가 나오는지.
3. 8010 실제 크롬: 전 흐름(마이크 없이는 녹음 불가 → 모듈 함수로 가짜 blob 주입), 단계 전환 높이, 폰 폭, 다크.
4. 본 DB 백업 → main 머지 → 8000 재시작(v9) → 사용자 실제 마이크 사용 부탁.
