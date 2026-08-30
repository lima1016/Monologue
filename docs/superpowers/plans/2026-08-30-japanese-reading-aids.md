# 일본어 읽기 보조 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 일본어 대본과 봇 말풍선에 후리가나·로마자·한국어 뜻을 붙이고, 줄을 클릭하면 그 줄을 소리로 들려준다.

**Architecture:** 읽기는 형태소 사전(`fugashi` + `unidic-lite`)이 서버에서 만들고, 전용 엔드포인트 `POST /api/reading` 하나로 클라이언트에 전달한다. 뜻은 펼칠 때만 `POST /api/translate`가 로컬 LLM으로 만든다. 프론트는 평문을 먼저 그리고 읽기가 도착하면 **덧입힌다** — 그래서 사전이 죽어도 줄은 항상 읽을 수 있다.

**Tech Stack:** Python 3.13 / FastAPI / SQLite / vanilla ES modules. 빌드 도구 없음. 새 의존성은 `fugashi`와 `unidic-lite` 둘뿐.

**Spec:** `docs/superpowers/specs/2026-08-30-japanese-reading-aids-design.md`

## Global Constraints

- **새 의존성은 `fugashi`와 `unidic-lite` 둘만.** jsdom, kuromoji.js, pykakasi, JMdict 등 그 밖의 어떤 것도 추가하지 않는다.
- **읽기 보조는 어디에도 저장하지 않는다.** DB에 쓰지 않고, 시나리오에 넣지 않는다. 캐시는 프로세스 메모리에만, 그리고 **반드시 크기 상한이 있어야 한다.**
- **읽기 경로는 절대 raise하지 않는다.** 사전이 없거나 분석이 실패하면 평문 토큰을 돌려준다. `_speak`(`app/api.py:148`)가 TTS 장애에 대해 갖는 계약과 같다.
- **일본어에만 적용한다.** 영어 세션에는 아무 변화가 없어야 한다.
- 로마자는 **헵번식**: `し`→`shi`, `ち`→`chi`, `つ`→`tsu`, `ふ`→`fu`, `じ`→`ji`.
- 테스트 명령은 정확히: `.\venv\Scripts\python.exe -m pytest -m "not engine"` 와 `node --test "static/js/*.test.js"` — **글롭의 따옴표는 필수다.**
- 기준선: **pytest 203 passed / 8 deselected**, **node 26 passed**.
- 서버가 필요하면 **포트 8010만** 쓰고, 바인딩이 실제로 됐는지 확인한다. **포트 8000은 학습자의 것이고 실제 `monologue.db`를 쥐고 있다 — 건드리지 않는다.** DB가 필요하면 복사본을 쓴다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `app/reading.py` (신규) | 일본어 텍스트 → 토큰(표기·읽기·로마자·루비 분할). 사전과 정렬 규칙을 아는 유일한 곳 |
| `app/api.py` (수정) | `POST /api/reading`, `POST /api/translate` 두 라우트. 대본의 내 줄에도 음성 합성 |
| `app/prompts.py` (수정) | 번역 프롬프트 하나 |
| `static/js/reading.js` (신규) | 순수 렌더러 + 덧입히기. 후리가나/로마자 설정과 뜻 토글을 소유 |
| `static/js/session.js` (수정) | 대본 패널과 봇 말풍선에서 `reading.js`를 부른다. 클릭해서 듣기 |
| `static/index.html` (수정) | 설정 대화상자에 체크박스 둘 |
| `static/css/components.css` (수정) | 루비·로마자·뜻 토글 스타일 |
| `tests/test_reading.py` (신규) | 정렬 규칙과 로마자 |
| `tests/test_api_reading.py` (신규) | 두 라우트 |
| `static/js/reading.test.js` (신규) | 렌더러와 평문 폴백 |

`reading.py`가 정렬 규칙을 아는 **유일한** 모듈이다. 클라이언트는 서버가 확정한 `parts`를 그리기만 한다 — 규칙이 두 곳에 있으면 반드시 갈라진다.

---

### Task 1: `app/reading.py` — 사전, 정렬, 로마자

**Files:**
- Create: `app/reading.py`
- Modify: `requirements.txt`
- Test: `tests/test_reading.py`

**Interfaces:**
- Consumes: 없음 (이 계획의 첫 태스크)
- Produces: `reading.analyse(text: str) -> list[dict]`. 토큰 하나는
  `{"surface": str, "reading": str | None, "romaji": str | None, "parts": [{"text": str, "ruby": str | None}]}`.
  Task 2가 이것을 그대로 응답에 싣는다.

- [ ] **Step 1: `fugashi` 설치 가능성부터 확인한다 — 안 되면 여기서 멈춘다**

이것이 이 태스크의 첫 단계인 이유는 설계 전체가 여기에 얹혀 있기 때문이다. `fugashi`는 C 확장이라 Windows / 파이썬 3.13용 휠이 없으면 컴파일러가 필요하다.

```
.\venv\Scripts\python.exe -m pip install fugashi unidic-lite
.\venv\Scripts\python.exe -c "from fugashi import Tagger; t=Tagger(); print([(w.surface, w.feature.kana) for w in t('食べる')])"
```

기대: `[('食べる', 'タベル')]` 같은 출력.

**설치나 위 확인이 실패하면 즉시 멈추고 보고한다.** 우회하지 말고, 다른 라이브러리로 갈아타지도 말 것 — 대안(`SudachiPy`, `pykakasi`)은 사람이 결정할 사안이다. 실패한 명령과 오류 전문을 그대로 보고하면 된다.

성공하면 `requirements.txt`에 두 줄을 더한다. 설치된 정확한 버전을 `pip show` 로 확인해서 고정한다:

```
fugashi==<설치된 버전>
unidic-lite==<설치된 버전>
```

- [ ] **Step 2: 로마자 변환의 실패하는 테스트를 쓴다**

`tests/test_reading.py`:

```python
from app import reading


def test_romaji_uses_hepburn_for_the_sounds_that_differ():
    """헵번식이 아니면 학습자가 앱 밖에서 본 표기와 어긋난다.
    훈령식은 si/ti/tu로 적지만, 교재와 도로 표지판은 shi/chi/tsu다."""
    assert reading.to_romaji("シ") == "shi"
    assert reading.to_romaji("チ") == "chi"
    assert reading.to_romaji("ツ") == "tsu"
    assert reading.to_romaji("フ") == "fu"
    assert reading.to_romaji("ジ") == "ji"


def test_romaji_handles_youon_as_one_sound():
    """キャ는 ki+ya가 아니라 한 음절이다. 두 글자를 따로 변환하면 kiya가 되어
    학습자가 두 박자로 읽게 된다."""
    assert reading.to_romaji("キャ") == "kya"
    assert reading.to_romaji("ショ") == "sho"
    assert reading.to_romaji("チュ") == "chu"


def test_romaji_doubles_the_consonant_after_a_small_tsu():
    assert reading.to_romaji("ガッコウ") == "gakkou"
    assert reading.to_romaji("キッテ") == "kitte"


def test_romaji_repeats_the_vowel_for_a_long_mark():
    """ー는 앞 모음을 늘인다. 매크론(ō) 대신 모음을 반복하는 편이
    초보에게 가나와의 대응이 눈에 보인다."""
    assert reading.to_romaji("コーヒー") == "koohii"


def test_romaji_returns_none_for_nothing_to_convert():
    assert reading.to_romaji(None) is None
    assert reading.to_romaji("") is None
```

