# 레벨 테스트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 약 7분 레벨 테스트(따라 말하기 12문장 + 답하기 2개 × 45초) → CEFR(하위/상위) + IELTS·TOEFL 말하기 예상(영어) / JF 스탠다드(일본어), 결과가 앱 레벨의 기준이 된다.

**Architecture:** 순수 채점·환산은 `app/leveltest.py`(표를 테스트로 못박음), 문항은 `data/level_test.json`. 서버는 v10 `level_tests` 테이블과 `/api/level-test` 라우트(녹음은 저장하지 않고 받아쓰기 후 버림). `db.stable_level`이 최근 끝난 테스트를 먼저 본다 — 모든 난이도 사용처가 이 함수뿐이라 앱 전체가 따라온다. 화면은 `#leveltest` + `static/js/leveltest.js`, 녹음은 새 leaf 모듈 `static/js/recorder.js`(timed.js는 건드리지 않는다).

**Tech Stack:** FastAPI + SQLite, faster-whisper(`app/stt.py`), Ollama qwen2.5:14b, vanilla JS ES modules, node:test + dom-shim, pytest.

**Spec:** `docs/superpowers/specs/2026-09-19-monologue-level-test-design.md`

## Global Constraints

- 기준 main `75a81f4`(스키마 v9). 이 계획이 v10을 더한다. 워크트리 `C:/git/Monologue-wt/leveltest`, 브랜치 `leveltest`.
- 채점 컷(48점): A1 0–9 · A2 10–19 · B1 20–29 · B2 30–38 · C1 39–44 · C2 45–48. 문장 점수 r=similarity: 4(r≥0.95)·3(≥0.8)·2(≥0.6)·1(≥0.3)·0.
- 환산 표(IELTS/TOEFL/옛 TOEFL/JF/앱 레벨)는 스펙 "환산" 절 그대로. 결과에는 항상 `말하기만 본 추정이에요 · 공식 점수가 아니에요`.
- 테스트는 연습 기록이 아니다: messages·복습·정확도·약점에 쓰지 않는다. 녹음은 서버에 남기지 않는다.
- 한국어 평은 `api._is_korean_meaning`으로 검사. few-shot은 합성 문장(실제 학습자 문장 금지).
- 화면: 크기 고정(자리 예약, opacity 페이드, **transform 금지**), 오래 걸리면 문구, 학습자 말 취소선 없음(`.said`/`.fix-row` 금지).
- dom-shim: selector 엔진 없음, `closest()` null, `dataset` 비어 있음, **`children`이 Array**(브라우저는 HTMLCollection — 운영 코드에서 `.children.filter/map/...` 금지, `Array.from` 사용). 모델 글자는 textContent만.
- 이 작업 트리는 core.autocrlf일 수 있다 — CSS를 읽는 테스트는 `\r\n`을 `\n`으로 정규화할 것.
- pytest: `cd <worktree> && PYTHONIOENCODING=utf-8 PYTHONUTF8=1 C:/git/Monologue/venv/Scripts/python.exe -m pytest -m "not engine" -q -p no:cacheprovider`(워크트리에선 kokoro 1개 실패 정상). node: `node --test --test-force-exit static/js/*.test.js`. engine 테스트는 실행 금지(컨트롤러 몫).
- 새 테스트마다 구현을 부숴 **그 테스트 자신의 단언으로** 빨개지는지 확인하고 보고서에 적는다. 브라우저로 보지 않았으면 봤다고 쓰지 않는다.
- 커밋: 소문자 `feat:`/`fix:` 문장 + 끝줄 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. 커밋 전 `git branch --show-current`가 `leveltest`.

---

### Task 1: 채점·환산 순수 함수와 문항

**Files:** Create `app/leveltest.py`, `data/level_test.json`, `tests/test_leveltest.py`

