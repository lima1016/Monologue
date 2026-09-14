# 원어민 표현 (교정 칩 suggestion + 💡 뭐라고 하지?) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교정 칩의 `이렇게도`를 "이 상황의 원어민 한마디"로 바꾸고, 말하기 전에 대답 후보 2~3개를 받는 `💡 뭐라고 하지?`를 더한다.

**Architecture:** ①은 `FEEDBACK_SYSTEM` 문구와 `fixed` 되풀이 가드만 바꾼다. ②는 `POST /api/sessions/{id}/suggest` 하나 -- 서버가 문맥을 모아 qwen에 JSON으로 묻고, 목표 언어·길이·중복·한국어 뜻을 검증해 통과한 줄만 돌려준다. 성공 결과는 `(session_id, bot_message_id)`로 LRU 캐시. 화면은 새 모듈 `static/js/suggest.js`가 봇 말풍선 뒤에 카드를 붙인다.

**Tech Stack:** FastAPI, Ollama(qwen2.5:14b) via `app/llm.py`, pytest, 브라우저 ES 모듈 + `node --test`(dom-shim).

**Spec:** `docs/superpowers/specs/2026-09-14-monologue-native-suggestions-design.md`

## Global Constraints

- 작업 위치: 워크트리 `C:/git/Monologue-wt/native-suggestions`, 브랜치 `native-suggestions`. **본 저장소 `C:/git/Monologue`의 파일은 건드리지 않는다**(사용자가 그 작업 트리로 8000 서버를 쓰는 중).
- 파이썬: `C:/git/Monologue/venv/Scripts/python.exe` (워크트리에는 venv가 없다). 워크트리 루트에서 실행.
- 기본 스위트: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q` (engine 제외가 기본), node: `node --test --test-force-exit 'static/js/*.test.js'`.
- 기준선(시작 시점 main `823b0eb`): **pytest 394 passed / node 106**. 이보다 줄면 안 된다.
- engine 테스트: `-m engine`. Ollama(11434)는 사용자의 8000 서버와 공유한다. 서버를 띄워야 하면 **8010**만, DB는 복사본.
- 사용자에게 보이는 문구는 한국어. 문구 그대로: 버튼 `💡 뭐라고 하지?`, 카드 제목 `이렇게 말해볼 수 있어요`, 로딩 `생각하는 중...`, 실패 `지금은 추천을 만들 수 없어요`.
- 길이 상한: 영어 **12단어**, 일본어 구두점 제외 **30자**. 추천은 **최대 3줄**, 재시도 **1회**, 온도 **0.7**.
- 추천 캐시 `maxsize=256`, 최근 대화 **6개** 메시지.
- 새 가드마다 **일부러 부숴서 테스트가 빨개지는지** 확인하고, 되돌린 뒤 초록을 확인한다(각 태스크 마지막 단계).
- 커밋 메시지 끝:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9
  ```

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `app/prompts.py` | ① suggestion 정의·문맥 머리말·예시 문구 / ② `SUGGEST_SYSTEM`, `suggest_schema`, `build_suggest_messages` | 1, 2 |
| `app/api.py` | ① `_drop_if_quoted`(일반화) + `fixed` 되풀이 가드 / ② `_valid_replies`, `_generate_suggestions`, `_cached_suggestions`, 라우트 | 1, 3, 4 |
| `tests/test_prompts.py` | 프롬프트 조립 | 1, 2 |
| `tests/test_api_chat.py` | ① 가드 통합 | 1 |
| `tests/test_api_suggest.py` (새) | ② 검증·생성·라우트·캐시 | 3, 4 |
| `tests/test_feedback_suggestion_quality.py` (새, engine) | ① 전후 비교 | 1 |
| `tests/test_suggest_quality.py` (새, engine) | ② 품질 | 4 |
| `static/js/suggest.js` (새) | 버튼 표시, 요청, 카드 그리기 | 5 |
| `static/js/suggest.test.js` (새) | 위 | 5 |
| `static/index.html` | `#btn-suggest` | 5 |
| `static/js/main.js` | 버튼 클릭, 카드 안 뜻·재생 클릭 | 5 |
| `static/js/session.js`, `static/js/home.js` | 세션 시작·이어하기에서 버튼 표시 | 5 |
| `static/css/components.css` | `.suggest-*` | 5 |

---

### Task 1: ① 교정 칩 suggestion을 상황의 원어민 한마디로

**Files:**
- Modify: `app/prompts.py` (`FEEDBACK_SYSTEM`, `FEEDBACK_EXAMPLES`, `_feedback_context`)
- Modify: `app/api.py` (`_drop_self_quoting_suggestion` 주변, `_feedback`의 마지막 return)
- Modify: `tests/test_prompts.py`, `tests/test_api_chat.py`
- Create: `tests/test_feedback_suggestion_quality.py`

**Interfaces:**
- Produces: `api._drop_if_quoted(suggestion, sentence) -> str | None` -- suggestion 속 인용 구간 하나라도 `normalize(sentence)`와 **같으면** None, 아니면 suggestion 그대로. `sentence`가 정규화 후 빈 문자열이면 그대로. 문자열 아닌 suggestion은 그대로. `_drop_self_quoting_suggestion`은 이것을 부르는 얇은 이름으로 남긴다(기존 테스트가 그 이름을 쓴다).

- [ ] **Step 1: engine 전후 비교 테스트를 먼저 쓴다 (바꾸기 전 프롬프트로 잴 것)**

`tests/test_feedback_suggestion_quality.py`:

```python
"""① 교정 칩 suggestion이 상황에 맞는 원어민 한마디인가. `-m engine`에서만 돈다.

바꾸기 전 프롬프트로 한 번, 바꾼 뒤 한 번 돌려 수치를 커밋 메시지에 남긴다.
문턱은 바꾼 뒤 실측보다 낮게 둔다 -- 모델은 샘플링되므로 한 번의 빗나감은 회귀가 아니다.

자동으로 재는 것은 `fixed` 되풀이율뿐이다. "상황에 맞는가"는 자동 판정하지 않는다 --
출력 표본을 -s로 찍어 사람이 읽는다.
"""
import pytest

from app import api, llm, prompts

pytestmark = pytest.mark.engine

# (언어, 학습자 문장, 봇 직전 말, 상황 제목, 목표)
CASES = [
    ("en", "I want window seat", "Do you have a seating preference?", "공항 체크인", "창가 자리를 요청한다"),
    ("en", "I go to Busan yesterday", "So, what did you do over the weekend?", "주말 이야기", "주말에 한 일을 말한다"),
    ("en", "Can I pay card", "That'll be twelve dollars.", "카페 주문", "음료를 주문하고 계산한다"),
    ("en", "I am agree with the plan", "So we move the launch to Friday. Thoughts?", "팀 회의", "일정 변경에 의견을 말한다"),
    ("en", "My room is too cold", "Front desk, how can I help you?", "호텔 프런트", "방 문제를 알린다"),
    ("en", "I'd like a coffee.", "Hi there, what can I get you?", "카페 주문", "음료를 주문한다"),
    ("ja", "窓側の席がほしいです", "お座席のご希望はございますか。", "공항 체크인", "창가 자리를 요청한다"),
    ("ja", "昨日釜山に行きます", "週末は何をしましたか。", "주말 이야기", "주말에 한 일을 말한다"),
    ("ja", "カードで払うできますか", "お会計は千二百円です。", "카페 주문", "계산한다"),
    ("ja", "部屋が寒いです", "フロントでございます。どうなさいましたか。", "호텔 프런트", "방 문제를 알린다"),
    ("ja", "コーヒーをください。", "いらっしゃいませ。ご注文は？", "카페 주문", "음료를 주문한다"),
]


@pytest.fixture(scope="module")
def results():
    out = []
    for lang, text, bot_last, title, goal in CASES:
        fb = llm.chat_json(
            prompts.build_feedback_messages(lang, text, scenario_title=title,
                                            scenario_goal=goal, bot_last=bot_last),
            prompts.feedback_schema(lang),
        )
        out.append((lang, text, bot_last, fb))
    return out


def test_print_samples_for_a_human_to_read(results):
    for lang, text, bot_last, fb in results:
        print(f"\n[{lang}] bot: {bot_last}\n  학생: {text}\n  fixed: {fb.get('fixed')}"
              f"\n  suggestion: {fb.get('suggestion')}")


def test_suggestion_rarely_just_restates_fixed(results):
    """가드(api._drop_if_quoted)를 거치기 전 원본으로 잰다 -- 가드가 지운 뒤를 재면
    프롬프트가 나아졌는지가 아니라 가드가 일했는지를 재게 된다."""
    wrong = [fb for _, _, _, fb in results if fb.get("ok") is False]
    restated = [fb["suggestion"] for fb in wrong
                if isinstance(fb.get("fixed"), str)
                and api._drop_if_quoted(fb.get("suggestion"), fb["fixed"]) is None]
    print(f"\nfixed 되풀이: {len(restated)}/{len(wrong)}")
    assert len(restated) <= 1, restated


def test_suggestion_is_still_korean(results):
    bad = [fb.get("suggestion") for _, _, _, fb in results
           if sum(1 for ch in (fb.get("suggestion") or "") if "가" <= ch <= "힣") < 8]
    assert len(bad) <= 1, bad
```