- [ ] **Step 3: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_reading.py -v`
Expected: FAIL — `AttributeError: module 'app.reading' has no attribute 'to_romaji'` (또는 모듈 없음)

- [ ] **Step 4: `app/reading.py`에 로마자 변환을 구현한다**

```python
"""일본어 읽기 보조. 후리가나 정렬과 로마자 변환을 아는 유일한 모듈.

이 모듈의 어떤 함수도 예외를 밖으로 내보내지 않는다. 사전이 없거나 분석이
실패하면 원문을 그대로 담은 평문 토큰을 돌려준다 -- 학습자가 읽어야 할 줄이
비는 것이, 보조가 없는 것보다 나쁘다. app/api.py:148의 _speak가 TTS 장애에
대해 갖는 계약과 같다.
"""
import functools

# 헵번식. 훈령식(si/ti/tu)이 아니라 이쪽인 이유는 교재와 도로 표지판이
# 헵번식이어서, 앱 안에서 배운 표기가 앱 밖에서 그대로 통해야 하기 때문이다.
_DIGRAPHS = {
    "キャ": "kya", "キュ": "kyu", "キョ": "kyo",
    "ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo",
    "シャ": "sha", "シュ": "shu", "ショ": "sho",
    "ジャ": "ja", "ジュ": "ju", "ジョ": "jo",
    "チャ": "cha", "チュ": "chu", "チョ": "cho",
    "ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo",
    "ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo",
    "ビャ": "bya", "ビュ": "byu", "ビョ": "byo",
    "ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
    "ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
    "リャ": "rya", "リュ": "ryu", "リョ": "ryo",
}

_SINGLES = {
    "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o",
    "カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko",
    "ガ": "ga", "ギ": "gi", "グ": "gu", "ゲ": "ge", "ゴ": "go",
    "サ": "sa", "シ": "shi", "ス": "su", "セ": "se", "ソ": "so",
    "ザ": "za", "ジ": "ji", "ズ": "zu", "ゼ": "ze", "ゾ": "zo",
    "タ": "ta", "チ": "chi", "ツ": "tsu", "テ": "te", "ト": "to",
    "ダ": "da", "ヂ": "ji", "ヅ": "zu", "デ": "de", "ド": "do",
    "ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no",
    "ハ": "ha", "ヒ": "hi", "フ": "fu", "ヘ": "he", "ホ": "ho",
    "バ": "ba", "ビ": "bi", "ブ": "bu", "ベ": "be", "ボ": "bo",
    "パ": "pa", "ピ": "pi", "プ": "pu", "ペ": "pe", "ポ": "po",
    "マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo",
    "ヤ": "ya", "ユ": "yu", "ヨ": "yo",
    "ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro",
    "ワ": "wa", "ヲ": "o", "ン": "n",
    "ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o",
    "ヴ": "vu",
}


def to_romaji(kana):
    """카타카나 읽기를 헵번식 로마자로. 변환할 것이 없으면 None."""
    if not kana:
        return None
    out = []
    i = 0
    text = _to_katakana(kana)
    while i < len(text):
        pair = text[i:i + 2]
        if pair in _DIGRAPHS:
            out.append(_DIGRAPHS[pair])
            i += 2
            continue
        ch = text[i]
        if ch == "ッ":
            # 촉음: 다음 음의 첫 자음을 겹친다. 뒤에 아무것도 없으면 버린다.
            nxt = _romaji_of_next(text, i + 1)
            if nxt:
                out.append(nxt[0])
            i += 1
            continue
        if ch == "ー":
            # 장음: 앞 모음을 반복한다. 매크론(ō) 대신 이렇게 하는 이유는
            # 초보에게 가나 한 글자와 로마자의 대응이 눈에 보여야 하기 때문이다.
            if out and out[-1] and out[-1][-1] in "aiueo":
                out.append(out[-1][-1])
            i += 1
            continue
        out.append(_SINGLES.get(ch, ch))
        i += 1
    return "".join(out)


def _romaji_of_next(text, i):
    if i >= len(text):
        return None
    pair = text[i:i + 2]
    if pair in _DIGRAPHS:
        return _DIGRAPHS[pair]
    return _SINGLES.get(text[i])


def _to_katakana(text):
    """히라가나를 카타카나로. 두 글자군은 코드포인트가 0x60 떨어져 있다."""
    return "".join(
        chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in text
    )


def _to_hiragana(text):
    return "".join(
        chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text
    )
```

- [ ] **Step 5: 통과를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_reading.py -v`
Expected: PASS (5개)

- [ ] **Step 6: 커밋한다**

```bash
git add requirements.txt app/reading.py tests/test_reading.py
git commit -m "feat: hepburn romaji for japanese readings"
```

- [ ] **Step 7: 후리가나 정렬의 실패하는 테스트를 쓴다**

`tests/test_reading.py`에 덧붙인다:

```python
def test_ruby_sits_only_over_the_kanji():
    """사전은 토큰 전체의 읽기(タベル)를 준다. 그대로 올리면 이미 읽을 수 있는
    'べる' 위에까지 가나가 붙어, 보조가 오히려 읽기를 방해한다."""
    assert reading.align("食べる", "たべる") == [
        {"text": "食", "ruby": "た"},
        {"text": "べる", "ruby": None},
    ]


def test_ruby_is_not_added_when_there_is_no_kanji():
    assert reading.align("よやく", "よやく") == [{"text": "よやく", "ruby": None}]


def test_a_leading_kana_is_stripped_too():
    assert reading.align("お店", "おみせ") == [
        {"text": "お", "ruby": None},
        {"text": "店", "ruby": "みせ"},
    ]


def test_two_kanji_runs_fall_back_to_rubying_the_whole_token():
    """取り引き처럼 한자 덩어리가 둘이면 어느 읽기가 어느 덩어리 것인지
    가나만으로는 가를 수 없다. 여기서 영리해지려다 틀린 읽기를 만드는 것이
    최악이다 -- 틀린 읽기를 배우면 안 배우느니만 못하다. 통째로 올린 읽기는
    정확하지 않아도 정직하고, 여전히 읽을 수 있다."""
    assert reading.align("取り引き", "とりひき") == [
        {"text": "取り引き", "ruby": "とりひき"}
    ]


def test_a_reading_that_does_not_match_the_surface_falls_back():
    """읽기가 표기와 아귀가 안 맞으면(사전이 이상한 것을 줬거나 표기가 바뀌었거나)
    억지로 자르지 않는다."""
    assert reading.align("東京", "とうきょう") == [
        {"text": "東京", "ruby": "とうきょう"}
    ]


def test_align_with_no_reading_gives_plain_text():
    assert reading.align("ABC", None) == [{"text": "ABC", "ruby": None}]
```