**Produces:**
- `leveltest.load_bank(language) -> {"items": [{"i","cefr","text"}]*12, "questions": [{"q","text","meaning"}]*2}` (lru_cache로 파일 1회 읽기)
- `leveltest.item_score(heard, target, language) -> int` 0–4 (`text_match.similarity` 사용)
- `leveltest.cefr_from_ei(score) -> (cefr, step)` step ∈ `"하위"|"상위"`
- `leveltest.answers_level(cefrs: list[str]) -> str|None`
- `leveltest.apply_boundary(score, cefr, step, answers_cefr) -> (cefr, step)`
- `leveltest.conversions(cefr, step, language) -> {"ielts": str|None, "toefl": {"band": str, "old": str}|None, "jf": str|None, "note": str}`
- `leveltest.app_level(cefr) -> "beginner"|"intermediate"|"advanced"`
- `leveltest.by_level(scores: list[int], bank_items) -> {"A1": [got, max], ...}` (max = 4×문항 수)

**문항(`data/level_test.json`, 정확히):**

```json
{
  "en": {
    "items": [
      {"i": 0, "cefr": "A1", "text": "I drink coffee every morning."},
      {"i": 1, "cefr": "A1", "text": "My sister has a small dog."},
      {"i": 2, "cefr": "A2", "text": "We went to the beach last summer."},
      {"i": 3, "cefr": "A2", "text": "Could you tell me where the station is?"},
      {"i": 4, "cefr": "B1", "text": "If it rains tomorrow, we'll have to cancel the picnic."},
      {"i": 5, "cefr": "B1", "text": "I've been learning English for about three years now."},
      {"i": 6, "cefr": "B1", "text": "The movie was much better than I had expected it to be."},
      {"i": 7, "cefr": "B2", "text": "Although the restaurant was crowded, the service was surprisingly quick."},
      {"i": 8, "cefr": "B2", "text": "She would have called you if she had known you were in town."},
      {"i": 9, "cefr": "B2", "text": "It's not the price that bothers me, but the fact that it broke so quickly."},
      {"i": 10, "cefr": "C1", "text": "Had I realised how demanding the job would be, I might have thought twice before accepting it."},
      {"i": 11, "cefr": "C1", "text": "The committee's decision, however controversial it may seem, reflects a careful weighing of long-term costs."}
    ],
    "questions": [
      {"q": 0, "text": "Tell me about how you usually spend your weekends.", "meaning": "주말을 보통 어떻게 보내는지 말해 주세요."},
      {"q": 1, "text": "What is one thing you would change about your city, and why?", "meaning": "사는 도시에서 하나를 바꾼다면 무엇을, 왜 바꾸고 싶어요?"}
    ]
  },
  "ja": {
    "items": [
      {"i": 0, "cefr": "A1", "text": "毎朝コーヒーを飲みます。"},
      {"i": 1, "cefr": "A1", "text": "私の姉は小さい犬を飼っています。"},
      {"i": 2, "cefr": "A2", "text": "去年の夏、家族と海に行きました。"},
      {"i": 3, "cefr": "A2", "text": "駅はどこにあるか教えてくれませんか。"},
      {"i": 4, "cefr": "B1", "text": "もし明日雨が降ったら、ピクニックは中止になります。"},
      {"i": 5, "cefr": "B1", "text": "日本語を勉強し始めてから、もう三年になります。"},
      {"i": 6, "cefr": "B1", "text": "思っていたより、ずっと面白い映画でした。"},
      {"i": 7, "cefr": "B2", "text": "レストランは混んでいたのに、料理が出てくるのは意外と早かった。"},
      {"i": 8, "cefr": "B2", "text": "値段が高いことより、すぐに壊れてしまったことが気になります。"},
      {"i": 9, "cefr": "B2", "text": "町にいると知っていたら、彼女はきっとあなたに連絡したでしょう。"},
      {"i": 10, "cefr": "C1", "text": "仕事がこれほど大変だと分かっていたら、引き受ける前にもう少し考えたかもしれない。"},
      {"i": 11, "cefr": "C1", "text": "委員会の決定は、一見議論を呼びそうに見えるが、長期的な費用を慎重に検討した結果だと言える。"}
    ],
    "questions": [
      {"q": 0, "text": "普段の週末はどのように過ごしていますか。", "meaning": "주말을 보통 어떻게 보내는지 말해 주세요."},
      {"q": 1, "text": "あなたの町で一つ変えたいことは何ですか。それはなぜですか。", "meaning": "사는 동네에서 하나를 바꾼다면 무엇을, 왜 바꾸고 싶어요?"}
    ]
  }
}
```