`api._drop_if_quoted`가 아직 없으므로, 바꾸기 전 수치를 재기 위해 Step 2까지 한 뒤 Step 3에서 돌린다.

- [ ] **Step 2: 가드 함수를 일반화한다 (동작 변화 없음)**

`app/api.py`에서 `_drop_self_quoting_suggestion` 정의를 다음으로 바꾼다(docstring의 설명 문단은 `_drop_if_quoted`로 옮기고 아래처럼 다듬는다):

```python
def _drop_if_quoted(suggestion, sentence: str):
    """Drop `suggestion` when one of its *quoted spans* is equal (not merely
    contains) `sentence` after normalisation -- a suggestion that only quotes
    back a sentence already on screen tells the learner nothing.

    Two callers: a neutralised correction quoting the learner's own words back
    (the model wrote it while it still believed in a fix since discarded), and
    a real correction quoting `fixed` back (the 교정 block already shows that
    sentence). A genuine alternative that merely contains the sentence, like
    "Could I have the card, please?" for "card please", survives.

    Never raises: a non-string suggestion is returned unchanged, and an empty
    normalised sentence matches nothing (an empty quote '' must not count).
    """
    if not isinstance(suggestion, str):
        return suggestion
    target = normalize(sentence)
    if not target:
        return suggestion
    for match in _QUOTED_SPAN.finditer(suggestion):
        span = next(g for g in match.groups() if g is not None)
        if normalize(span) == target:
            return None
    return suggestion


def _drop_self_quoting_suggestion(suggestion, learner_text: str):
    """The neutralised-correction use of _drop_if_quoted -- see there."""
    return _drop_if_quoted(suggestion, learner_text)
```

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q tests/test_api_chat.py`
Expected: 전부 PASS (동작이 같다).

- [ ] **Step 3: 바꾸기 전 수치를 잰다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -m engine -s tests/test_feedback_suggestion_quality.py`
출력의 `fixed 되풀이: a/b`와 표본 11개를 기록해 둔다(보고서에 옮긴다). 실패해도 괜찮다 -- 이것이 기준이다.

- [ ] **Step 4: 실패하는 기본 테스트를 쓴다**

`tests/test_prompts.py` 끝에 추가:

```python
def test_feedback_suggestion_is_defined_as_what_a_native_speaker_would_say_here():
    system = prompts.build_feedback_messages("en", "test")[0]["content"]
    assert "이 상황에서 원어민" in system
    assert "fixed" in system.split("- suggestion:")[1]  # the don't-quote-fixed rule sits in the suggestion bullet


def test_feedback_context_now_lets_suggestion_use_the_scene():
    system = prompts.build_feedback_messages("en", "test", bot_last="Checking in today?")[0]["content"]
    assert "suggestion을 이 상황에 맞추는 데" in system
    assert "답변에 그대로 옮기지 마세요" not in system


def test_no_feedback_example_suggestion_quotes_its_own_fixed():
    """예시가 `fixed`를 되풀이하면 모델은 규칙보다 예시를 따른다."""
    import re
    from app.text_match import normalize
    for language, examples in prompts.FEEDBACK_EXAMPLES.items():
        for ex in examples:
            spans = re.findall(r"'([^']*)'", ex["suggestion"])
            assert spans, (language, ex["learner"])
            assert all(normalize(s) != normalize(ex["fixed"]) for s in spans), (language, ex["learner"])
```

`tests/test_api_chat.py`:
1. `fake_engines`의 `"suggestion": "'I went there.'라고 말하세요.",` → `"suggestion": "'I went over there.'라고도 해요.",`
2. `test_chat_stores_both_turns_with_feedback_on_the_user_turn`의 `assert body["suggestion"] == "'I went there.'라고 말하세요."` → `assert body["suggestion"] == "'I went over there.'라고도 해요."`
3. 파일의 `test_chat_keeps_a_genuinely_alternative_suggestion_on_a_neutralized_turn` 바로 뒤에 추가:

```python
def test_chat_drops_a_suggestion_that_quotes_the_fix_already_shown(client, monkeypatch):
    """교정 블록이 이미 `fixed`를 보여준다. 이렇게도가 같은 문장을 인용하면 정보가 없다."""
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {
        "ok": False, "fixed": "I went there.", "tag": "시제",
        "correction": "'go'는 과거형이 아닙니다.",
        "suggestion": "원어민이라면 'I went there!'라고 말할 거예요."})
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there"}).json()
    assert body["fixed"] == "I went there."
    assert body["suggestion"] is None
    stored = next(m for m in db.get_messages(sid) if m["speaker"] == "user")
    assert stored["suggestion"] is None


def test_chat_keeps_a_suggestion_that_only_contains_the_fix(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    suggestion = "'I went there with my sister.'처럼 덧붙여도 좋아요."
    monkeypatch.setattr("app.api.llm.chat_json", lambda m, s, **kw: {
        "ok": False, "fixed": "I went there.", "tag": "시제",
        "correction": "'go'는 과거형이 아닙니다.", "suggestion": suggestion})
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there"}).json()
    assert body["suggestion"] == suggestion


def test_drop_if_quoted_ignores_an_empty_sentence():
    from app import api
    assert api._drop_if_quoted("''라고 하세요", "...") == "''라고 하세요"
```

- [ ] **Step 5: 실패를 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q tests/test_prompts.py tests/test_api_chat.py`
Expected: 새 테스트 중 `native_speaker`, `now_lets_suggestion`, `quotes_its_own_fixed`, `quotes_the_fix_already_shown`이 FAIL. (`only_contains`, `ignores_an_empty_sentence`는 이미 PASS -- 가드가 지나치게 지우지 않는다는 울타리다.)

- [ ] **Step 6: 프롬프트를 바꾼다**

`app/prompts.py`의 `FEEDBACK_SYSTEM`에서 suggestion 항목(`- suggestion: 원어민이라면 어떻게 말할지. ...` 세 줄)을 다음으로 바꾼다:

```
- suggestion: 이 상황에서 원어민이라면 이 말을 어떻게 했을지. 학생이 하려던 뜻은 그대로
  두고, 상대방이 직전에 한 말과 대화 목표에 자연스럽게 이어지는 한마디를 따옴표로 인용해
  보여줍니다. correction과 같은 지적을 되풀이하지 말고, fixed 문장을 그대로 인용하지
  마세요 -- fixed와는 다른 표현이어야 합니다. 문장이 이미 맞을 때도 쓸 수 있는 다른
  표현으로 씁니다. 한국어로 두 문장 이내
```

(기존 테스트가 `"다른 표현"`을 찾으므로 그 말은 남아 있어야 한다.)

`_feedback_context`의 반환 머리말을 바꾼다:

```python
    return (
        "\n\n참고할 문맥입니다. 학생이 무엇을 말하려 했는지 판단하고, suggestion을"
        " 이 상황에 맞추는 데 쓰세요. 문맥 문장을 그대로 베끼지는 마세요.\n" + "\n".join(lines)
    )
```

`FEEDBACK_EXAMPLES`의 suggestion 두 개를 바꾼다(나머지 필드 그대로):
- en 첫 예시: `"원어민이라면 'I stopped by the store yesterday.'처럼 더 가볍게 말하기도 해요."`
- ja 첫 예시: `"원어민이라면 '昨日はレストランで食べてきました。'처럼 말하기도 해요."`

`FEEDBACK_EXAMPLES` 위의 주석 끝에 한 줄 추가: `# No example's suggestion may quote its own fixed -- the model copies examples over rules (test_no_feedback_example_suggestion_quotes_its_own_fixed).`

- [ ] **Step 7: 가드를 실제 교정 경로에 건다**

`app/api.py` `_feedback`의 마지막 `return {...}`(중립 처리 뒤)의 `"suggestion"`을 바꾼다:

```python
        suggestion = result.get("suggestion")
        if ok is False and isinstance(fixed, str) and fixed:
            # The 교정 block already shows `fixed`; a suggestion quoting it back
            # is the same sentence twice. See _drop_if_quoted.
            suggestion = _drop_if_quoted(suggestion, fixed)
        return {
            "ok": None if ok is None else bool(ok),
            "fixed": fixed,
            "tag": result.get("tag"),
            "correction": result.get("correction"),
            "suggestion": suggestion,
        }
```

- [ ] **Step 8: 초록을 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q`
Expected: 394 + 6 = **400 passed** (engine 제외).

- [ ] **Step 9: 부숴서 빨개지는지 확인한다**

각각 하나씩 적용 → 해당 테스트 FAIL 확인 → 되돌리기:
1. Step 7의 `suggestion = _drop_if_quoted(...)` 줄을 주석 처리 → `quotes_the_fix_already_shown` FAIL.
2. `_drop_if_quoted`의 `==`를 `in`(`target in normalize(span)`)으로 → `only_contains` FAIL.
3. `if not target: return suggestion` 삭제 → `ignores_an_empty_sentence` FAIL.
4. ja 예시 suggestion을 `'きのう、レストランに行きました。'`로 되돌리기 → `quotes_its_own_fixed` FAIL.

- [ ] **Step 10: 바꾼 뒤 수치를 잰다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -m engine -s tests/test_feedback_suggestion_quality.py tests/test_feedback_quality.py`
Expected: 두 파일 모두 PASS. `test_feedback_quality.py`가 떨어지면 **오류를 덜 잡게 된 것**이므로 멈추고 보고한다(문턱을 낮추지 않는다). 전후 `fixed 되풀이` 수치와 표본(전·후 각 11개)을 보고서에 붙인다.
`test_suggestion_rarely_just_restates_fixed`의 문턱(`<= 1`)이 실측과 맞지 않으면 실측값을 보고하고, 실측보다 낮은 문턱으로 바꾸지 말고 컨트롤러에게 판단을 넘긴다.