- [ ] **Step 8: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_reading.py -v`
Expected: FAIL — `module 'app.reading' has no attribute 'align'`

- [ ] **Step 9: 정렬을 구현한다**

`app/reading.py`에 덧붙인다:

```python
def _is_kana(ch):
    return "ぁ" <= ch <= "ゖ" or "ァ" <= ch <= "ヺ" or ch == "ー"


def align(surface, reading_kana):
    """읽기를 표기 위에 앉힌다. 규칙은 설계 문서에 있다:

    1. 읽기를 히라가나로 맞춘다
    2. 표기와 읽기에서 앞뒤로 일치하는 가나를 벗겨낸다
    3. 남은 표기가 한자 한 덩어리면 그 위에 남은 읽기를 올린다
    4. 남은 표기에 한자가 없으면 루비를 붙이지 않는다
    5. 그 밖의 모든 경우 -- 한자 덩어리가 둘 이상이거나, 읽기가 표기와
       아귀가 안 맞거나 -- 토큰 전체 위에 읽기를 통째로 올린다

    5번이 이 함수의 안전망이다. 어떤 입력에도 '틀린 위치의 읽기'를 만들지
    않는다.
    """
    if not reading_kana:
        return [{"text": surface, "ruby": None}]

    kana_reading = _to_hiragana(reading_kana)
    kana_surface = _to_hiragana(surface)

    if kana_surface == kana_reading:  # 한자가 없다
        return [{"text": surface, "ruby": None}]

    head = 0
    while (head < len(surface) and head < len(kana_reading)
           and _is_kana(surface[head]) and kana_surface[head] == kana_reading[head]):
        head += 1

    tail = 0
    while (tail < len(surface) - head and tail < len(kana_reading) - head
           and _is_kana(surface[-1 - tail])
           and kana_surface[-1 - tail] == kana_reading[-1 - tail]):
        tail += 1

    core = surface[head:len(surface) - tail]
    core_reading = kana_reading[head:len(kana_reading) - tail]

    # 남은 표기 안에 가나가 섞여 있으면 한자 덩어리가 둘 이상이라는 뜻이다.
    if not core or not core_reading or any(_is_kana(c) for c in core):
        return [{"text": surface, "ruby": kana_reading}]

    parts = []
    if head:
        parts.append({"text": surface[:head], "ruby": None})
    parts.append({"text": core, "ruby": core_reading})
    if tail:
        parts.append({"text": surface[len(surface) - tail:], "ruby": None})
    return parts
```

- [ ] **Step 10: 통과를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_reading.py -v`
Expected: PASS (11개)

- [ ] **Step 11: 커밋한다**

```bash
git add app/reading.py tests/test_reading.py
git commit -m "feat: align furigana onto the kanji, with an honest fallback"
```

- [ ] **Step 12: `analyse`의 실패하는 테스트를 쓴다**

```python
def test_analyse_returns_one_token_per_word_with_parts():
    tokens = reading.analyse("寿司を食べる")
    assert [t["surface"] for t in tokens] == ["寿司", "を", "食べる"]
    assert tokens[0]["parts"] == [{"text": "寿司", "ruby": "すし"}]
    assert tokens[1]["parts"] == [{"text": "を", "ruby": None}]
    assert tokens[2]["parts"] == [{"text": "食", "ruby": "た"},
                                  {"text": "べる", "ruby": None}]
    assert tokens[0]["romaji"] == "sushi"


def test_analyse_never_raises_when_the_dictionary_is_unavailable(monkeypatch):
    """사전이 없다고 학습자의 줄이 비면 안 된다. 보조가 없는 것과
    줄이 사라지는 것은 다른 문제다."""
    monkeypatch.setattr(reading, "_tagger", _boom)
    tokens = reading.analyse("寿司を食べる")
    assert tokens == [{"surface": "寿司を食べる", "reading": None, "romaji": None,
                       "parts": [{"text": "寿司を食べる", "ruby": None}]}]


def _boom():
    raise RuntimeError("no dictionary")


def test_analyse_of_empty_text_is_empty():
    assert reading.analyse("") == []
```

- [ ] **Step 13: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_reading.py -v`
Expected: FAIL — `module 'app.reading' has no attribute 'analyse'`

- [ ] **Step 14: `analyse`를 구현한다**

```python
@functools.lru_cache(maxsize=1)
def _tagger():
    """Tagger는 사전을 통째로 메모리에 올리므로 한 번만 만든다.
    lru_cache가 프로세스당 1회를 보장한다."""
    from fugashi import Tagger
    return Tagger()


def analyse(text):
    """일본어 문장을 토큰 목록으로. 절대 raise하지 않는다."""
    if not text:
        return []
    try:
        words = list(_tagger()(text))
    except Exception:
        return [_plain(text)]

    tokens = []
    for word in words:
        kana = getattr(word.feature, "kana", None)
        if not kana or kana == "*":
            tokens.append(_plain(word.surface))
            continue
        hira = _to_hiragana(kana)
        tokens.append({
            "surface": word.surface,
            "reading": hira,
            "romaji": to_romaji(kana),
            "parts": align(word.surface, hira),
        })
    return tokens


def _plain(text):
    return {"surface": text, "reading": None, "romaji": None,
            "parts": [{"text": text, "ruby": None}]}
```

- [ ] **Step 15: 전체 테스트를 돌린다**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine"`
Expected: 203 + 14 = **217 passed / 8 deselected**

- [ ] **Step 16: 커밋한다**

```bash
git add app/reading.py tests/test_reading.py
git commit -m "feat: tokenise japanese text into reading aids"
```

---

### Task 2: `POST /api/reading`

**Files:**
- Modify: `app/api.py`
- Test: `tests/test_api_reading.py` (신규)

**Interfaces:**
- Consumes: `reading.analyse(text) -> list[dict]` (Task 1)
- Produces: `POST /api/reading` — 요청 `{"language": "ja", "texts": [str, ...]}`, 응답 `{"readings": [[token, ...], ...]}`. `readings[i]`는 `texts[i]`에 대응한다. Task 5의 `reading.js`가 이 모양을 소비한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/test_api_reading.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    return TestClient(app)


def test_reading_returns_one_entry_per_text_in_order(client):
    """줄 하나가 아니라 그리는 줄 전부를 한 번에 받는다. 대본 8줄이면 요청 하나다."""
    res = client.post("/api/reading",
                      json={"language": "ja", "texts": ["寿司", "よやく"]})
    assert res.status_code == 200
    readings = res.json()["readings"]
    assert len(readings) == 2
    assert readings[0][0]["parts"] == [{"text": "寿司", "ruby": "すし"}]
    assert readings[1][0]["parts"] == [{"text": "よやく", "ruby": None}]


def test_reading_rejects_a_language_that_has_no_reading_problem(client):
    """영어에는 읽기 보조가 없다. 조용히 빈 배열을 주면 프론트의 버그가
    '보조가 원래 안 붙는 언어'처럼 보여 숨는다."""
    res = client.post("/api/reading", json={"language": "en", "texts": ["hello"]})
    assert res.status_code == 400