**leveltest.py(정확히):**

```python
"""레벨 테스트의 채점과 환산. 모델도 DB도 부르지 않는다 -- 표를 테스트가 못박는다.
docs/superpowers/specs/2026-09-19-monologue-level-test-design.md"""
import functools
import json

from app import config, text_match

CEFR = ("A1", "A2", "B1", "B2", "C1", "C2")
# 48점 만점의 하한. 앱이 정한 컷이다(검증된 시험이 아님) -- 화면이 그렇게 말한다.
_CUTS = {"A1": 0, "A2": 10, "B1": 20, "B2": 30, "C1": 39, "C2": 45}
_TOP = {"A1": 9, "A2": 19, "B1": 29, "B2": 38, "C1": 44, "C2": 48}
_BOUNDARY = 2
NOTE = "말하기만 본 추정이에요 · 공식 점수가 아니에요"

# ielts.org / British Council: B1 4.0–5.0, B2 5.5–6.5, C1 7.0–8.0, C2 8.5–9.0; B1 아래는 대응 없음.
_IELTS = {("B1", "하위"): "4.0–4.5", ("B1", "상위"): "4.5–5.0", ("B2", "하위"): "5.5–6.0", ("B2", "상위"): "6.0–6.5",
          ("C1", "하위"): "7.0–7.5", ("C1", "상위"): "7.5–8.0", ("C2", "하위"): "8.5–9.0", ("C2", "상위"): "8.5–9.0"}
# ets.org TOEFL iBT score scale update (2026-01): 1–6 band per CEFR, and the old 0–30 speaking range per band.
_TOEFL_BAND = {("A1", "하위"): "1.0", ("A1", "상위"): "1.5", ("A2", "하위"): "2.0", ("A2", "상위"): "2.5",
               ("B1", "하위"): "3.0", ("B1", "상위"): "3.5", ("B2", "하위"): "4.0", ("B2", "상위"): "4.5",
               ("C1", "하위"): "5.0", ("C1", "상위"): "5.5", ("C2", "하위"): "6.0", ("C2", "상위"): "6.0"}
_TOEFL_OLD = {"1.0": "0–4", "1.5": "5–9", "2.0": "10–12", "2.5": "13–15", "3.0": "16–17", "3.5": "18–19",
              "4.0": "20–22", "4.5": "23–24", "5.0": "25–26", "5.5": "27", "6.0": "28–30"}
_APP = {"A1": "beginner", "A2": "beginner", "B1": "intermediate", "B2": "intermediate",
        "C1": "advanced", "C2": "advanced"}


@functools.lru_cache(maxsize=None)
def _bank() -> dict:
    return json.loads((config.DATA_DIR / "level_test.json").read_text(encoding="utf-8"))


def load_bank(language) -> dict:
    return _bank()[language]


def item_score(heard, target, language) -> int:
    r = text_match.similarity(heard or "", target, language)
    for points, floor in ((4, 0.95), (3, 0.8), (2, 0.6), (1, 0.3)):
        if r >= floor:
            return points
    return 0


def cefr_from_ei(score) -> tuple[str, str]:
    level = max(c for c in CEFR if score >= _CUTS[c])  # CEFR is ordered, and so are its strings
    low, high = _CUTS[level], _TOP[level]
    return level, ("하위" if score - low < (high - low + 1) / 2 else "상위")


def answers_level(cefrs) -> str | None:
    ranks = [CEFR.index(c) for c in cefrs if c in CEFR]
    if not ranks:
        return None
    return CEFR[sum(ranks) // len(ranks)]


def apply_boundary(score, cefr, step, answers_cefr) -> tuple[str, str]:
    if answers_cefr not in CEFR:
        return cefr, step
    k, a = CEFR.index(cefr), CEFR.index(answers_cefr)
    if k + 1 < len(CEFR) and _CUTS[CEFR[k + 1]] - score <= _BOUNDARY and a > k:
        return CEFR[k + 1], "하위"
    if k > 0 and score - _CUTS[cefr] < _BOUNDARY and a < k:
        return CEFR[k - 1], "상위"
    return cefr, step


def conversions(cefr, step, language) -> dict:
    if language == "ja":
        return {"ielts": None, "toefl": None, "jf": f"JF 스탠다드 {cefr}",
                "note": NOTE + " · JLPT에는 말하기 시험이 없어 환산하지 않아요"}
    band = _TOEFL_BAND[(cefr, step)]
    return {"ielts": _IELTS.get((cefr, step), "4.0 미만"), "toefl": {"band": band, "old": _TOEFL_OLD[band]},
            "jf": None, "note": NOTE}


def app_level(cefr) -> str:
    return _APP[cefr]


def by_level(scores, items) -> dict:
    out: dict = {}
    for item, s in zip(items, scores):
        got, top = out.get(item["cefr"], [0, 0])
        out[item["cefr"]] = [got + s, top + 4]
    return out
```