- [ ] **Step 11: 커밋**

```bash
git add app/prompts.py app/api.py tests/test_prompts.py tests/test_api_chat.py tests/test_feedback_suggestion_quality.py
git commit -m "feat: the feedback chip suggests what a native speaker would say here

<전후 수치: fixed 되풀이 a/b -> c/d, test_feedback_quality 결과>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9"
```

---

### Task 2: ② 추천 프롬프트

**Files:**
- Modify: `app/prompts.py` (파일 끝, 번역 프롬프트 뒤)
- Test: `tests/test_prompts.py`

**Interfaces:**
- Produces:
  - `prompts.suggest_schema() -> dict`
  - `prompts.build_suggest_messages(language: str, bot_last: str, *, level: str = "beginner", scenario_title: str | None = None, scenario_goal: str | None = None, topic: str | None = None, recent: tuple[tuple[str, str], ...] = ()) -> list[dict]` -- `recent`는 `(speaker, text)` 쌍, speaker는 `"bot"`/`"user"`, 봇 마지막 말 **이전**의 메시지들.
  - `prompts.SUGGEST_EXAMPLES: dict[str, tuple[str, list[dict]]]` -- 언어별 `(봇 대사, [{"text","meaning"}, ...])`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/test_prompts.py` 끝에 추가:

```python
def test_suggest_schema_asks_for_replies_with_text_and_meaning():
    schema = prompts.suggest_schema()
    assert schema["required"] == ["replies"]
    item = schema["properties"]["replies"]["items"]
    assert set(item["required"]) == {"text", "meaning"}


def test_suggest_system_prompt_is_korean_and_asks_for_different_directions():
    for language in ("en", "ja"):
        system = prompts.build_suggest_messages(language, "Hi!")[0]["content"]
        assert sum(1 for ch in system if "가" <= ch <= "힣") > 100
        assert "방향" in system
    assert "12단어" in prompts.build_suggest_messages("en", "Hi!")[0]["content"]
    assert "30자" in prompts.build_suggest_messages("ja", "こんにちは")[0]["content"]


def test_suggest_japanese_gets_the_script_only_rule():
    assert prompts.JAPANESE_SCRIPT_ONLY_RULE in prompts.build_suggest_messages("ja", "こんにちは")[0]["content"]
    assert prompts.JAPANESE_SCRIPT_ONLY_RULE not in prompts.build_suggest_messages("en", "Hi!")[0]["content"]


def test_suggest_level_reaches_the_prompt_in_korean():
    system = prompts.build_suggest_messages("en", "Hi!", level="intermediate")[0]["content"]
    assert "중급" in system


def test_suggest_context_only_fills_in_the_pieces_it_has():
    bare = prompts.build_suggest_messages("en", "Hi!")[0]["content"]
    assert "참고할 문맥" not in bare and "None" not in bare

    full = prompts.build_suggest_messages(
        "en", "Window or aisle?", scenario_title="공항 체크인", scenario_goal="창가 자리를 요청한다",
        recent=(("bot", "Good morning! Passport, please."), ("user", "Here you are.")),
    )[0]["content"]
    assert "공항 체크인" in full and "창가 자리를 요청한다" in full
    assert "상대방: Good morning! Passport, please." in full
    assert "학생: Here you are." in full
    assert "수업 주제" not in full

    lesson = prompts.build_suggest_messages("en", "Try 'used to'.", topic="used to")[0]["content"]
    assert "오늘 수업 주제: used to" in lesson and "지금 상황" not in lesson


def test_suggest_query_turn_has_the_same_shape_as_the_example_turn():
    """쿼리 턴만 모양이 다르면 로컬 모델은 내용보다 그 차이에 끌린다
    (build_feedback_messages docstring)."""
    import json
    for language in ("en", "ja"):
        msgs = prompts.build_suggest_messages(language, "LINE")
        users = [m["content"] for m in msgs if m["role"] == "user"]
        example_bot, _ = prompts.SUGGEST_EXAMPLES[language]
        assert users[0] == users[-1].replace("LINE", example_bot)
        answer = json.loads(next(m["content"] for m in msgs if m["role"] == "assistant"))
        assert 2 <= len(answer["replies"]) <= 3
        assert msgs[-1] == {"role": "user", "content": users[-1]}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q tests/test_prompts.py -k suggest`
Expected: FAIL `AttributeError: module 'app.prompts' has no attribute 'suggest_schema'` 등.

- [ ] **Step 3: 구현한다**

`app/prompts.py` 끝에 추가:

```python
def suggest_schema() -> dict:
    """What 💡 뭐라고 하지? asks for. Ollama makes it parse; api._valid_replies
    decides what is actually shown (language, length, duplicates, Korean meaning)."""
    return {
        "type": "object",
        "properties": {
            "replies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"text": {"type": "string"}, "meaning": {"type": "string"}},
                    "required": ["text", "meaning"],
                },
            },
        },
        "required": ["replies"],
    }


_LEVEL_KOREAN = {"beginner": "초급", "intermediate": "중급", "advanced": "고급"}

_SUGGEST_LENGTH_RULE = {
    "en": "한 대답은 영어 12단어 이하입니다",
    "ja": "한 대답은 일본어 30자 이하입니다",
}

# Editing this string? Run `pytest tests/test_suggest_quality.py -m engine`
# against the real model afterward.
SUGGEST_SYSTEM = """당신은 한국인 학생의 {lang} 회화 연습을 돕는 한국어 원어민 교사입니다.
당신이 설명에 쓰는 언어는 한국어입니다. {lang}은(는) 학생이 소리 내어 말할 문장에만 씁니다.

학생이 {lang}로 대화하는 중인데, 상대방이 방금 한 말에 뭐라고 대답할지 막막해합니다.
학생이 그대로 따라 말할 수 있는 대답을 2~3개 주세요.

- 대답마다 방향이 달라야 합니다. 예를 들어 하나는 받아들이기, 하나는 다른 것을
  요청하거나 사양하기, 하나는 되묻거나 질문하기. 같은 말을 단어만 바꾼 대답은 안 됩니다
- 실제 사람이 하는 짧은 입말로 씁니다. {length_rule}
- 학생 수준({level})에 맞는 쉬운 단어를 씁니다
- text: 학생이 말할 {lang} 문장 하나. 설명, 괄호, 따옴표, 로마자를 넣지 않습니다
- meaning: 그 문장의 뜻을 자연스러운 한국어 한 줄로. 한글로만 씁니다

마크다운과 이모지는 쓰지 않습니다."""

# One worked example per language: the same invitation, answered three
# different ways (accept / decline-with-alternative / ask back) -- the variety
# the prompt asks for, shown rather than only stated.
SUGGEST_EXAMPLES = {
    "en": (
        "Would you like to grab lunch together tomorrow?",
        [
            {"text": "Sure, that sounds great!", "meaning": "좋아요, 좋은 생각이에요!"},
            {"text": "Sorry, I'm busy tomorrow. How about Friday?", "meaning": "미안해요, 내일은 바빠요. 금요일은 어때요?"},
            {"text": "Where were you thinking of going?", "meaning": "어디 가려고 생각했어요?"},
        ],
    ),
    "ja": (
        "明日、一緒にお昼を食べませんか。",
        [
            {"text": "いいですね、ぜひ！", "meaning": "좋네요, 꼭 같이 먹어요!"},
            {"text": "すみません、明日はちょっと忙しいです。", "meaning": "죄송해요, 내일은 좀 바빠요."},
            {"text": "どこに行きますか。", "meaning": "어디로 가요?"},
        ],
    ),
}


def _suggest_request(bot_line: str) -> str:
    return f"상대방이 방금 한 말: \"{bot_line}\"\n학생이 할 수 있는 대답을 방향이 다르게 2~3개 주세요."


def _suggest_context(*, scenario_title=None, scenario_goal=None, topic=None, recent=()) -> str:
    """Same rule as _feedback_context: a missing piece is left out, never
    written as None, and no pieces at all means no paragraph."""
    lines = []
    if scenario_title:
        goal_part = f" (목표: {scenario_goal})" if scenario_goal else ""
        lines.append(f"- 지금 상황: {scenario_title}{goal_part}")
    if topic:
        lines.append(f"- 오늘 수업 주제: {topic}")
    if recent:
        lines.append("- 최근 대화:")
        for speaker, text in recent:
            who = "상대방" if speaker == "bot" else "학생"
            lines.append(f"  {who}: {text}")
    if not lines:
        return ""
    return "\n\n참고할 문맥입니다. 대답이 이 상황과 대화 흐름에 맞도록 쓰세요.\n" + "\n".join(lines)