def test_reading_of_an_empty_list_is_an_empty_list(client):
    res = client.post("/api/reading", json={"language": "ja", "texts": []})
    assert res.status_code == 200
    assert res.json()["readings"] == []
```

- [ ] **Step 2: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_reading.py -v`
Expected: FAIL — 404 (라우트가 없다)

- [ ] **Step 3: 라우트를 구현한다**

`app/api.py`의 import에 `reading`을 더한다:

```python
from app import config, db, llm, prompts, reading, scenarios, tts
```

`@router.post("/tts/preview")` 바로 뒤에 넣는다:

```python
class ReadingRequest(BaseModel):
    language: Language
    texts: list[str]


@router.post("/reading")
def line_readings(payload: ReadingRequest):
    """그리려는 일본어 줄들의 후리가나·로마자.

    줄 단위가 아니라 화면 단위로 받는 이유는, 세션 payload마다 reading 필드를
    붙이는 대신 이 하나만 두기 위해서다 -- 이어서 하기 재생이 addMessage를
    그대로 쓰므로 그 경로가 공짜로 덮인다.
    """
    if payload.language != "ja":
        raise HTTPException(400, "reading aids are only for Japanese")
    return {"readings": [_cached_reading(t) for t in payload.texts]}


@functools.lru_cache(maxsize=512)
def _cached_reading_tuple(text: str) -> tuple:
    # 읽기는 결정적이고 텍스트는 반복된다(이어서 하기 때 같은 줄이 다시 온다).
    # 상한이 있어야 한다 -- 자유 대화는 매 턴 새 문장을 만들므로 무제한 캐시는
    # 세션이 길어질수록 자라기만 한다.
    return tuple(json.dumps(t, ensure_ascii=False) for t in reading.analyse(text))


def _cached_reading(text: str) -> list[dict]:
    return [json.loads(t) for t in _cached_reading_tuple(text)]
```

`app/api.py` 맨 위 import에 `functools`를 더한다 (`json`은 이미 있다).

- [ ] **Step 4: 통과를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_reading.py -v`
Expected: PASS (3개)

- [ ] **Step 5: 커밋한다**

```bash
git add app/api.py tests/test_api_reading.py
git commit -m "feat: one endpoint for the readings of every line on screen"
```

---

### Task 3: `POST /api/translate`

**Files:**
- Modify: `app/api.py`, `app/prompts.py`
- Test: `tests/test_api_reading.py`

**Interfaces:**
- Consumes: `llm.chat(messages) -> str`, `prompts.build_translate_messages(text) -> list[dict]`
- Produces: `POST /api/translate` — 요청 `{"language": "ja", "text": str}`, 응답 `{"meaning": str}`. Task 5의 뜻 토글이 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/test_api_reading.py`에 덧붙인다:

```python
def test_translate_returns_one_korean_line(client, monkeypatch):
    from app import llm
    monkeypatch.setattr(llm, "chat", lambda messages, **kw: "어서 오세요")
    res = client.post("/api/translate",
                      json={"language": "ja", "text": "いらっしゃいませ"})
    assert res.status_code == 200
    assert res.json()["meaning"] == "어서 오세요"


def test_translate_is_cached_so_reopening_a_line_is_free(client, monkeypatch):
    """같은 줄을 다시 펼치거나 이어서 하기로 돌아와도 14b를 다시 부르지 않는다."""
    from app import api, llm
    api._cached_translation.cache_clear()
    calls = []

    def counting_chat(messages, **kw):
        calls.append(messages)
        return "어서 오세요"

    monkeypatch.setattr(llm, "chat", counting_chat)
    body = {"language": "ja", "text": "いらっしゃいませ"}
    client.post("/api/translate", json=body)
    client.post("/api/translate", json=body)
    assert len(calls) == 1


def test_translate_says_so_when_the_model_is_down(client, monkeypatch):
    """503이어야 한다. 빈 문자열을 주면 프론트가 '뜻이 없는 줄'로 그려서
    모델이 죽은 것과 뜻이 원래 없는 것이 화면에서 구분되지 않는다."""
    from app import api, llm
    api._cached_translation.cache_clear()

    def boom(messages, **kw):
        raise RuntimeError("ollama is down")

    monkeypatch.setattr(llm, "chat", boom)
    res = client.post("/api/translate", json={"language": "ja", "text": "こんにちは"})
    assert res.status_code == 503


def test_translate_rejects_a_language_that_needs_no_translation(client):
    res = client.post("/api/translate", json={"language": "en", "text": "hello"})
    assert res.status_code == 400
```

- [ ] **Step 2: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_reading.py -v`
Expected: FAIL — 404

- [ ] **Step 3: 프롬프트를 더한다**

`app/prompts.py` 끝에:

```python
TRANSLATE_SYSTEM = """당신은 일본어를 한국어로 옮기는 번역가입니다.

주어진 일본어 문장의 뜻을 자연스러운 한국어 한 줄로만 답하세요.
설명, 문법 풀이, 로마자, 원문 반복을 넣지 마세요. 번역문만 답하세요."""


def build_translate_messages(text) -> list[dict]:
    """한 줄짜리 뜻을 요청한다.

    시스템 프롬프트가 한국어인 것은 style이 아니라 fix다 -- build_feedback_messages의
    docstring에 적힌 것과 같은 이유로, 이 로컬 모델은 자기가 불린 언어로 답한다.
    영어로 "answer in Korean"이라고 쓰면 영어 답이 섞여 나온다.
    """
    return [
        {"role": "system", "content": TRANSLATE_SYSTEM},
        {"role": "user", "content": text},
    ]
```

- [ ] **Step 4: 라우트를 구현한다**

`app/api.py`의 `/reading` 뒤에:

```python
class TranslateRequest(BaseModel):
    language: Language
    text: str


@router.post("/translate")
def translate_line(payload: TranslateRequest):
    """한 줄의 한국어 뜻. 학습자가 펼칠 때만 불린다.

    미리 번역하지 않는 이유는 두 가지다: 대본 8줄을 선번역하면 시작이 그만큼
    느려지고, 펼쳐보지도 않을 줄까지 번역하게 된다. 먼저 짐작하고 확인하는
    편이 학습에 남는다는 것도 같은 방향이다.
    """
    if payload.language != "ja":
        raise HTTPException(400, "translation is only offered for Japanese")
    meaning = _cached_translation(payload.text)
    if meaning is None:
        raise HTTPException(503, "번역할 수 없습니다")
    return {"meaning": meaning}


@functools.lru_cache(maxsize=512)
def _cached_translation(text: str) -> str | None:
    """None은 캐시되지 않아야 할 것 같지만, 캐시된다 -- 그리고 그래도 된다.
    모델이 죽어 있는 동안 같은 줄을 반복해서 펼쳐도 매번 14b를 두드리지
    않는다. 모델이 살아나면 서버를 재시작하거나 다른 줄을 펼치면 되고,
    이것은 실패한 번역이지 잘못된 번역이 아니다."""
    try:
        return llm.chat(prompts.build_translate_messages(text), temperature=0.2).strip()
    except Exception:
        return None
```

- [ ] **Step 5: 통과를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_reading.py -v`
Expected: PASS (7개)