(`max(c for c in CEFR if ...)`는 문자열 최대 = 순서 최대가 "A1"<"A2"<"B1"…로 성립한다. `config.DATA_DIR`이 있는지 확인; `library.py`가 이미 쓴다.)

- [ ] **Step 1: 실패하는 테스트** — `tests/test_leveltest.py`:

```python
import pytest

from app import leveltest


def test_bank_has_twelve_graded_items_and_two_questions_per_language():
    for lang in ("en", "ja"):
        bank = leveltest.load_bank(lang)
        assert [it["cefr"] for it in bank["items"]] == ["A1", "A1", "A2", "A2", "B1", "B1", "B1", "B2", "B2", "B2", "C1", "C1"]
        assert [it["i"] for it in bank["items"]] == list(range(12))
        assert [q["q"] for q in bank["questions"]] == [0, 1]
        assert all(q["meaning"] for q in bank["questions"])


@pytest.mark.parametrize("heard,points", [
    ("I drink coffee every morning.", 4),
    ("i drink coffee every morning", 4),        # case/punctuation ignored
    ("I drink coffee every day.", 3),
    ("I coffee morning", 2),
    ("coffee", 1),
    ("", 0),
    (None, 0),
])
def test_item_score_english(heard, points):
    assert leveltest.item_score(heard, "I drink coffee every morning.", "en") == points


def test_item_score_japanese_by_characters():
    assert leveltest.item_score("毎朝コーヒーを飲みます", "毎朝コーヒーを飲みます。", "ja") == 4


@pytest.mark.parametrize("score,expected", [
    (0, ("A1", "하위")), (4, ("A1", "하위")), (5, ("A1", "상위")), (9, ("A1", "상위")),
    (10, ("A2", "하위")), (19, ("A2", "상위")), (20, ("B1", "하위")), (24, ("B1", "하위")), (25, ("B1", "상위")),
    (29, ("B1", "상위")), (30, ("B2", "하위")), (38, ("B2", "상위")), (39, ("C1", "하위")), (44, ("C1", "상위")),
    (45, ("C2", "하위")), (48, ("C2", "상위")),
])
def test_cefr_cuts(score, expected):
    assert leveltest.cefr_from_ei(score) == expected


def test_answers_level_is_the_floor_of_the_mean():
    assert leveltest.answers_level(["B1", "B2"]) == "B1"
    assert leveltest.answers_level(["B2", "B2"]) == "B2"
    assert leveltest.answers_level(["C1"]) == "C1"
    assert leveltest.answers_level([]) is None
    assert leveltest.answers_level(["??"]) is None


@pytest.mark.parametrize("score,answers,expected", [
    (28, "B2", ("B2", "하위")),     # 2 below the B2 cut, answers say B2 -> up one
    (29, "C1", ("B2", "하위")),     # up one level only
    (27, "B2", ("B1", "상위")),     # 3 below the cut -> no move
    (28, "B1", ("B1", "상위")),     # answers agree -> no move
    (20, "A2", ("A2", "상위")),     # just above the B1 cut, answers lower -> down one
    (21, "A1", ("A2", "상위")),
    (22, "A2", ("B1", "하위")),     # 2 above the cut -> no move
    (28, None, ("B1", "상위")),
    (46, "C2", ("C2", "하위")),     # nothing above C2
    (1, "A1", ("A1", "하위")),      # nothing below A1
])
def test_boundary_moves_one_level_only_near_a_cut(score, answers, expected):
    cefr, step = leveltest.cefr_from_ei(score)
    assert leveltest.apply_boundary(score, cefr, step, answers) == expected


def test_english_conversions_follow_the_official_tables():
    c = leveltest.conversions("B1", "상위", "en")
    assert c["ielts"] == "4.5–5.0" and c["toefl"] == {"band": "3.5", "old": "18–19"} and c["jf"] is None
    assert leveltest.conversions("A2", "하위", "en")["ielts"] == "4.0 미만"
    assert leveltest.conversions("A2", "하위", "en")["toefl"] == {"band": "2.0", "old": "10–12"}
    assert leveltest.conversions("C2", "상위", "en")["toefl"] == {"band": "6.0", "old": "28–30"}
    assert "공식 점수가 아니에요" in c["note"]


def test_japanese_has_jf_and_no_jlpt_conversion():
    c = leveltest.conversions("B2", "하위", "ja")
    assert c["jf"] == "JF 스탠다드 B2" and c["ielts"] is None and c["toefl"] is None and "JLPT" in c["note"]


def test_app_level_and_by_level():
    assert [leveltest.app_level(c) for c in leveltest.CEFR] == ["beginner", "beginner", "intermediate",
                                                                "intermediate", "advanced", "advanced"]
    items = leveltest.load_bank("en")["items"]
    got = leveltest.by_level([4, 3, 4, 2, 3, 3, 1, 2, 0, 1, 0, 0], items)
    assert got == {"A1": [7, 8], "A2": [6, 8], "B1": [7, 12], "B2": [3, 12], "C1": [0, 8]}
```