def build_suggest_messages(language, bot_last, *, level="beginner", scenario_title=None,
                           scenario_goal=None, topic=None, recent=()) -> list[dict]:
    """Ask for 2-3 replies the learner could say to the bot's last line.

    Korean system prompt, for the reason every prompt in this file is Korean:
    this model answers in the language it is addressed in. Context goes into
    the system prompt, never the user turn, so the query turn keeps exactly
    the example turn's shape.
    """
    language_name = KOREAN_LANGUAGE_NAMES[language]
    system = SUGGEST_SYSTEM.format(
        lang=language_name, length_rule=_SUGGEST_LENGTH_RULE[language],
        level=_LEVEL_KOREAN.get(level, "초급"),
    )
    system += _suggest_context(scenario_title=scenario_title, scenario_goal=scenario_goal,
                               topic=topic, recent=recent)
    if language == "ja":
        system += "\n" + JAPANESE_SCRIPT_ONLY_RULE
    example_bot, example_replies = SUGGEST_EXAMPLES[language]
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": _suggest_request(example_bot)},
        {"role": "assistant", "content": json.dumps({"replies": example_replies}, ensure_ascii=False)},
        {"role": "user", "content": _suggest_request(bot_last)},
    ]
```

- [ ] **Step 4: 초록을 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q`
Expected: 400 + 6 = **406 passed**.

- [ ] **Step 5: 부숴서 빨개지는지 확인한다**

1. `if recent:` 블록의 `who = "상대방" if ...`를 `who = speaker`로 → `only_fills_in_the_pieces` FAIL.
2. `_suggest_request`의 사용자 턴에 문맥 한 줄을 붙이는 변형(`+ (scenario_title or "")`을 build 쪽에서) 대신, 간단히 마지막 턴을 `f"상대방: {bot_last}"`로 바꿔 → `same_shape` FAIL.
3. `if language == "ja":` 블록 삭제 → `script_only_rule` FAIL.
되돌리고 초록 확인.

- [ ] **Step 6: 커밋**

```bash
git add app/prompts.py tests/test_prompts.py
git commit -m "feat: a prompt for replies the learner could say next

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9"
```

---

### Task 3: ② 추천 줄 검증

**Files:**
- Modify: `app/api.py` (`_first_line` 정의 **뒤**에 둔다 -- 그 함수를 쓴다)
- Create: `tests/test_api_suggest.py`

**Interfaces:**
- Consumes: `api._first_line`, `api._HANGUL`, `api._LATIN_LETTER`, `app.text_match.normalize`.
- Produces: `api._valid_replies(raw_replies, language: str, bot_last: str, kept: list[dict] = ()) -> list[dict]` -- 각 원소 `{"text": str, "meaning": str | None}`. `kept`의 원소가 앞에 그대로 오고, 새 줄은 `kept`와도 중복 검사한다. 최대 3개.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/test_api_suggest.py`:

```python
"""💡 뭐라고 하지? -- 서버 쪽. 모델은 전부 목(mock)이다."""
import pytest

from app import api


def _r(text, meaning="뜻"):
    return {"text": text, "meaning": meaning}


def test_valid_replies_keeps_good_lines_in_order():
    out = api._valid_replies([_r("Sure, sounds good!"), _r("Can we do Friday?")], "en", "Lunch tomorrow?")
    assert out == [{"text": "Sure, sounds good!", "meaning": "뜻"},
                   {"text": "Can we do Friday?", "meaning": "뜻"}]


@pytest.mark.parametrize("language,text", [
    ("en", "네, 좋아요"),                 # Korean instead of the target language
    ("en", "Sure 좋아요"),                # any Hangul at all
    ("ja", "我明天很忙"),                  # kanji with no kana -- could be Chinese
    ("ja", "はい、좋아요"),
    ("en", "1234 !!"),                   # no letters
    ("en", "one two three four five six seven eight nine ten eleven twelve thirteen"),  # 13 words
    ("ja", "あ" * 31),                   # 31 chars
    ("en", ""),
    ("en", "   "),
])
def test_valid_replies_drops_a_line_that_cannot_be_said(language, text):
    assert api._valid_replies([_r(text)], language, "bot line") == []


def test_valid_replies_measures_japanese_length_without_punctuation():
    text = "あ" * 30 + "。、！"
    assert [r["text"] for r in api._valid_replies([_r(text)], "ja", "x")] == [text]


def test_valid_replies_allows_exactly_twelve_english_words():
    text = "one two three four five six seven eight nine ten eleven twelve"
    assert len(api._valid_replies([_r(text)], "en", "x")) == 1


def test_valid_replies_takes_only_the_first_line_of_text():
    out = api._valid_replies([_r("Sure!\n(This means yes.)")], "en", "x")
    assert out[0]["text"] == "Sure!"


def test_valid_replies_drops_duplicates_and_the_bots_own_line():
    out = api._valid_replies(
        [_r("Sure!"), _r("sure"), _r("Lunch tomorrow?"), _r("Maybe later.")],
        "en", "Lunch tomorrow",
    )
    assert [r["text"] for r in out] == ["Sure!", "Maybe later."]


def test_valid_replies_caps_at_three():
    out = api._valid_replies([_r("A one."), _r("B two."), _r("C three."), _r("D four.")], "en", "x")
    assert len(out) == 3


def test_valid_replies_merges_with_what_was_already_kept():
    kept = [{"text": "Sure!", "meaning": "좋아요"}]
    out = api._valid_replies([_r("sure"), _r("Not today.")], "en", "x", kept)
    assert out == [{"text": "Sure!", "meaning": "좋아요"}, {"text": "Not today.", "meaning": "뜻"}]


@pytest.mark.parametrize("raw", [None, "nope", [None, 3, "x"], [{"text": 5}], [{"meaning": "뜻"}]])
def test_valid_replies_survives_malformed_model_output(raw):
    assert api._valid_replies(raw, "en", "x") == []


def test_valid_replies_keeps_a_missing_or_non_string_meaning_as_none():
    out = api._valid_replies([{"text": "Sure!"}, {"text": "Nope.", "meaning": 3}], "en", "x")
    assert [r["meaning"] for r in out] == [None, None]
```

- [ ] **Step 2: 실패를 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q tests/test_api_suggest.py`
Expected: FAIL `AttributeError: module 'app.api' has no attribute '_valid_replies'`.

- [ ] **Step 3: 구현한다**

`app/api.py`의 `_first_line` 정의 바로 뒤에 추가:

```python
# 💡 뭐라고 하지? -- what makes a generated reply worth showing.
_KANA = re.compile(r"[぀-ヿ]")
_SUGGEST_MAX_WORDS_EN = 12
_SUGGEST_MAX_CHARS_JA = 30
_SUGGEST_MAX_REPLIES = 3


def _sayable(text: str, language: str) -> bool:
    """Can the learner say this line as practice in `language`?

    Any Hangul means the model answered in the wrong language. Japanese needs
    at least one kana: a kanji-only line is exactly what a Chinese leak looks
    like. Too long is refused rather than cut -- a truncated sentence is a
    wrong sentence, and the learner would practise it.
    """
    if _HANGUL.search(text):
        return False
    if language == "ja":
        return bool(_KANA.search(text)) and len(normalize(text).replace(" ", "")) <= _SUGGEST_MAX_CHARS_JA
    return bool(_LATIN_LETTER.search(text)) and len(text.split()) <= _SUGGEST_MAX_WORDS_EN


def _valid_replies(raw_replies, language: str, bot_last: str, kept=()) -> list[dict]:
    """The model's replies that pass, after whatever was already kept.

    Never raises on malformed output -- chat_json guarantees JSON, not shape.
    A duplicate (after normalisation) of a kept line or of the bot's own line
    is dropped: three ways to say one thing, or the bot's line handed back,
    is not a choice.
    """
    out = [dict(r) for r in kept]
    seen = {normalize(r["text"]) for r in out}
    bot_key = normalize(bot_last)
    for item in raw_replies if isinstance(raw_replies, list) else []:
        if len(out) >= _SUGGEST_MAX_REPLIES:
            break
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        text = _first_line(item["text"])
        if not text or not _sayable(text, language):
            continue
        key = normalize(text)
        if not key or key in seen or key == bot_key:
            continue
        seen.add(key)
        meaning = item.get("meaning")
        out.append({"text": text, "meaning": meaning.strip() if isinstance(meaning, str) else None})
    return out
```