- [ ] **Step 6: 전체를 돌리고 커밋한다**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine"`
Expected: **224 passed / 8 deselected**

```bash
git add app/api.py app/prompts.py tests/test_api_reading.py
git commit -m "feat: translate one line on demand, cached"
```

---

### Task 4: 대본의 내 줄에도 음성을 붙인다

**Files:**
- Modify: `app/api.py:243`
- Test: `tests/test_api_chat.py`

**Interfaces:**
- Consumes: 없음
- Produces: `POST /sessions`의 script 응답에서 **모든** 줄이 `audio_key`를 갖는다(TTS가 살아 있을 때). Task 6의 클릭해서 듣기가 이것에 기댄다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/test_api_chat.py`에 덧붙인다:

```python
def test_a_script_gives_the_learner_their_own_lines_as_audio(client):
    """내 차례 줄을 미리 듣고 따라 읽는 것이 클릭해서 듣기의 목적이다.
    봇 줄에만 음성이 있으면 기능이 반쪽이 된다."""
    res = client.post("/api/sessions", json={
        "language": "en", "mode": "script", "scenario_id": "standup-meeting-en",
    })
    assert res.status_code == 200
    lines = res.json()["lines"]
    assert any(line["speaker"] == "user" for line in lines)
    assert all(line["audio_key"] for line in lines)
```

`fake_engines` fixture(`tests/test_api_chat.py:20`, autouse)가 `tts.synthesize`를 `lambda t, l, v: b"RIFFfake"`로 바꿔두므로 실제 음성 엔진은 돌지 않지만 `synthesize_to_cache`는 그대로 실행되어 진짜 캐시 키를 만든다. 따라서 `audio_key`는 truthy한 해시 문자열이고 위의 `assert`가 그대로 성립한다. **fixture는 건드리지 않는다.**

`standup-meeting-en`은 봇 줄과 내 줄이 섞인 내장 script 시나리오다(`data/scenarios.json`). TTS 캐시는 내용 해시로 키를 만들므로 서로 다른 문장은 서로 다른 키를 받는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_chat.py -k script_gives -v`
Expected: FAIL — user 줄의 `audio_key`가 None이다

- [ ] **Step 3: 조건을 지운다**

`app/api.py:243`:

```python
# 전:
key = _speak(line["text"], payload.language) if line["speaker"] == "bot" else None
# 후:
key = _speak(line["text"], payload.language)
```

바로 위에 주석을 남긴다:

```python
# 화자를 가리지 않는다. 학습자가 자기 차례 줄을 미리 듣고 따라 읽는 것이
# 대본 모드의 핵심 동작이고, 그러려면 내 줄에도 음성이 있어야 한다. 대본은
# 8줄 남짓이고 tts는 캐시되므로 전부 선합성해도 비용은 무시할 만하다.
```

- [ ] **Step 4: 통과를 확인하고 커밋한다**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine"`
Expected: **225 passed / 8 deselected**

```bash
git add app/api.py tests/test_api_chat.py
git commit -m "feat: synthesise the learner's own script lines too"
```

---

### Task 5: `static/js/reading.js` — 순수 렌더러와 덧입히기

**Files:**
- Create: `static/js/reading.js`
- Create: `static/js/reading.test.js`

**Interfaces:**
- Consumes: `postJSON` (`api.js`), `POST /api/reading` (Task 2), `POST /api/translate` (Task 3)
- Produces:
  - `renderTokens(tokens, prefs) -> string` — 순수 함수. `prefs`는 `{furigana: bool, romaji: bool}`
  - `annotate(entries) -> Promise<void>` — `entries`는 `[{el, text}]`. 한 번의 요청으로 전부 덧입힌다
  - `setPrefs({furigana, romaji})` / `getPrefs()`
  - Task 6이 `annotate`를 부른다

- [ ] **Step 1: 렌더러의 실패하는 테스트를 쓴다**

`static/js/reading.test.js`:

```js
/* 읽기 보조의 렌더러. 가장 중요한 테스트는 마지막 것이다 -- 요청이 실패해도
   줄이 평문으로 남아야 한다. 학습자가 읽어야 할 줄이 비는 것은 보조가 없는
   것보다 나쁘다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { jsonResponse, resetDom, stubFetch } from './dom-shim.js';
import { renderTokens } from './reading.js';

const ALL = { furigana: true, romaji: true };

test('a kanji token gets ruby over the kanji only', () => {
  const tokens = [{
    surface: '食べる', reading: 'たべる', romaji: 'taberu',
    parts: [{ text: '食', ruby: 'た' }, { text: 'べる', ruby: null }],
  }];
  const html = renderTokens(tokens, ALL);
  assert.match(html, /<ruby>食<rt>た<\/rt><\/ruby>/);
  assert.match(html, /べる/);
  assert.doesNotMatch(html, /<rt>たべる<\/rt>/);
});

test('a token with no ruby renders as plain text', () => {
  const tokens = [{
    surface: 'よやく', reading: 'よやく', romaji: 'yoyaku',
    parts: [{ text: 'よやく', ruby: null }],
  }];
  assert.doesNotMatch(renderTokens(tokens, ALL), /<ruby>/);
});

test('furigana off keeps the text and drops the ruby', () => {
  const tokens = [{
    surface: '食べる', reading: 'たべる', romaji: 'taberu',
    parts: [{ text: '食', ruby: 'た' }, { text: 'べる', ruby: null }],
  }];
  const html = renderTokens(tokens, { furigana: false, romaji: true });
  assert.doesNotMatch(html, /<ruby>/);
  assert.match(html, /食べる/);
});

test('romaji off drops the romaji line but keeps the japanese', () => {
  const tokens = [{
    surface: '寿司', reading: 'すし', romaji: 'sushi',
    parts: [{ text: '寿司', ruby: 'すし' }],
  }];
  const html = renderTokens(tokens, { furigana: true, romaji: false });
  assert.doesNotMatch(html, /sushi/);
  assert.match(html, /寿司/);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test "static/js/reading.test.js"`
Expected: FAIL — `Cannot find module .../reading.js`

- [ ] **Step 3: 렌더러를 구현한다**

`static/js/reading.js`:

```js
/* 일본어 읽기 보조를 화면에 얹는 층.
 *
 * 핵심 계약: 먼저 평문을 그리고 나중에 덧입힌다. 이 모듈이 하는 일이 실패해도
 * -- 사전이 죽었든, 요청이 실패했든, 느리든 -- 줄은 항상 읽을 수 있는 상태로
 * 남아야 한다. 덧입히기가 안 될 뿐이다. 학습자가 읽어야 할 줄이 비는 것은
 * 보조가 없는 것보다 나쁘다.
 *
 * 후리가나 정렬 규칙은 여기에 없다. 서버(app/reading.py)가 확정한 `parts`를
 * 순서대로 그리기만 한다 -- 규칙이 두 곳에 있으면 반드시 갈라진다.
 */
import { postJSON } from './api.js';

let prefs = { furigana: true, romaji: true };

export function getPrefs() { return { ...prefs }; }
export function setPrefs(next) { prefs = { ...prefs, ...next }; }

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderTokens(tokens, options = prefs) {
  const body = tokens.map((t) => t.parts.map((p) => {
    const text = escapeHtml(p.text);
    if (!p.ruby || !options.furigana) return text;
    return `<ruby>${text}<rt>${escapeHtml(p.ruby)}</rt></ruby>`;
  }).join('')).join('');

  const romaji = options.romaji
    ? tokens.map((t) => t.romaji || t.surface).join(' ').trim()
    : '';

  return `<span class="ja">${body}</span>`
    + (romaji ? `<span class="romaji">${escapeHtml(romaji)}</span>` : '')
    + '<button class="meaning" type="button">▸ 뜻</button>'
    + '<span class="meaning-body" hidden></span>';
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --test "static/js/reading.test.js"`
Expected: PASS (4개)