`item_score`의 기대값(3·2·1)은 `text_match.similarity`의 실제 계산으로 확인하고, 파라미터가 규칙과 어긋나면 **입력 문장**을 바꿔 규칙(0.95/0.8/0.6/0.3)대로 각 점수가 나오게 한다(규칙은 바꾸지 않는다).

- [ ] **Step 2~4:** 실패 확인 → 구현 → 통과(대상 + 전체).
- [ ] **Step 5: 부숴 보기** — `_BOUNDARY` 2→1 → 빨강, `_IELTS` B1 상위 값 바꾸기 → 빨강, `item_score` 0.95→0.9 → 빨강(경계 입력이 있어야 함; 없으면 추가).
- [ ] **Step 6: 커밋** — `feat: level test scoring -- twelve sentences to repeat, CEFR cuts, and the official IELTS and TOEFL tables`

---

### Task 2: 서버 — v10, 라우트, 답하기 판정, 앱 레벨

**Files:** Modify `app/db.py`, `app/api.py`, `app/prompts.py`; Create `tests/test_api_leveltest.py`, `tests/test_leveltest_quality.py`(engine)

**Consumes:** Task 1 전부, `stt.transcribe`(문장), `stt.transcribe_segments` + `timed.round_stats`(답하기 통계), `_speak(text, language)`(문항 음성 key), `_is_korean_meaning`, `_first_line`, `llm.chat_json`, `_MAX_TRANSCRIBE_BYTES`.

**Produces:**
- v10(MIGRATIONS 끝):