- [ ] **Step 4: 초록을 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q`
Expected: 406 + 25 = **431 passed** (parametrize 포함 새 테스트 25개; 개수가 다르면 실제 수집 개수를 보고).

- [ ] **Step 5: 부숴서 빨개지는지 확인한다**

1. `_sayable`의 `if _HANGUL.search(text): return False` 삭제 → `Sure 좋아요`, `はい、좋아요` 케이스 FAIL.
2. `bool(_KANA.search(text)) and` 삭제 → `我明天很忙` FAIL.
3. `<= _SUGGEST_MAX_WORDS_EN`을 `<= 13`으로 → 13단어 케이스 FAIL.
4. `or key == bot_key` 삭제 → `drops_duplicates_and_the_bots_own_line` FAIL.
5. `seen = {...}`를 `seen = set()`으로 → `merges_with_what_was_already_kept` FAIL.
되돌리고 초록 확인.

- [ ] **Step 6: 커밋**

```bash
git add app/api.py tests/test_api_suggest.py
git commit -m "feat: decide which suggested replies are worth showing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9"
```

---

### Task 4: ② 생성·캐시·라우트, 그리고 실제 모델 품질

**Files:**
- Modify: `app/api.py` (`store_script_line` 라우트 **앞**, `chat_turn` 뒤에 둔다)
- Modify: `tests/test_api_suggest.py`
- Create: `tests/test_suggest_quality.py`

**Interfaces:**
- Consumes: `prompts.build_suggest_messages`, `prompts.suggest_schema` (Task 2), `api._valid_replies` (Task 3), `api._is_korean_meaning`, `api._cached_translation`, `api._speak`, `api._first_line`.
- Produces:
  - `api._generate_suggestions(language, bot_last, *, level="beginner", scenario_title=None, scenario_goal=None, topic=None, recent=()) -> list[dict]` -- `{"text", "meaning": str|None}` 1~3개. 하나도 없거나 모델 실패면 `_NoSuggestions`를 던진다.
  - `api._cached_suggestions(session_id: int, bot_message_id: int) -> tuple[dict, ...]` (lru_cache, `.cache_clear()`)
  - `POST /api/sessions/{session_id}/suggest` → `{"replies": [{"text", "meaning", "audio_key"}]}`; 404/400/409/409/503.
  - `api.SUGGEST_UNAVAILABLE = "지금은 추천을 만들 수 없어요"`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/test_api_suggest.py` 맨 위 import를 다음으로 바꾸고, 파일 끝에 테스트를 추가한다:

```python
"""💡 뭐라고 하지? -- 서버 쪽. 모델은 전부 목(mock)이다."""
import pytest
from fastapi.testclient import TestClient

from app import api, config, db, llm, tts
from app.main import app
```

```python
@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    api._cached_suggestions.cache_clear()
    api._cached_translation.cache_clear()
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "Good morning! Window or aisle?")
    return TestClient(app)


class Model:
    """Queue of chat_json answers; records every call."""
    def __init__(self, monkeypatch, *answers):
        self.answers = list(answers)
        self.calls = []
        monkeypatch.setattr(llm, "chat_json", self)

    def __call__(self, messages, schema, **kw):
        self.calls.append({"messages": messages, "schema": schema, **kw})
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


GOOD = {"replies": [_r("Window, please.", "창가로 주세요."),
                    _r("Aisle is fine.", "통로도 괜찮아요."),
                    _r("Is there an exit row?", "비상구 좌석 있나요?")]}


def _free(client, language="en", scenario="airport-checkin-en"):
    return client.post("/api/sessions", json={"language": language, "mode": "free",
                                              "scenario_id": scenario}).json()["session_id"]


def test_generate_asks_the_model_warmly_and_returns_what_passed(monkeypatch):
    model = Model(monkeypatch, GOOD)
    out = api._generate_suggestions("en", "Window or aisle?")
    assert [r["text"] for r in out] == ["Window, please.", "Aisle is fine.", "Is there an exit row?"]
    assert out[0]["meaning"] == "창가로 주세요."
    assert model.calls[0]["temperature"] == 0.7
    assert model.calls[0]["schema"] == api.prompts.suggest_schema()


def test_generate_retries_once_when_fewer_than_two_pass_and_merges(monkeypatch):
    model = Model(monkeypatch,
                  {"replies": [_r("Window, please."), _r("네 창가요")]},
                  {"replies": [_r("window please"), _r("Aisle is fine.")]})
    out = api._generate_suggestions("en", "Window or aisle?")
    assert len(model.calls) == 2
    assert [r["text"] for r in out] == ["Window, please.", "Aisle is fine."]


def test_generate_shows_a_single_survivor_after_the_retry(monkeypatch):
    Model(monkeypatch, {"replies": [_r("Window, please.")]}, {"replies": []})
    assert [r["text"] for r in api._generate_suggestions("en", "x")] == ["Window, please."]


def test_generate_gives_up_when_nothing_passes(monkeypatch):
    model = Model(monkeypatch, {"replies": [_r("네")]}, {"replies": [_r("아니요")]})
    with pytest.raises(api._NoSuggestions):
        api._generate_suggestions("en", "x")
    assert len(model.calls) == 2


def test_generate_does_not_retry_a_dead_model(monkeypatch):
    """모델이 죽었으면 두 번째 호출은 타임아웃을 한 번 더 기다리게 할 뿐이다."""
    model = Model(monkeypatch, llm.LLMError("down"))
    with pytest.raises(api._NoSuggestions):
        api._generate_suggestions("en", "x")
    assert len(model.calls) == 1


def test_a_meaning_that_is_not_korean_is_translated_again(monkeypatch):
    Model(monkeypatch, {"replies": [_r("Window, please.", "靠窗的座位"), _r("Aisle is fine.", "통로도 괜찮아요.")]})
    asked = []
    monkeypatch.setattr(api, "_cached_translation", lambda lang, text: asked.append(text) or "창가로 주세요.")
    out = api._generate_suggestions("en", "x")
    assert asked == ["Window, please."]
    assert [r["meaning"] for r in out] == ["창가로 주세요.", "통로도 괜찮아요."]


def test_a_meaning_that_cannot_be_recovered_is_none(monkeypatch):
    Model(monkeypatch, {"replies": [_r("Window, please.", ""), _r("Aisle is fine.", None)]})
    monkeypatch.setattr(api, "_cached_translation", lambda lang, text: None)
    assert [r["meaning"] for r in api._generate_suggestions("en", "x")] == [None, None]


def test_route_returns_replies_with_audio(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    body = client.post(f"/api/sessions/{sid}/suggest").json()
    assert [r["text"] for r in body["replies"]] == ["Window, please.", "Aisle is fine.", "Is there an exit row?"]
    assert all(r["audio_key"] for r in body["replies"])
    assert body["replies"][0]["meaning"] == "창가로 주세요."


def test_route_hands_the_model_the_scene_the_level_and_the_bots_last_line(client, monkeypatch):
    sid = _free(client)
    model = Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    system = model.calls[0]["messages"][0]["content"]
    last_user = model.calls[0]["messages"][-1]["content"]
    assert "Good morning! Window or aisle?" in last_user
    assert "지금 상황" in system and "초급" in system


def test_route_passes_the_lesson_topic_and_recent_turns(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "lesson", "topic": "used to"}).json()["session_id"]
    db.add_message(sid, "user", "I used to swim.")
    db.add_message(sid, "bot", "Nice! Another one?")
    model = Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    system = model.calls[0]["messages"][0]["content"]
    assert "오늘 수업 주제: used to" in system
    assert "학생: I used to swim." in system
    assert "Nice! Another one?" in model.calls[0]["messages"][-1]["content"]
    assert "상대방: Nice! Another one?" not in system  # the line being answered is the query, not history


def test_route_keeps_only_the_last_six_messages_as_history(client, monkeypatch):
    sid = _free(client)
    for i in range(5):
        db.add_message(sid, "user", f"user line {i}")
        db.add_message(sid, "bot", f"bot line {i}")
    model = Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    system = model.calls[0]["messages"][0]["content"]
    assert "bot line 1" in system and "bot line 0" not in system


def test_route_rejects_what_it_cannot_answer(client, monkeypatch):
    Model(monkeypatch, GOOD)
    assert client.post("/api/sessions/999/suggest").status_code == 404
    script = client.post("/api/sessions", json={"language": "en", "mode": "script",
                                                "scenario_id": "standup-meeting-en"}).json()["session_id"]
    assert client.post(f"/api/sessions/{script}/suggest").status_code == 400
    ended = _free(client)
    db.end_session(ended, "{}", "beginner")
    assert client.post(f"/api/sessions/{ended}/suggest").status_code == 409
    silent = db.create_session("en", "lesson", topic=None)
    assert client.post(f"/api/sessions/{silent}/suggest").status_code == 409


def test_route_says_so_when_nothing_can_be_suggested(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, llm.LLMError("down"))
    r = client.post(f"/api/sessions/{sid}/suggest")
    assert r.status_code == 503
    assert r.json()["detail"] == api.SUGGEST_UNAVAILABLE


def test_route_caches_per_bot_line_and_not_failures(client, monkeypatch):
    sid = _free(client)
    model = Model(monkeypatch, llm.LLMError("down"))
    assert client.post(f"/api/sessions/{sid}/suggest").status_code == 503
    model.answers = [GOOD]
    first = client.post(f"/api/sessions/{sid}/suggest").json()
    again = client.post(f"/api/sessions/{sid}/suggest").json()
    assert first == again
    assert len(model.calls) == 2          # the failure, then one success; the repeat was free
    db.add_message(sid, "user", "Window.")
    db.add_message(sid, "bot", "Great. Any bags to check?")
    client.post(f"/api/sessions/{sid}/suggest")
    assert len(model.calls) == 3          # a new bot line is a new question


def test_route_still_answers_when_tts_is_down_and_recovers_after(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    def dead(t, l, v):
        raise tts.TTSError("down")
    monkeypatch.setattr(tts, "synthesize", dead)
    body = client.post(f"/api/sessions/{sid}/suggest").json()
    assert [r["audio_key"] for r in body["replies"]] == [None, None, None]
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    body = client.post(f"/api/sessions/{sid}/suggest").json()
    assert all(r["audio_key"] for r in body["replies"])  # audio is not frozen into the cache


def test_route_response_does_not_leak_cache_mutation(client, monkeypatch):
    sid = _free(client)
    Model(monkeypatch, GOOD)
    client.post(f"/api/sessions/{sid}/suggest")
    cached = api._cached_suggestions(sid, db.get_messages(sid)[-1]["id"])
    assert all("audio_key" not in r for r in cached)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q tests/test_api_suggest.py`