- [ ] **Step 5: 덧입히기의 실패하는 테스트를 쓴다 — 폴백이 핵심이다**

`static/js/reading.test.js`에 덧붙인다:

```js
test('annotate upgrades every element in one request', async () => {
  resetDom();
  const { annotate } = await import('./reading.js');
  const requests = [];
  stubFetch(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ readings: [
      [{ surface: '寿司', reading: 'すし', romaji: 'sushi',
         parts: [{ text: '寿司', ruby: 'すし' }] }],
      [{ surface: '茶', reading: 'ちゃ', romaji: 'cha',
         parts: [{ text: '茶', ruby: 'ちゃ' }] }],
    ] });
  });

  const a = document.createElement('li');
  const b = document.createElement('li');
  await annotate([{ el: a, text: '寿司' }, { el: b, text: '茶' }]);

  assert.equal(requests.length, 1, '화면 단위로 한 번만 요청해야 한다');
  assert.deepEqual(requests[0].body.texts, ['寿司', '茶']);
  assert.match(a.innerHTML, /<rt>すし<\/rt>/);
  assert.match(b.innerHTML, /<rt>ちゃ<\/rt>/);
});

test('a failed reading request leaves the line readable', async () => {
  /* 이 테스트가 이 기능에서 가장 중요하다. 사전이 죽거나 요청이 실패했을 때
     학습자가 잃는 것은 보조여야지, 줄이어서는 안 된다. */
  resetDom();
  const { annotate } = await import('./reading.js');
  stubFetch(async () => jsonResponse({ detail: 'boom' }, { ok: false, status: 500 }));

  const el = document.createElement('li');
  el.textContent = 'いらっしゃいませ';
  await annotate([{ el, text: 'いらっしゃいませ' }]);

  assert.equal(el.textContent, 'いらっしゃいませ');
  assert.equal(el.innerHTML, '', '덧입히기가 실패하면 아무것도 덮어쓰지 않는다');
});

test('annotate asks for nothing when there is nothing to annotate', async () => {
  resetDom();
  const { annotate } = await import('./reading.js');
  let called = false;
  stubFetch(async () => { called = true; return jsonResponse({ readings: [] }); });
  await annotate([]);
  assert.equal(called, false);
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `node --test "static/js/reading.test.js"`
Expected: FAIL — `annotate is not a function`

- [ ] **Step 7: `annotate`를 구현한다**

`static/js/reading.js`에 덧붙인다:

```js
/* entries: [{ el, text }]. 화면에 새로 그려진 일본어 줄 전부를 한 번에 넘긴다.
   요청이 실패하면 조용히 돌아간다 -- el은 이미 평문을 들고 있고, 그것이
   이 함수가 지켜야 할 최소치다. */
export async function annotate(entries) {
  if (!entries.length) return;
  let readings;
  try {
    const res = await postJSON('/reading', {
      language: 'ja',
      texts: entries.map((e) => e.text),
    });
    readings = res.readings;
  } catch {
    return; // 평문이 그대로 남는다
  }
  entries.forEach((entry, i) => {
    const tokens = readings[i];
    if (!tokens || !tokens.length) return;
    entry.el.innerHTML = renderTokens(tokens);
    entry.el.dataset.ja = entry.text;
  });
}
```

- [ ] **Step 8: 통과를 확인한다**

Run: `node --test "static/js/*.test.js"`
Expected: **33 passed** (26 + 7)

- [ ] **Step 9: 커밋한다**

```bash
git add static/js/reading.js static/js/reading.test.js
git commit -m "feat: render reading aids over a line, degrading to plain text"
```

- [ ] **Step 10: 뜻 토글의 실패하는 테스트를 쓴다**

```js
test('the meaning toggle fetches once and then just reopens', async () => {
  resetDom();
  const { annotate, toggleMeaning } = await import('./reading.js');
  let translateCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/translate')) {
      translateCalls += 1;
      return jsonResponse({ meaning: '어서 오세요' });
    }
    return jsonResponse({ readings: [[{
      surface: 'いらっしゃいませ', reading: 'いらっしゃいませ', romaji: 'irasshaimase',
      parts: [{ text: 'いらっしゃいませ', ruby: null }],
    }]] });
  });

  const el = document.createElement('li');
  await annotate([{ el, text: 'いらっしゃいませ' }]);

  const body = document.createElement('span');
  await toggleMeaning(el, body);
  assert.equal(body.textContent, '어서 오세요');
  assert.equal(body.hidden, false);

  await toggleMeaning(el, body);          // 접는다
  assert.equal(body.hidden, true);
  await toggleMeaning(el, body);          // 다시 편다
  assert.equal(translateCalls, 1, '두 번째 펼침은 요청 없이 열려야 한다');
});

test('a failed translation says so instead of blanking the line', async () => {
  resetDom();
  const { toggleMeaning } = await import('./reading.js');
  stubFetch(async () => jsonResponse({ detail: 'down' }, { ok: false, status: 503 }));

  const el = document.createElement('li');
  el.dataset.ja = 'こんにちは';
  const body = document.createElement('span');
  await toggleMeaning(el, body);

  assert.match(body.textContent, /뜻을 가져오지 못했습니다/);
  assert.equal(el.dataset.ja, 'こんにちは', '원문은 그대로 남는다');
});
```

- [ ] **Step 11: 실패를 확인하고 구현한다**

Run: `node --test "static/js/reading.test.js"` → FAIL (`toggleMeaning is not a function`)

`static/js/reading.js`에 덧붙인다:

```js
/* 뜻은 el.dataset.meaning에 한 번만 담아두고, 그 뒤로는 열고 닫기만 한다.
   서버도 캐시하지만 여기서 한 번 더 막는 이유는, 왕복 자체를 없애야 접었다
   폈다 하는 동작이 즉각적으로 느껴지기 때문이다. */