```python
    # v9 -> v10: 레벨 테스트 (docs/superpowers/specs/2026-09-19-monologue-level-
    # test-design.md). A finished test's app_level is the level the whole app
    # teaches at (db.stable_level reads it first); nothing here is practice.
    ["""
    CREATE TABLE IF NOT EXISTS level_tests (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        language     TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        items_json   TEXT NOT NULL DEFAULT '{}',
        answers_json TEXT NOT NULL DEFAULT '{}',
        result_json  TEXT,
        app_level    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_level_tests_lang ON level_tests(language, finished_at);
    """],
```

- db: `create_level_test(language) -> id`, `get_level_test(id) -> dict|None`(items/answers/result 파싱), `set_level_item(id, i, heard, score)`, `set_level_answer(id, q, data: dict)`, `finish_level_test(id, result: dict, app_level)`, `latest_level_test(language) -> dict|None`(finished만, finished_at DESC, id DESC).
- `db.stable_level(language, ...)`: 맨 앞에서 `t = latest_level_test(language)`; 있으면 `t["app_level"]` 반환. docstring에 한 문단 추가(테스트가 기준인 이유 — 사용자 결정).
- 라우트(모두 `/api` 아래):
  - `POST /level-test` `{language}` → `{test_id, items:[{i, audio_key}], questions:[{q, text, meaning}]}` (원문 없음; audio_key = `_speak(item.text, language)`, None 허용).
  - `POST /level-test/{id}/items/{i}` multipart `file` → `stt.transcribe`(파일 저장 안 함) → `item_score` → `set_level_item` → `{i, done: true}`. SttUnavailable/기타 예외 → 503 `받아쓰기를 할 수 없어요`. i 범위 밖 404, 끝난 테스트 409, 없는 테스트 404. 크기 상한 `_MAX_TRANSCRIBE_BYTES`.
  - `POST /level-test/{id}/answers/{q}` multipart `file`, `seconds`(finite, 0<s≤60 아니면 422) → `transcribe_segments` → `timed.round_stats` → `set_level_answer(q, {text: " ".join(sentences), seconds, words, wpm, long_pauses})` → `{q, done: true}`. 실패 503.
  - `POST /level-test/{id}/finish` → 12문장 다 없으면 400 `아직 따라 말하기가 끝나지 않았어요`; 끝났으면 저장된 결과. 아니면: 답하기 판정(아래, 답이 하나도 없으면 호출 안 함) → `score=sum` → `cefr_from_ei` → `apply_boundary(score, …, answers_level(판정들))` → `conversions` → 결과 dict(스펙 "결과 모양") → `finish_level_test(result, app_level(cefr))` → 결과.
  - `GET /level-test/latest?language=` → `{"result": 결과 | None}`.
- 답하기 판정: `prompts.LEVEL_ANSWERS_SYSTEM`(한국어 지시: 두 답을 각각 CEFR로, 한국어 평 한 줄(60자 이내, 잘한 점 하나 + 부족한 점 하나); 받아쓰기라 오탈자 있음; 너무 짧거나 비어 있으면 A1), `level_answers_schema()` = `{answers:[{q:int, cefr: enum CEFR, comment: str}]}`, `build_level_answers_messages(language, qa)` — qa = `[{q, question, text, wpm, long_pauses}]`, few-shot 1개(합성). 검사: cefr enum, comment `_is_korean_meaning`(아니면 comment ""로, cefr는 유지), q 매칭. 모델 실패 → 판정 없이(answers_cefr None) 계속.
- `/stats/mypage`의 `level`에 `test`: `latest_level_test`의 결과 요약 `{cefr, step, ielts, toefl, jf, finished_at}` 또는 None. 테스트가 있으면 `value`도 그 app_level(표본 부족 게이트 무시).