Expected: 새 테스트들이 FAIL(`_generate_suggestions` 없음, 라우트 404). `db.end_session`·`db.create_session` 시그니처가 위와 다르면 `app/db.py`를 읽고 테스트 쪽을 맞춘다(`end_session(session_id, report, level)`, `create_session(language, mode, scenario_id=None, topic=None)`이 현재 코드 기준).

- [ ] **Step 3: 구현한다**

`app/api.py`, `chat_turn` 라우트 바로 뒤에 추가:

```python
SUGGEST_UNAVAILABLE = "지금은 추천을 만들 수 없어요"
_SUGGEST_RECENT = 6
_SUGGEST_TEMPERATURE = 0.7


class _NoSuggestions(Exception):
    pass


def _reply_meaning(language: str, reply: dict) -> str | None:
    """The model's own meaning when it is really Korean; otherwise the same
    checked, cached translation the ▸ 뜻 button uses; otherwise None, and the
    card offers ▸ 뜻 instead."""
    meaning = _first_line(reply["meaning"]) if reply["meaning"] else None
    if meaning and _is_korean_meaning(meaning, source=reply["text"]):
        return meaning
    return _cached_translation(language, reply["text"])


def _generate_suggestions(language, bot_last, *, level="beginner", scenario_title=None,
                          scenario_goal=None, topic=None, recent=()) -> list[dict]:
    """Two or three replies the learner could say next, or _NoSuggestions.

    Temperature 0.7, above feedback's 0.3: the point is replies that go in
    different directions, and a near-greedy model gives three phrasings of one.
    Fewer than two survivors earns one more sample (plain resampling -- at 0.7
    that alone changes the answer); a dead model does not, because the second
    call would only wait out the same timeout again.
    """
    messages = prompts.build_suggest_messages(
        language, bot_last, level=level, scenario_title=scenario_title,
        scenario_goal=scenario_goal, topic=topic, recent=recent,
    )
    kept: list[dict] = []
    for _ in range(2):
        try:
            result = llm.chat_json(messages, prompts.suggest_schema(),
                                   temperature=_SUGGEST_TEMPERATURE)
        except Exception as exc:
            raise _NoSuggestions from exc
        raw = result.get("replies") if isinstance(result, dict) else None
        kept = _valid_replies(raw, language, bot_last, kept)
        if len(kept) >= 2:
            break
    if not kept:
        raise _NoSuggestions
    return [{"text": r["text"], "meaning": _reply_meaning(language, r)} for r in kept]


@functools.lru_cache(maxsize=256)
def _cached_suggestions(session_id: int, bot_message_id: int) -> tuple[dict, ...]:
    """Successful suggestions per bot line. Pressing 💡 again on the same line
    shows the same replies -- if they changed on every press, "the one I saw a
    moment ago" would be gone. lru_cache does not cache exceptions, so a
    failure is retried on the next press.

    The dicts are the cache's own objects; the route copies them before adding
    audio_key. Keyed by message id, so undo (which removes the learner turn
    and the bot reply after it) never leaves a stale entry reachable."""
    session = db.get_session(session_id)
    messages = db.get_messages(session_id)
    index = next(i for i, m in enumerate(messages) if m["id"] == bot_message_id)
    before = messages[max(0, index - _SUGGEST_RECENT):index]
    language = session["language"]
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    return tuple(_generate_suggestions(
        language, messages[index]["text"],
        level=db.stable_level(language) or "beginner",
        scenario_title=scenario.get("title") if scenario else None,
        scenario_goal=scenario.get("goal") if scenario else None,
        topic=session["topic"] if session["mode"] == "lesson" else None,
        recent=tuple((m["speaker"], m["text"]) for m in before),
    ))


@router.post("/sessions/{session_id}/suggest")
def suggest_replies(session_id: int):
    """💡 뭐라고 하지? -- replies the learner could say to the bot's last line.

    Never stored: these are prompts to speak, not turns. Nothing is sent on the
    learner's behalf either; they say it themselves, the same reason a
    recognised turn skips the input box."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["mode"] == "script":
        raise HTTPException(400, "a script already says what to say")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    bot = next((m for m in reversed(db.get_messages(session_id)) if m["speaker"] == "bot"), None)
    if bot is None:
        raise HTTPException(409, "there is no bot line to answer yet")
    try:
        replies = _cached_suggestions(session_id, bot["id"])
    except _NoSuggestions:
        raise HTTPException(503, SUGGEST_UNAVAILABLE)
    # Audio outside the cache: _speak is itself disk-cached and cheap, and a
    # None cached here would outlive a VOICEVOX restart.
    return {"replies": [{**r, "audio_key": _speak(r["text"], session["language"])}
                        for r in replies]}
```

- [ ] **Step 4: 초록을 확인한다**

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q`
Expected: 431 + 17 = **448 passed** (다르면 실제 수를 보고).

- [ ] **Step 5: 부숴서 빨개지는지 확인한다**

1. `for _ in range(2)`를 `range(1)`로 → `retries_once` FAIL.
2. `except Exception as exc: raise _NoSuggestions`를 `except Exception: continue`로 → `does_not_retry_a_dead_model` FAIL.
3. `_reply_meaning`에서 `and _is_korean_meaning(...)` 삭제 → `not_korean_is_translated_again` FAIL.
4. 라우트에서 `_speak`를 `_cached_suggestions` 안으로 옮기기(각 dict에 `audio_key` 추가) → `recovers_after`, `does_not_leak_cache_mutation` FAIL.
5. `messages[max(0, index - _SUGGEST_RECENT):index]`를 `messages[:index]`로 → `last_six_messages` FAIL.
6. `@functools.lru_cache` 삭제 → `caches_per_bot_line` FAIL.
되돌리고 초록 확인.

- [ ] **Step 6: 실제 모델 품질 테스트를 쓰고 잰다**

`tests/test_suggest_quality.py`:

```python
"""💡 뭐라고 하지? -- 실제 모델. `-m engine`에서만 돈다.

문턱은 실측보다 낮게 둔다. 실측 수치는 이 docstring에 적는다:
  (Step 6에서 채움: 2줄 이상 비율, 뜻 null 비율, 원본 meaning 한국어 비율)
"""
import pytest

from app import api, llm, prompts

pytestmark = pytest.mark.engine

# (언어, 봇 대사, 상황 제목, 목표, 수업 주제)
CASES = [
    ("en", "Welcome! Do you have a reservation with us?", "호텔 체크인", "예약을 확인하고 방 열쇠를 받는다", None),
    ("en", "So, how was your weekend?", "동료와 스몰토크", "주말 이야기를 나눈다", None),
    ("en", "Would you like something to drink while you wait?", "식당 대기", "자리를 기다리며 주문한다", None),
    ("en", "Great. Now try making your own sentence with 'used to'.", None, None, "used to"),
    ("en", "The meeting's been moved to three. Does that work for you?", "팀 회의", "일정 변경에 답한다", None),
    ("en", "What brings you to Seoul?", "공항 입국 심사", "방문 목적을 말한다", None),
    ("ja", "いらっしゃいませ。ご予約はございますか。", "호텔 체크인", "예약을 확인하고 방 열쇠를 받는다", None),
    ("ja", "週末は何をしましたか。", "동료와 스몰토크", "주말 이야기를 나눈다", None),
    ("ja", "お待ちの間、お飲み物はいかがですか。", "식당 대기", "자리를 기다리며 주문한다", None),
    ("ja", "では、「〜たことがある」を使って文を作ってみてください。", None, None, "〜たことがある"),
    ("ja", "会議が三時に変わりましたが、大丈夫ですか。", "팀 회의", "일정 변경에 답한다", None),
    ("ja", "どうして日本に来ましたか。", "공항 입국 심사", "방문 목적을 말한다", None),
]


@pytest.fixture(scope="module")
def served():
    """앱의 실제 경로(_generate_suggestions)가 돌려준 것. 실패는 None."""
    out = []
    for lang, bot, title, goal, topic in CASES:
        try:
            out.append((lang, bot, api._generate_suggestions(
                lang, bot, scenario_title=title, scenario_goal=goal, topic=topic)))
        except api._NoSuggestions:
            out.append((lang, bot, None))
    return out


def test_print_samples_for_a_human_to_read(served):
    for lang, bot, replies in served:
        print(f"\n[{lang}] {bot}")
        for r in replies or []:
            print(f"   - {r['text']}  /  {r['meaning']}")


def test_most_lines_get_at_least_two_replies(served):
    short = [bot for _, bot, replies in served if not replies or len(replies) < 2]
    print(f"\n2줄 미만: {len(short)}/{len(served)}")
    assert len(short) <= 2, short


def test_replies_do_not_all_open_the_same_way(served):
    """방향이 다르면 첫머리도 대개 다르다. 셋 다 'Yes, ...'로 시작하면 한 방향이다."""
    def opening(lang, text):
        return text.split()[0].lower().strip(",.!?") if lang == "en" else text[:2]
    same = [bot for lang, bot, replies in served
            if replies and len(replies) >= 2 and len({opening(lang, r["text"]) for r in replies}) == 1]
    assert len(same) <= 2, same