export async function toggleMeaning(el, body) {
  if (body.textContent) {
    body.hidden = !body.hidden;
    return;
  }
  try {
    const { meaning } = await postJSON('/translate', {
      language: 'ja',
      text: el.dataset.ja,
    });
    body.textContent = meaning;
  } catch {
    body.textContent = '뜻을 가져오지 못했습니다.';
  }
  body.hidden = false;
}
```

- [ ] **Step 12: 통과를 확인하고 커밋한다**

Run: `node --test "static/js/*.test.js"`
Expected: **35 passed**

```bash
git add static/js/reading.js static/js/reading.test.js
git commit -m "feat: expand a line's korean meaning on demand"
```

---

### Task 6: 대본 패널과 봇 말풍선에 붙이고, 클릭하면 들리게 한다

**Files:**
- Modify: `static/js/session.js` (`startScript`, `addMessage`), `static/js/main.js`
- Modify: `static/css/components.css`

**Interfaces:**
- Consumes: `annotate(entries)`, `toggleMeaning(el, body)` (Task 5); script 줄의 `audio_key` (Task 4)
- Produces: 없음 (마지막 배선)

- [ ] **Step 1: 대본 패널에 덧입힌다**

`static/js/session.js`의 `startScript`에서, `$('panel-body').innerHTML = ...` 직후에 넣는다:

```js
  if (state.language === 'ja') {
    const items = [...$('panel-body').querySelectorAll('li .line')];
    annotate(items.map((el, i) => ({ el, text: lines[i].text })));
  }
```

이를 위해 `<li>` 마크업을 바꾼다 — 화자 라벨은 덧입히기 대상이 아니므로 본문을 `<span class="line">`으로 감싼다:

```js
  $('panel-body').innerHTML = `<ol>${lines
    .map((l, i) => `<li data-i="${i}"><b>${l.speaker === 'bot' ? '봇' : '나'}</b> `
      + `<span class="line">${l.text}</span></li>`)
    .join('')}</ol>`;
```

`session.js` 맨 위에 import를 더한다:

```js
import { annotate, toggleMeaning } from './reading.js';
```

- [ ] **Step 2: 봇 말풍선에 덧입힌다**

`addMessage`의 끝, `return bubble` 직전에:

```js
  // 자유·수업 모드의 봇 문장도 학습자가 못 읽는 것은 대본과 똑같다.
  // 이어서 하기 재생도 이 함수를 그대로 쓰므로 그 경로가 함께 덮인다.
  if (who === 'bot' && state.language === 'ja') {
    annotate([{ el: bubble, text }]);
  }