- [ ] **Step 1: 실패하는 테스트** — `tests/test_api_leveltest.py`(stt·llm·tts 목; `tests/test_api_timed.py` fixture 모양):
  - 시작 → items 12개에 text 없음·audio_key, questions 2개.
  - 문장 12개 올리기(stt 목이 원문 그대로) → finish → cefr C2·step·ei.score 48·by_level·conversions; app_level advanced; `db.stable_level("en") == "advanced"`(세션 판정과 무관).
  - 문장 11개만 → finish 400. 끝난 뒤 문장 올리기 409. finish 두 번 → 같은 결과, 모델 추가 호출 없음.
  - 받아쓰기 불가 → 503, 같은 i 다시 올리면 덮어씀.
  - 답하기: seconds nan/0/61 → 422; 정상 → 저장. 판정 목이 B2,B2이고 문장 점수 합 28 → B2 하위(경계 규칙). 판정 모델 예외 → EI만으로 결과.
  - 한국어 아닌 comment → "" 저장, cefr 유지.
  - 테스트는 messages·review_queue에 행을 만들지 않는다. `mypage` accuracy·tags 변화 없음.
  - `/stats/mypage` level.test 채워짐, value = 테스트 app_level. latest는 끝난 것만(끝나지 않은 새 테스트가 있어도 이전 결과).
  - v9→v10 마이그레이션(기존 패턴: 테이블 drop, user_version 9, init_db).
- [ ] **Step 2~4.** **Step 5: 부숴 보기** — stable_level 테스트 우선 제거 → 빨강; 경계 규칙 호출 제거 → 빨강; finish 멱등 제거 → 빨강; messages 오염(테스트가 add_message 호출) 가정 테스트 → 부숴서 확인.
- [ ] **Step 6: 품질 파일** `tests/test_leveltest_quality.py`(engine): 합성 답 3종(짧은 한 단어, 평범한 B1 답, 풍부한 C1 답)으로 판정 표 출력 + 한국어 평 단언. 실행 금지.
- [ ] **Step 7: 커밋** — `feat: level test on the server -- twelve repeats and two answers make a CEFR level the whole app teaches at (v10)`

---

### Task 3: 화면 — 녹음 모듈과 테스트 진행

**Files:** Create `static/js/recorder.js`, `static/js/recorder.test.js`, `static/js/leveltest.js`, `static/js/leveltest.test.js`; Modify `static/index.html`(`<section id="leveltest" hidden>`), `static/js/main.js`(router `leveltest`, 떠날 때 정리), `static/css/components.css`

**Produces:**
- `recorder.js`(leaf, app 모듈 import 없음): `export async function openMic() -> {stream}|null`(getUserMedia 실패·모든 오디오 트랙 ended → null), `export function startRecording(mic) -> handle`(MediaRecorder 생성·start를 try로, 실패 null), `export function stopRecording(handle) -> Promise<Blob|null>`(stop 이벤트 뒤 조각 합침; 비었으면 null), `export function closeMic(mic)`(트랙 정지). timed.js는 건드리지 않는다.
- `leveltest.js`: `export function openLevelTest()`, `export function leaveLevelTest()`, 순수 `export function nextStep(state, event)`(intro→item(i)→…→answer(q)→finishing→result, LEAVE→idle; 표를 테스트).
  - intro: `약 7분 · 조용한 곳에서 · 문장은 한 번만 들려요` + `시작`(마이크 없으면 안내·비활성).
  - item: `따라 말하기 i+1/12`, 오디오 1회 재생(`audio.js play(key)`, key 없으면 `speakInBrowser`; 재생 중 버튼 없음), 끝나면 자동 녹음(빨간 점, 남은 시간 막대, 최대 `max(6, round(재생길이×2+3))`초), `다 말했어요`. 멈추면 blob을 **뒤에서** 올림(`/items/{i}`), 다음 문장으로 바로. 업로드 실패는 1회 자동 재시도, 그래도 실패면 `pending`에 남겨 finishing 전에 다시(끝내 실패하면 `받아쓰기를 하지 못했어요` + 다시 시도).
  - answer: 질문 + 뜻, 5초 준비 숫자, 45초 타이머, `다 말했어요` → `/answers/{q}`(seconds 포함).
  - finishing: 남은 업로드를 다 기다리고 → `/finish` → `결과를 계산하는 중이에요` → result 단계(Task 4가 그린다; 여기서는 `renderLevelResult(result)`를 `leveltest.js`의 export 빈 함수로 두고 호출되는지 테스트).
  - 모든 비동기는 `(testId, attempt)` 토큰 가드. 떠나면 녹음·타이머·재생 정리, 테스트 버림.
  - 카드 슬롯 min-height 고정(단계가 바뀌어도 크기 그대로), opacity 페이드만.