def test_shown_meanings_are_korean_and_rarely_missing(served):
    lines = [(r, bot) for _, bot, replies in served for r in replies or []]
    missing = [r["text"] for r, _ in lines if r["meaning"] is None]
    print(f"\n뜻 없음: {len(missing)}/{len(lines)}")
    assert all(api._is_korean_meaning(r["meaning"], source=r["text"]) for r, _ in lines if r["meaning"])
    assert len(missing) <= max(1, len(lines) // 5), missing


def test_the_models_own_meanings_mostly_are_korean():
    """대체 번역 전 원본 meaning. 대체 경로가 이 비율을 가려주므로 따로 잰다."""
    total = korean = 0
    for lang, bot, title, goal, topic in CASES:
        result = llm.chat_json(prompts.build_suggest_messages(lang, bot, scenario_title=title,
                                                              scenario_goal=goal, topic=topic),
                               prompts.suggest_schema(), temperature=0.7)
        for r in api._valid_replies(result.get("replies"), lang, bot):
            total += 1
            korean += bool(r["meaning"] and api._is_korean_meaning(r["meaning"], source=r["text"]))
    print(f"\n원본 meaning 한국어: {korean}/{total}")
    assert total and korean / total >= 0.6
```

Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -m engine -s tests/test_suggest_quality.py`
출력된 수치 세 개를 docstring의 `(Step 6에서 채움: ...)` 줄을 바꿔 적는다(예: `2줄 이상 11/12, 뜻 없음 1/33, 원본 meaning 한국어 27/33 (2026-09-14, qwen2.5:14b)`). 문턱이 실측보다 높아 떨어지면 **문턱을 바꾸지 말고** 실측과 표본을 보고서에 담아 컨트롤러에게 넘긴다. 표본 출력(12줄 전부)은 보고서에 붙인다.

- [ ] **Step 7: 커밋**

```bash
git add app/api.py tests/test_api_suggest.py tests/test_suggest_quality.py
git commit -m "feat: POST /api/sessions/{id}/suggest -- replies the learner could say next

<실측 수치 세 개>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9"
```

---

### Task 5: ② 화면 -- 버튼과 카드

**Files:**
- Create: `static/js/suggest.js`, `static/js/suggest.test.js`
- Modify: `static/index.html` (`#controls` 안, `btn-end` 앞)
- Modify: `static/js/main.js` (conversation 클릭 핸들러, 버튼 연결)
- Modify: `static/js/session.js` (`startSession`), `static/js/home.js` (`resumeSession`)
- Modify: `static/css/components.css` (`.respeak-result.bad` 규칙 뒤)

**Interfaces:**
- Consumes: `POST /api/sessions/{id}/suggest` → `{"replies": [{"text", "meaning": str|null, "audio_key": str|null}]}` (Task 4); `annotate`, `attachMeaning` (`reading.js`); `$`, `postJSON`, `state`, `notify` (`api.js`).
- Produces (`static/js/suggest.js`):
  - `SUGGEST_TITLE = '이렇게 말해볼 수 있어요'`, `SUGGEST_LOADING = '생각하는 중...'`, `SUGGEST_FAILED = '지금은 추천을 만들 수 없어요'`
  - `setSuggestVisible(mode: string): void` -- `free`/`lesson`이면 `#btn-suggest` 보임, 그 밖은 숨김
  - `latestBotBubble(): Element | null`
  - `suggestForLatest(): Promise<void>`
  - `renderReplies(card: Element, replies: Array, language: string): void`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`static/js/suggest.test.js`:

```js
/* 💡 뭐라고 하지? -- 카드는 물어본 봇 말풍선에 붙고, 누르면 듣기만 한다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $, state } from './api.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';
import * as suggest from './suggest.js';

function bubble(who, text) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  $('conversation').appendChild(div);
  return div;
}

const REPLIES = [
  { text: 'Window, please.', meaning: '창가로 주세요.', audio_key: 'k1' },
  { text: 'Aisle is fine.', meaning: null, audio_key: null },
];

function setup() {
  resetDom();
  state.language = 'en';
  state.sessionId = 7;
}

test('the button shows in free and lesson mode only', () => {
  setup();
  suggest.setSuggestVisible('free');
  assert.equal($('btn-suggest').hidden, false);
  suggest.setSuggestVisible('lesson');
  assert.equal($('btn-suggest').hidden, false);
  suggest.setSuggestVisible('script');
  assert.equal($('btn-suggest').hidden, true);
});

test('the card lands after the bot line that was asked about, even if another arrives first', async () => {
  setup();
  const asked = bubble('bot', 'Window or aisle?');
  let release;
  const requests = [];
  stubFetch((url, options) => {
    requests.push({ url, options });
    return new Promise((r) => { release = () => r(jsonResponse({ replies: REPLIES })); });
  });
  const pending = suggest.suggestForLatest();
  assert.equal($('btn-suggest').disabled, true, '요청 중에는 연타할 수 없다');
  bubble('user', 'Window.');
  bubble('bot', 'Any bags?');
  release();
  await pending;

  const kids = $('conversation').children;
  const card = kids[kids.indexOf(asked) + 1];
  assert.equal(card.className, 'suggest-card');
  assert.equal(requests[0].url, '/api/sessions/7/suggest');
  assert.equal($('btn-suggest').disabled, false);
});

test('a card shows each reply with its meaning and its audio, and nothing that sends', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  stubFetch(async () => jsonResponse({ replies: REPLIES }));
  await suggest.suggestForLatest();
  const card = $('conversation').children.find((n) => n.className === 'suggest-card');
  assert.equal(card.children[0].textContent, suggest.SUGGEST_TITLE);

  const rows = card.children.filter((n) => n.className === 'suggest-row');
  assert.equal(rows.length, 2);
  const [line1, meaning1] = rows[0].children;
  assert.equal(line1.className, 'suggest-line');
  assert.equal(line1.dataset.source, 'Window, please.');
  assert.equal(line1.dataset.audioKey, 'k1');
  assert.equal(meaning1.className, 'suggest-meaning');
  assert.equal(meaning1.textContent, '창가로 주세요.');

  const line2 = rows[1].children[0];
  assert.equal(line2.dataset.audioKey, undefined);
  assert.ok(line2.childNodes.some((n) => n.className === 'meaning'), '뜻이 없으면 ▸ 뜻 버튼');
  assert.equal($('text-input').value ?? '', '', '입력칸을 채우지 않는다');
});

test('asking again on the same bot line does not ask the server again', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  let calls = 0;
  stubFetch(async () => { calls += 1; return jsonResponse({ replies: REPLIES }); });
  await suggest.suggestForLatest();
  await suggest.suggestForLatest();
  assert.equal(calls, 1);
  assert.equal($('conversation').children.filter((n) => n.className === 'suggest-card').length, 1);
});

test('a failure takes the card down, says so, and can be asked again', async () => {
  setup();
  bubble('bot', 'Window or aisle?');
  stubFetch(async () => jsonResponse({ detail: '지금은 추천을 만들 수 없어요' }, { ok: false, status: 503 }));
  await suggest.suggestForLatest();
  assert.equal($('conversation').children.filter((n) => n.className === 'suggest-card').length, 0);
  assert.match($('notice').textContent, /지금은 추천을 만들 수 없어요/);

  stubFetch(async () => jsonResponse({ replies: REPLIES }));
  await suggest.suggestForLatest();
  assert.equal($('conversation').children.filter((n) => n.className === 'suggest-card').length, 1);
});

test('with no bot line there is nothing to ask', async () => {
  setup();
  let calls = 0;
  stubFetch(async () => { calls += 1; return jsonResponse({ replies: REPLIES }); });
  await suggest.suggestForLatest();
  assert.equal(calls, 0);
});

test('Japanese reply lines get reading aids', async () => {
  setup();
  state.language = 'ja';
  const texts = [];
  stubFetch(async (url, options) => {
    if (url === '/api/reading') { texts.push(...JSON.parse(options.body).texts); return jsonResponse({ readings: [] }); }
    return jsonResponse({ replies: [{ text: 'はい、窓側で。', meaning: '네, 창가로요.', audio_key: 'k' }] });
  });
  bubble('bot', '窓側と通路側、どちらがいいですか。');
  await suggest.suggestForLatest();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(texts, ['はい、窓側で。']);
});
```

`notify`가 쓰는 요소 id는 `static/js/api.js`의 `notify`를 읽고 확인한다. `notice`가 아니면 테스트의 `$('notice')`를 그 id로 바꾼다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test --test-force-exit static/js/suggest.test.js`
Expected: FAIL `Cannot find module .../suggest.js`.

- [ ] **Step 3: 마크업·모듈·CSS를 구현한다**

`static/index.html`의 `#controls` 안, `<button id="btn-end" ...>` 바로 앞:

```html
        <button id="btn-suggest" class="ghost" type="button" hidden>💡 뭐라고 하지?</button>
```

`static/js/suggest.js`:

```js
import { $, postJSON, state, notify } from './api.js';
import { annotate, attachMeaning } from './reading.js';

export const SUGGEST_TITLE = '이렇게 말해볼 수 있어요';
export const SUGGEST_LOADING = '생각하는 중...';
export const SUGGEST_FAILED = '지금은 추천을 만들 수 없어요';

/* 봇 말풍선마다 카드는 하나. 로딩 중인 카드도 여기 들어가므로, 같은 말풍선에서
   다시 누르면 요청 중이든 끝났든 새로 묻지 않는다. 대화창이 비워지면 말풍선과
   함께 사라진다(WeakMap). */
const cards = new WeakMap();

/* 대본 모드는 할 말이 이미 정해져 있다. */
export function setSuggestVisible(mode) {
  $('btn-suggest').hidden = !(mode === 'free' || mode === 'lesson');
}

export function latestBotBubble() {
  const bots = [...$('conversation').children]
    .filter((n) => n.classList.contains('msg') && n.classList.contains('bot'));
  return bots[bots.length - 1] || null;
}

/* 누른 그 순간의 봇 말풍선을 붙잡는다. 응답을 기다리는 사이 다음 봇 대사가
   와도 카드는 물어본 말에 붙는다 -- 서버도 요청 시점의 마지막 봇 대사로 답한다.
   턴 상태 머신과는 독립이다: 녹음·전송·재생과 겹칠 자원이 없다. */
export async function suggestForLatest() {
  const bubble = latestBotBubble();
  if (!bubble || !state.sessionId) return;
  const existing = cards.get(bubble);
  if (existing) {
    existing.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const card = document.createElement('div');
  card.className = 'suggest-card';
  const title = document.createElement('p');
  title.className = 'suggest-title';
  title.textContent = SUGGEST_LOADING;
  card.appendChild(title);
  bubble.after(card);
  cards.set(bubble, card);

  const button = $('btn-suggest');
  button.disabled = true;
  const language = state.language;
  try {
    const { replies } = await postJSON(`/sessions/${state.sessionId}/suggest`, {});
    if (!Array.isArray(replies) || !replies.length) throw new Error('no replies');
    title.textContent = SUGGEST_TITLE;
    renderReplies(card, replies, language);
  } catch {
    card.remove();
    cards.delete(bubble);
    notify(SUGGEST_FAILED);
  } finally {
    button.disabled = false;
  }
}

/* 줄마다 문장과 뜻. 문장을 누르면 듣는다(main.js의 대화창 클릭 핸들러).
   보내는 경로는 없다 -- 학습자가 소리 내어 말해야 연습이다. 원문은
   dataset.source에 둔다: 읽기 보조와 뜻 버튼이 textContent를 바꾼다. */
export function renderReplies(card, replies, language) {
  const japanese = [];
  for (const reply of replies) {
    const row = document.createElement('div');
    row.className = 'suggest-row';
    const line = document.createElement('div');
    line.className = 'suggest-line';
    line.textContent = reply.text;
    line.dataset.source = reply.text;
    line.dataset.sourceLang = language;
    if (reply.audio_key) line.dataset.audioKey = reply.audio_key;
    row.appendChild(line);
    if (reply.meaning) {
      line.dataset.hasMeaning = '1';
      const meaning = document.createElement('div');
      meaning.className = 'suggest-meaning';
      meaning.textContent = reply.meaning;
      row.appendChild(meaning);
    } else if (language === 'en') {
      attachMeaning(line, 'en', reply.text);
    }
    if (language === 'ja') japanese.push({ el: line, text: reply.text });
    card.appendChild(row);
  }
  if (japanese.length) annotate(japanese);
}
```

`static/css/components.css`, `.respeak-result.bad` 규칙 바로 뒤:

```css
/* 💡 뭐라고 하지? -- 봇 말풍선 아래, 봇 쪽(왼쪽)에 붙는다. 교정 칩(.chip-row)은
   내 말풍선 쪽(오른쪽)이라 두 카드가 섞여 읽히지 않는다. */
.suggest-card {
  max-width: 78%; margin: calc(var(--space-1) * -1) auto var(--space-3) 0;
  border-left: 2px solid var(--suggest); background: var(--suggest-bg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: var(--space-2) var(--space-3);
}
.suggest-title { font-size: var(--text-xs); color: var(--suggest-ink); margin: 0 0 var(--space-1); font-weight: 600; }
.suggest-row { padding: var(--space-1) 0; }
.suggest-line { font-size: var(--text-base); color: var(--text); cursor: pointer; }
.suggest-meaning { font-size: var(--text-sm); color: var(--text-dim); }
/* 뜻을 이미 보여주는 줄에서는 읽기 보조가 그린 ▸ 뜻 버튼이 군더더기다. */
.suggest-line[data-has-meaning] .meaning,
.suggest-line[data-has-meaning] .meaning-body { display: none; }
```

- [ ] **Step 4: 세션 시작·이어하기·클릭을 연결한다**

`static/js/session.js`: import 줄 끝에 `import { setSuggestVisible } from './suggest.js';` 추가. `startSession`의 `state.mode = payload.mode;` 바로 뒤에 `setSuggestVisible(payload.mode);` 추가.

`static/js/home.js`: import에 `import { setSuggestVisible } from './suggest.js';` 추가. `resumeSession`의 `state.mode = resumeTarget.mode;` 바로 뒤에 `setSuggestVisible(resumeTarget.mode);` 추가.

`static/js/main.js`:
1. import에 `import { suggestForLatest } from './suggest.js';` 추가.
2. 두 번째 `$('conversation').addEventListener('click', ...)` 핸들러를 다음으로 바꾼다:

```js
$('conversation').addEventListener('click', (e) => {
  // 뜻 토글이 먼저다. renderTokens가 말풍선과 추천 줄 안에도 '▸ 뜻' 버튼을
  // 그리므로, 대본 패널과 똑같이 여기서도 받아줘야 한다.
  const meaning = e.target.closest('button.meaning');
  if (meaning) {
    const host = meaning.closest('.msg.bot, .suggest-line');
    if (host) toggleMeaning(host, host.querySelector('.meaning-body'));
    return;
  }
  // 추천 줄은 들을 수만 있다. 키가 없으면(TTS가 죽어 있었음) 브라우저 음성.
  const reply = e.target.closest('.suggest-line');
  if (reply) {
    play(reply.dataset.audioKey || null, reply.dataset.source);
    return;
  }
  const bubble = e.target.closest('.msg.bot');
  if (!bubble || e.target.closest('button')) return;
  // No key means nothing to play, not a failed synthesis -- a resumed bubble
  // never had a TTS key of its own attempted on it (GET /sessions/{id} only
  // ever hands back a key for a clip already on disk). Calling play(null,
  // ...) here would tell the learner "서버 음성 생성에 실패해" for a clip that
  // was never asked for, and fall them back to browser speech for nothing.
  if (!bubble.dataset.audioKey) return;
  // dataset.source, not textContent: a bubble with a meaning toggle also holds
  // the button's label and, once opened, the Korean meaning.
  play(bubble.dataset.audioKey, bubble.dataset.source || bubble.textContent);
});
$('btn-suggest').addEventListener('click', suggestForLatest);
```

(기존 주석 문단 `// 봇 말풍선만이다. ...` 세 줄은 핸들러 위에 그대로 둔다.)

- [ ] **Step 5: 초록을 확인한다**

Run: `node --test --test-force-exit 'static/js/*.test.js'`
Expected: 106 + 7 = **113 pass**. `main.test.js`의 "index.html이 선언하지 않은 id" 검사도 통과해야 한다.
Run: `C:/git/Monologue/venv/Scripts/python.exe -m pytest -q`
Expected: 448 passed (`test_css_tokens.py`가 새 CSS의 토큰을 전부 정의된 것으로 본다).

- [ ] **Step 6: 부숴서 빨개지는지 확인한다**

1. `suggestForLatest`의 `if (existing) {...}` 블록 삭제 → `does not ask the server again` FAIL.
2. `bubble.after(card)`를 `$('conversation').appendChild(card)`로 → `lands after the bot line that was asked about` FAIL.
3. `catch`의 `card.remove(); cards.delete(bubble);` 삭제 → `failure takes the card down` FAIL.
4. `setSuggestVisible`의 `|| mode === 'lesson'` 삭제 → `free and lesson mode only` FAIL.
5. `index.html`에서 `btn-suggest` 줄 삭제 → `main.test.js` FAIL.
되돌리고 초록 확인.

- [ ] **Step 7: 커밋**

```bash
git add static/index.html static/js/suggest.js static/js/suggest.test.js static/js/main.js static/js/session.js static/js/home.js static/css/components.css
git commit -m "feat: 💡 뭐라고 하지? -- replies to say, under the line they answer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0195b6dJR8huPU7VMxGuLFp9"
```

---

## 최종 확인 (컨트롤러)

- 전체 스위트: pytest(기본)·node 수치를 기준선과 비교.
- engine: `test_feedback_quality.py`, `test_feedback_suggestion_quality.py`, `test_suggest_quality.py`.
- 브라우저: 워크트리를 **8010**으로 띄워(DB 복사본) 자유·수업·대본 모드에서 버튼 표시, 카드 위치, 줄 클릭 재생, 일본어 읽기 보조, 뜻 버튼, 실패 문구, 교정 칩의 `이렇게도`를 직접 본다.
- 전체 브랜치 코드 리뷰 → 수정 → main 머지 → 8000 서버 재시작(서버 코드 변경).