```

- [ ] **Step 3: 봇 말풍선에 음성 키를 남긴다**

`addMessage`가 음성 키를 받을 수 있게 세 번째 인자를 더한다:

```js
export function addMessage(who, text, audioKey = null) {
  ...
  if (audioKey) bubble.dataset.audioKey = audioKey;
```

봇 줄을 그리는 호출부는 넷이고, 셋만 키를 갖고 있다:

| 위치 | 고치는 내용 |
|---|---|
| `session.js:146` | `addMessage('bot', data.opening)` → `addMessage('bot', data.opening, data.opening_audio)` |
| `session.js:305` | `addMessage('bot', data.bot_reply)` → `addMessage('bot', data.bot_reply, data.audio_key)` |
| `session.js:420` | `addMessage('bot', line.text)` → `addMessage('bot', line.text, line.audio_key)` |
| `home.js:137` | **그대로 둔다** — 이어서 하기 재생은 DB의 메시지를 다시 그리는 것이라 음성 키가 없다 |

`home.js:137`을 고치지 않는 것은 누락이 아니라 결정이다. 되살아난 봇 말풍선을 클릭하면 `play(null, text)`가 되어 브라우저 음성으로 읽힌다 — 서버 음성이 없을 때 앱이 이미 갖고 있는 계약 그대로다(`audio.js`의 `play`). 지난 세션의 음성 파일을 되살리는 것은 이 태스크의 범위가 아니다.

- [ ] **Step 4: 클릭해서 듣기를 배선한다**

`static/js/main.js`에, 기존 `conversation` 핸들러 **아래**에:

```js
// 봇 말풍선만이다. 내 말풍선의 클릭은 이미 되돌리기가 쓰고 있고(위 핸들러),
// 한 클릭에 두 동작을 얹으면 되돌리려다 소리가 나거나 그 반대가 된다.
// 대본 패널에는 되돌리기가 없으므로 거기서는 양쪽 줄 다 눌러 들을 수 있다.
$('conversation').addEventListener('click', (e) => {
  // 뜻 토글이 먼저다. renderTokens가 말풍선 안에도 '▸ 뜻' 버튼을 그리므로,
  // 대본 패널과 똑같이 여기서도 받아줘야 한다 -- 안 그러면 대화창의 뜻만
  // 눌러도 아무 일이 없는 반쪽짜리가 된다.
  const meaning = e.target.closest('button.meaning');
  if (meaning) {
    const bubble = meaning.closest('.msg.bot');
    toggleMeaning(bubble, bubble.querySelector('.meaning-body'));
    return;
  }
  const bubble = e.target.closest('.msg.bot');
  if (!bubble || e.target.closest('button')) return;
  play(bubble.dataset.audioKey || null, bubble.dataset.ja || bubble.textContent);
});

$('panel-body').addEventListener('click', (e) => {
  const meaning = e.target.closest('button.meaning');
  if (meaning) {
    const li = meaning.closest('li');
    toggleMeaning(li.querySelector('.line'), li.querySelector('.meaning-body'));
    return;
  }
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const line = state.scriptLines[Number(li.dataset.i)];
  if (line) play(line.audio_key, line.text);
});
```

`main.js`의 import에 `play`와 `toggleMeaning`을 더한다.

- [ ] **Step 5: 스타일을 더한다**

`static/css/components.css` 끝에:

```css
/* 읽기 보조. 루비는 브라우저 기본 기능이라 라이브러리가 필요 없다. */
rt { font-size: .55em; color: var(--text-dim); font-weight: 400; }
.romaji { display: block; font-size: var(--text-xs); color: var(--text-dim);
          letter-spacing: .01em; margin-top: 2px; }
/* 루비가 붙은 줄은 위로 자란다. 줄 간격을 넉넉히 주지 않으면 윗줄의
   후리가나와 아랫줄의 본문이 서로 닿는다. */
.line, .msg.bot { line-height: 2.1; }
button.meaning { font-size: var(--text-xs); padding: 0 var(--space-1);
                 background: none; border: none; color: var(--text-dim); }
button.meaning:hover { color: var(--accent-ink); }
.meaning-body { display: block; font-size: var(--text-sm); color: var(--text); }
```

- [ ] **Step 6: 전체 테스트를 돌린다**

```
.\venv\Scripts\python.exe -m pytest -m "not engine"
node --test "static/js/*.test.js"
```
Expected: **225 passed / 8 deselected**, node **35 passed**

`reading.js`를 위한 모듈 그래프 테스트를 따로 쓸 필요는 없다 — `main.test.js`가 진짜 `main.js`를 import하고, 이제 그 그래프가 `session.js` → `reading.js`를 거치므로 새 모듈의 평가 오류는 자동으로 잡힌다. 마찬가지로 같은 파일의 id 스캔이, JS가 `index.html`에 없는 id를 참조하면 실패한다. **두 테스트가 초록인지 확인하고, 빨개지면 그것이 진짜 신호다.**

- [ ] **Step 7: 브라우저로 확인한다**

포트 **8010**에, **`monologue.db`의 복사본**으로 띄운다. 포트 8000은 학습자의 것이고 실제 DB를 쥐고 있으므로 건드리지 않는다. 바인딩이 실제로 됐는지(응답하는 프로세스가 방금 띄운 그것인지) 확인한다.

확인할 것:
- 일본어 **대본** 모드: 한자 위에 후리가나, 아래에 로마자, `▸ 뜻` 토글
- 대본 줄 클릭 → 소리. **내 줄도** 들린다
- `▸ 뜻` 클릭 → 한국어가 펼쳐진다. 다시 눌러 접고, 또 눌러 펴도 요청이 한 번뿐이다
- 일본어 **자유** 모드: 봇 말풍선에도 보조가 붙고, **거기서도 `▸ 뜻`이 동작한다**
- 봇 말풍선 클릭 → 소리. **내 말풍선 클릭은 여전히 되돌리기다** (한 번 눌러 확인할 것)
- **영어 세션에는 아무 변화가 없다**
- 콘솔에 오류·경고 없음

VOICEVOX가 꺼져 있으면 일본어 음성은 브라우저 음성으로 대체된다 — 그것은 결함이 아니다. 그 경우 **소리가 나는지**만 확인하고 품질은 보지 않는다.

- [ ] **Step 8: 커밋한다**

```bash
git add static/js/session.js static/js/main.js static/css/components.css
git commit -m "feat: show reading aids on scripts and bot lines, click to hear"
```

---

### Task 7: 설정 — 후리가나·로마자 끄기

**Files:**
- Modify: `static/index.html`, `static/js/settings.js`, `static/js/main.js`, `app/api.py`
- Test: `tests/test_api_reading.py`

**Interfaces:**
- Consumes: `setPrefs({furigana, romaji})` (Task 5), `db.get_setting` / `db.set_setting`
- Produces: 없음 (마지막 태스크)

- [ ] **Step 1: 저장의 실패하는 테스트를 쓴다**

`tests/test_api_reading.py`에 덧붙인다:

```python
def test_reading_prefs_default_to_both_on(client):
    """기본은 셋 다 켜짐이다(뜻만 접힘). 완전 초보가 첫 화면에서
    아무것도 설정하지 않고도 읽을 수 있어야 한다."""
    res = client.get("/api/reading-prefs")
    assert res.status_code == 200
    assert res.json() == {"furigana": True, "romaji": True}


def test_reading_prefs_round_trip(client):
    """로마자를 끄는 것은 '가나를 읽을 수 있게 됐다'는 신호다.
    목발을 순서대로 치우는 것이 이 기능의 설계다."""
    client.post("/api/reading-prefs", json={"furigana": True, "romaji": False})
    assert client.get("/api/reading-prefs").json() == {
        "furigana": True, "romaji": False,
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest tests/test_api_reading.py -k prefs -v`
Expected: FAIL — 404

- [ ] **Step 3: 라우트를 구현한다**

`app/api.py`, `/translate` 뒤에:

```python
class ReadingPrefs(BaseModel):
    furigana: bool
    romaji: bool


_PREF_KEYS = {"furigana": "reading_furigana", "romaji": "reading_romaji"}


@router.get("/reading-prefs")
def get_reading_prefs():
    # 기본은 둘 다 켜짐 -- 완전 초보가 아무것도 설정하지 않고 읽을 수 있어야 한다.
    return {name: db.get_setting(key, "1") == "1" for name, key in _PREF_KEYS.items()}


@router.post("/reading-prefs")
def set_reading_prefs(payload: ReadingPrefs):
    for name, key in _PREF_KEYS.items():
        db.set_setting(key, "1" if getattr(payload, name) else "0")
    return {"furigana": payload.furigana, "romaji": payload.romaji}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `.\venv\Scripts\python.exe -m pytest -m "not engine"`
Expected: **227 passed / 8 deselected**

- [ ] **Step 5: 설정 대화상자에 체크박스를 더한다**

`static/index.html`의 `<div id="voice-list"></div>` **뒤**, 닫기 버튼 앞에:

```html
  <fieldset id="reading-prefs">
    <legend>일본어 읽기 보조</legend>
    <label><input type="checkbox" id="pref-furigana" checked> 후리가나 (한자 위 히라가나)</label>
    <label><input type="checkbox" id="pref-romaji" checked> 로마자</label>
    <p class="hint">일본어 세션에만 적용됩니다. 읽을 수 있게 되면 로마자부터 끄세요.</p>
  </fieldset>
```

- [ ] **Step 6: 배선한다**

`static/js/settings.js`에 더한다:

```js
import { setPrefs } from './reading.js';

export async function loadReadingPrefs() {
  try {
    const prefs = await getJSON('/reading-prefs');
    $('pref-furigana').checked = prefs.furigana;
    $('pref-romaji').checked = prefs.romaji;
    setPrefs(prefs);
  } catch {
    // 기본값(둘 다 켜짐)이 이미 reading.js 안에 있다. 설정을 못 읽는 것이
    // 보조를 끄는 이유가 되어서는 안 된다.
  }
}

export async function saveReadingPrefs() {
  const prefs = {
    furigana: $('pref-furigana').checked,
    romaji: $('pref-romaji').checked,
  };
  setPrefs(prefs);
  try {
    await postJSON('/reading-prefs', prefs);
  } catch (err) {
    notify(`읽기 보조 설정을 저장하지 못했습니다: ${err.message}`);
  }
}
```

`settings.js`의 import에 `postJSON`을 더한다.

`static/js/main.js`에서, 설정 열기 핸들러에 `loadReadingPrefs()`를 더하고 체크박스 변경을 잡는다:

```js
$('reading-prefs').addEventListener('change', saveReadingPrefs);
```

그리고 시작 시 한 번 부른다 (`loadHome()` 옆):

```js
loadReadingPrefs();
```

- [ ] **Step 7: 전체 테스트 + 브라우저 확인**

```
.\venv\Scripts\python.exe -m pytest -m "not engine"
node --test "static/js/*.test.js"
```
Expected: **227 passed / 8 deselected**, node **35 passed**

브라우저(8010, DB 복사본)에서:
- 로마자를 끄면 로마자 줄이 사라지고 후리가나는 남는다
- 후리가나까지 끄면 원문만 남는다
- 새로고침해도 설정이 유지된다
- 영어 세션은 여전히 아무 변화가 없다

- [ ] **Step 8: 커밋한다**

```bash
git add static/index.html static/js/settings.js static/js/main.js app/api.py tests/test_api_reading.py
git commit -m "feat: let the learner take the crutches away in order"
```

---

## 완료 조건

- `.\venv\Scripts\python.exe -m pytest -m "not engine"` → **227 passed / 8 deselected**
- `node --test "static/js/*.test.js"` → **35 passed**
- 일본어 대본과 봇 말풍선에 후리가나·로마자·뜻 토글이 붙는다
- 대본 줄을 클릭하면 **내 줄도** 소리가 난다
- `/api/reading`이 실패해도 줄은 평문으로 읽을 수 있다
- 영어 세션은 이 기능이 들어오기 전과 완전히 같다