- [ ] 테스트: recorder(openMic 실패·ended 트랙·start throw·빈 blob null), nextStep 표, 문장 재생→자동 녹음→다 말했어요→업로드가 다음 문장을 막지 않음, 업로드 재시도·pending, 12문장 뒤 답하기 2개, finishing이 pending을 기다린 뒤 finish, 떠나기(늦은 응답 무시·정리), 마이크 없음. CSS: 슬롯 min-height, transform 없음, reduced-motion.
- [ ] 부숴 보기 5개 이상 → 그 테스트 자신의 단언으로 빨강 → 복구.
- [ ] 커밋 — `feat: taking the level test -- twelve sentences heard once and said back, then two answers`

---

### Task 4: 화면 — 결과, 홈 카드, 마이페이지 머리줄

**Files:** Modify `static/js/leveltest.js`(`renderLevelResult`), `static/js/home.js`, `static/js/mypage.js`(`renderLevel`), `static/index.html`, `static/css/components.css`, `static/js/main.js`; Tests: `leveltest.test.js`, `home.test.js`, `mypage.test.js`

- 결과(`renderLevelResult(result)`): CEFR 크게(`B1 상위`), 영어: `IELTS 말하기 4.5–5.0 예상` / `TOEFL 말하기 3.5 예상 (옛 점수 18–19)`; 일본어: `JF 스탠다드 B1` + note. 따라 말하기 `27/48` + 난이도별 막대(A1…C1, `got/max`), 답하기 평 2줄(질문 앞머리 + comment; comment 비면 줄 생략), `result.note`, `앱 난이도가 {초급|중급|고급}으로 맞춰졌어요`, `홈으로`. 마이페이지에서 `결과 보기`로 열면 같은 화면(버튼 `← 마이페이지`).
- 홈: `GET /level-test/latest`가 null이면 카드 `레벨 테스트 · 7분이면 내 수준과 IELTS·TOEFL 예상 점수를 알 수 있어요`(일본어는 `JF 스탠다드 레벨`) + `시작` → openLevelTest. 결과가 있으면 카드 없음. 언어 바꾸면 다시 판단.
- 마이페이지 `renderLevel(level)`: `level.test` 있으면 `레벨 B1 상위 · IELTS 말하기 4.5–5.0 예상`(ja `JF 스탠다드 B1`) + 작은 버튼 `결과 보기` `다시 테스트`; 없으면 지금 문구 + `레벨 테스트 (7분)`. 머리줄 한 줄 높이 유지(버튼은 같은 줄, 폰에서 줄바꿈 허용하되 스켈레톤 높이와 같게).
- [ ] 테스트: 결과 en/ja 문구·막대·빈 comment, 홈 카드 있음/없음/언어 전환, 마이페이지 두 경우와 버튼 동작(결과 보기→result 화면, 다시 테스트→openLevelTest). CSS: transform 없음.
- [ ] 부숴 보기 3개 이상 → 빨강 → 복구.
- [ ] 커밋 — `feat: the level test's result -- CEFR with IELTS and TOEFL estimates, a home card, and my page's level line`

---

## 컨트롤러 마무리

1. 실제 Whisper: TTS로 만든 12문장 en/ja를 그대로 → 문장마다 3~4점, 단어를 뺀 녹음 → 점수 하락.
2. 실제 모델: `tests/test_leveltest_quality.py -m engine`.
3. 최종 브랜치 리뷰(opus) → 한 번의 수정 → 재확인.
4. 8010 크롬: 가짜 마이크(호출마다 새 MediaStreamDestination)로 전체 흐름, 결과, 홈 카드, 마이페이지, 폰.
5. 본 DB 백업 → 머지 → 8000 재시작(v10) → 사용자에게 실제 마이크 테스트 부탁.
