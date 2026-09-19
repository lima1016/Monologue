"""HTTP routes. Thin — every route delegates to a module and shapes the response."""
import functools
import json
import logging
import math
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app import (config, db, leveltest, library, llm, prompts, reading, scenarios, stt, text_cleanup,
                 text_match, timed, tts)
from app.text_cleanup import clean_for_tts
from app.text_match import normalize
from app.tts import voicevox_backend

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

Language = Literal["en", "ja"]
Mode = Literal["free", "script", "lesson", "timed"]


class VoiceSelection(BaseModel):
    language: Language
    voice: str


def _voice_setting_key(language: str) -> str:
    return f"voice_{language}"


def selected_voice(language: str) -> str:
    return db.get_setting(_voice_setting_key(language), config.DEFAULT_VOICE[language])


@router.get("/health")
def health():
    return {"ollama": llm.is_healthy(), "voicevox": voicevox_backend.is_healthy(),
            "whisper": stt.status()}


@router.get("/scenarios")
def list_scenarios(language: Language, mode: Mode | None = Query(default=None)):
    kind = mode if mode in ("free", "script") else None
    items = scenarios.scenarios_for(language, kind)
    return {
        "scenarios": [
            {"id": s["id"], "title": s["title"], "type": s["type"], "goal": s.get("goal")}
            for s in items
        ]
    }


THEME_NOT_READY = "이 테마는 아직 준비되지 않았어요"

# 한 줄씩 순서대로. VOICEVOX를 동시에 두드려도 빨라지지 않고, 세션 시작의
# _speak와 겹칠 뿐이다. 캐시 키가 같으므로 겹쳐도 결과는 같다.
_audio_executor = ThreadPoolExecutor(max_workers=1)

# Only the most recent pick is worth warming: clicking through five cards would
# otherwise queue five 16-line scripts behind one worker, and the one the
# learner opens waits behind all of them. A newer pick cancels the queued job
# and bumps the generation, which a job already running checks between lines.
_warmup_lock = threading.Lock()
_warmup_future = None
_warmup_generation = 0


@router.get("/themes")
def list_themes(language: Language):
    out = []
    for theme in library.load_themes():
        out.append({**theme, "ready": {
            "free": library.free_setup(language, theme["id"]) is not None,
            "script": len(db.library_scenarios(language, theme["id"], "script")),
        }})
    return {"themes": out}


class LibraryPick(BaseModel):
    language: Language
    mode: Mode
    theme_id: str


def _prepare_audio(lines, language, generation=None):
    """Warm the TTS cache for a script the learner is about to open. Best effort:
    start_session's own _speak synthesises anything this did not get to.
    Stops between lines once a newer pick has replaced this one."""
    for line in lines:
        if generation is not None and generation != _warmup_generation:
            return
        try:
            _speak(line["text"], language)
        except Exception:
            log.warning("could not prepare audio for a picked script line", exc_info=True)


def _warm_up(lines, language):
    global _warmup_future, _warmup_generation
    with _warmup_lock:
        _warmup_generation += 1
        if _warmup_future is not None:
            _warmup_future.cancel()      # False if already running; the generation stops it
        _warmup_future = _audio_executor.submit(_prepare_audio, lines, language, _warmup_generation)


@router.post("/library/pick")
def pick_from_library(payload: LibraryPick):
    if library.get_theme(payload.theme_id) is None:
        raise HTTPException(404, "no such theme")
    if payload.mode == "lesson":
        raise HTTPException(400, "lesson mode has no themes")
    if payload.mode == "free":
        item = library.free_setup(payload.language, payload.theme_id)
    else:
        item = library.pick_script(payload.language, payload.theme_id)
    if item is None:
        raise HTTPException(409, THEME_NOT_READY)
    if payload.mode == "script":
        _warm_up(item["lines"], payload.language)
    return {"id": item["id"], "title": item["title"], "situation": item.get("situation")}


# library.check_script's reason codes, as the pick screen shows them after
# "대본을 만들지 못했어요: ".
SCRIPT_REJECTED = {
    "line-count": "줄 수가 맞지 않아요",
    "structure": "대사 순서가 맞지 않아요",
    "language": "다른 언어가 섞였어요",
    "too-long": "너무 긴 줄이 있어요",
}


class ScenarioWish(BaseModel):
    language: Language
    mode: Mode
    wish: str


@router.post("/scenarios/generate")
def generate_scenario(payload: ScenarioWish):
    """Turn one line from the learner into a scenario they can practise.

    Lesson mode has no scenario -- its `topic` goes straight into the system
    prompt -- so asking for one is a mistake worth naming rather than silently
    producing something unused.
    """
    if payload.mode not in ("free", "script"):
        raise HTTPException(422, "only free and script modes have scenarios")
    wish = payload.wish.strip()
    if not wish:
        raise HTTPException(422, "wish is empty")

    # Script mode gets one retry: a local 14b sometimes returns the wrong
    # number of lines or a bad shape (library.check_script catches both), and
    # a fresh sample often fixes it. Free mode stays a single call -- there is
    # nothing structural to check_script there.
    attempts = 2 if payload.mode == "script" else 1
    reason = None
    for attempt in range(attempts):
        try:
            result = llm.chat_json(
                prompts.build_scenario_messages(payload.language, payload.mode, wish),
                prompts.scenario_schema(payload.mode),
            )
        except Exception:
            raise HTTPException(503, "상황을 만들지 못했습니다. 잠시 뒤에 다시 시도해 주세요.")
        if payload.mode != "script":
            break
        lines = result.get("lines") if isinstance(result, dict) else None
        reason = library.check_script(lines, payload.language, check_duplicates=False)
        if reason is None:
            break
    else:
        raise HTTPException(422, SCRIPT_REJECTED.get(reason, "대본 모양이 맞지 않아요"))

    item = {
        "id": f"user-{uuid.uuid4().hex[:12]}",
        "language": payload.language,
        "type": payload.mode,
        "title": library.korean_title(result.get("title"), wish),
        "goal": (result.get("goal") or "").strip() or None,
    }
    if payload.mode == "free":
        item["persona_prompt"] = (result.get("persona_prompt") or "").strip()
        item["max_turns"] = config.DEFAULT_MAX_TURNS
    else:
        item["lines"] = result.get("lines") or []

    # A local 14b will sometimes return something unusable. Validating here means
    # a bad generation is a clear error now, not a crash when the learner
    # presses 시작.
    try:
        scenarios.validate_item(item)
    except scenarios.ScenarioError as exc:
        raise HTTPException(422, f"만들어진 상황이 올바르지 않습니다: {exc}")

    db.add_user_scenario(item)
    return {"id": item["id"], "title": item["title"], "type": item["type"],
            "goal": item.get("goal")}


TIMED_QUESTIONS_UNAVAILABLE = "지금은 질문을 만들 수 없어요"
_TIMED_MAX_QUESTIONS = 3


class _NoQuestions(Exception):
    pass


def _timed_question_text_ok(text: str, language: str) -> bool:
    """Can the learner be asked this in `language`? Reuses the script checks
    _sayable uses for a spoken reply (_HANGUL, _LATIN_LETTER, _KANA) -- but a
    1분 말하기 question is read once rather than repeated back, so there is no
    length cap here."""
    if _HANGUL.search(text):
        return False
    if language == "ja":
        return bool(_KANA.search(text)) and not _LATIN_LETTER.search(text)
    return bool(_LATIN_LETTER.search(text))


def _valid_questions(raw, language: str, kept=()) -> list[dict]:
    """The model's timed questions that pass, after whatever was already kept.

    Mirrors _valid_replies: never raises on malformed output, drops a
    duplicate (by normalised text) of one already kept, and caps at three.
    Two differences from a suggested reply: a bad or missing `starter` is not
    fatal to the question -- it becomes "" and the card shows no hint, rather
    than the whole question being dropped -- and `meaning` is Korean prose
    checked with _is_korean_meaning, not a spoken line in the target language.
    """
    out = [dict(q) for q in kept]
    seen = {normalize(q["text"]) for q in out}
    for item in raw if isinstance(raw, list) else []:
        if len(out) >= _TIMED_MAX_QUESTIONS:
            break
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        text = _first_line(item["text"])
        if not text or not _timed_question_text_ok(text, language):
            continue
        meaning = item.get("meaning")
        if not isinstance(meaning, str) or not _is_korean_meaning(meaning, source=text):
            continue
        key = normalize(text)
        if not key or key in seen:
            continue
        seen.add(key)
        starter = item.get("starter")
        starter = starter.strip() if isinstance(starter, str) else ""
        if _HANGUL.search(starter):
            starter = ""
        out.append({"text": text, "meaning": meaning.strip(), "starter": starter})
    return out


def _generate_timed_questions(language, theme_title, level) -> list[dict]:
    """Two or three 1분 말하기 questions for a theme, or _NoQuestions.

    Same retry shape as _generate_suggestions: fewer than two survivors earns
    one more sample, but a model call that raised outright is not retried --
    a second call would only wait out the same timeout again.
    """
    messages = prompts.build_timed_questions_messages(language, theme_title, level)
    kept: list[dict] = []
    for _ in range(2):
        try:
            result = llm.chat_json(messages, prompts.timed_questions_schema())
        except Exception as exc:
            raise _NoQuestions from exc
        raw = result.get("questions") if isinstance(result, dict) else None
        kept = _valid_questions(raw, language, kept)
        if len(kept) >= 2:
            break
    if not kept:
        raise _NoQuestions
    return kept


@functools.lru_cache(maxsize=128)
def _cached_timed_questions(language: str, theme_id: str, level: str, today_iso: str) -> tuple[dict, ...]:
    """Successful question sets only -- lru_cache never caches an exception, so
    a model failure is retried on the next request rather than sticking until
    the process restarts. Keyed by day, so the same theme gets a fresh set of
    questions tomorrow rather than the same three forever."""
    theme_title = library.get_theme(theme_id)["title"]
    return tuple(_generate_timed_questions(language, theme_title, level))


@router.get("/timed/questions")
def timed_questions(language: Language, theme_id: str):
    if library.get_theme(theme_id) is None:
        raise HTTPException(404, "no such theme")
    level = db.stable_level(language) or "beginner"
    try:
        questions = _cached_timed_questions(language, theme_id, level, _today().isoformat())
    except _NoQuestions:
        raise HTTPException(503, TIMED_QUESTIONS_UNAVAILABLE)
    return {"questions": [dict(q) for q in questions]}


@router.get("/voices")
def list_voices(language: Language):
    return {"voices": config.VOICE_CATALOG[language], "selected": selected_voice(language)}


@router.post("/voices")
def choose_voice(payload: VoiceSelection):
    valid = [v["id"] for v in config.VOICE_CATALOG[payload.language]]
    if payload.voice not in valid:
        raise HTTPException(400, f"{payload.voice} is not available for {payload.language}")
    db.set_setting(_voice_setting_key(payload.language), payload.voice)
    return {"selected": payload.voice}


@router.post("/tts/preview")
def preview_voice(payload: VoiceSelection):
    try:
        audio = tts.synthesize(config.PREVIEW_TEXT[payload.language],
                               payload.language, payload.voice)
    except tts.TTSError as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(content=audio, media_type="audio/wav")


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
def _cached_reading(text: str) -> list[dict]:
    # 읽기는 결정적이고 텍스트는 반복된다(이어서 하기 때 같은 줄이 다시 온다).
    # 상한이 있어야 한다 -- 자유 대화는 매 턴 새 문장을 만들므로 무제한 캐시는
    # 세션이 길어질수록 자라기만 한다.
    #
    # 반환된 리스트는 캐시가 들고 있는 바로 그 객체다. 호출자는 이것을
    # 변형하면 안 된다 -- 제자리에서 고치면 그 텍스트의 이후 응답이 전부
    # 오염된다. 지금은 라우트가 FastAPI 직렬화기에 그대로 넘길 뿐이다.
    return reading.analyse(text)


class TranslateRequest(BaseModel):
    language: Language
    text: str


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
    except stt.SttUnavailable:
        # Expected while the model is loading (or on a machine without CUDA) --
        # not worth a warning every time a learner speaks before it is ready.
        log.debug("stt unavailable; the turn falls back to the browser transcript")
        raise HTTPException(503, "받아쓰기를 할 수 없습니다")
    except Exception:
        # Anything else is a real failure on a clip that should have worked
        # (decode error, CUDA OOM, cuDNN mismatch) -- silent 503s here would
        # make a broken model indistinguishable from one still loading.
        log.warning("transcription failed; the turn falls back to the browser transcript",
                   exc_info=True)
        raise HTTPException(503, "받아쓰기를 할 수 없습니다")
    return {"text": text}


@router.post("/translate")
def translate_line(payload: TranslateRequest):
    """한 줄의 한국어 뜻. 학습자가 펼칠 때만 불린다.

    미리 번역하지 않는 이유는 두 가지다: 대본 16줄을 선번역하면 시작이 그만큼
    느려지고, 펼쳐보지도 않을 줄까지 번역하게 된다. 먼저 짐작하고 확인하는
    편이 학습에 남는다는 것도 같은 방향이다.
    """
    meaning = _cached_translation(payload.language, payload.text)
    if meaning is None:
        raise HTTPException(503, "번역할 수 없습니다")
    return {"meaning": meaning}


# 음절에 더해 호환 자모(ㅋㅋ, ㅠㅠ)도 한글이다.
_HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")
# 영문으로 치는 글자: ASCII, 라틴-1(café), 라틴 확장(로마자의 ō), 전각(ＯＫ).
_LATIN = r"A-Za-zÀ-ÖØ-öø-ɏＡ-Ｚａ-ｚ"
_LATIN_LETTER = re.compile(f"[{_LATIN}]")
_LATIN_WORD = re.compile(f"[{_LATIN}]+")
_CJK_IDEOGRAPH = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
# 곧은 작은따옴표는 낱말 속 아포스트로피(don't)와 같은 글자다. 글자 바로 뒤의
# 것은 인용을 열지 못하게 해야 `don't 请问 isn't` 사이가 인용으로 지워지지 않는다.
# 닫는 쪽도 마찬가지다(that's): 글자 바로 앞에서는 닫지 못하게 하고, 느슨한 `.+?`로
# 인용 속 아포스트로피(I'd, that's)를 건너뛰어 진짜 닫는 인용부호까지 늘린다 --
# 그러지 않으면 "I'd like a table..." 같은 문장의 대부분이 인용 밖으로 새어,
# 실제로 가르치는 표현이어도 영문 낱말 수가 한글 글자 수를 넘어 거절된다.
_QUOTED = re.compile(
    r'"[^"]*"|“[^”]*”|(?<![A-Za-z])\'.+?\'(?![A-Za-z])|‘[^’]*’|「[^」]*」|『[^』]*』')


_MAX_QUOTED_EXPRESSION = 12


def _quote_dropper(source: str):
    """인용을 지우되, 한자가 든 인용은 원문 줄에 실제로 있을 때만 지운다.

    한자만 보고는 가르치는 표현("大丈夫"는 괜찮다는 뜻)과 중국어 누출("请问几位")을
    구별할 수 없다. 구별하는 것은 원문이다: 학습자가 펼친 그 줄에 있는 한자면
    인용이고, 없는 한자면 모델이 만들어낸 것이다.
    """
    def drop(match: re.Match) -> str:
        span = match.group(0)
        if not _CJK_IDEOGRAPH.search(span):
            return ""
        inner = span[1:-1].strip()
        # 표현 하나 크기만 인용으로 친다. 원문 줄을 통째로(또는 거의 다) 따옴표에
        # 넣고 "는 뜻이에요"만 붙인 것은 번역하지 않은 되풀이다.
        expression_sized = len(inner) <= _MAX_QUOTED_EXPRESSION and len(inner) * 2 < len(source)
        return "" if inner and expression_sized and inner in source else span
    return drop


def _is_korean_meaning(text: str, source: str = "") -> bool:
    """뜻이 정말 한국어인가. 틀린 언어로 보여주느니 503이 낫다.

    인용한 부분은 빼고 본다: 수업 대사는 "たぶん" 같은 표현 자체를 가르치므로
    따옴표 안의 가나·영어는 누출이 아니라 번역의 일부다. 따옴표 안의 한자는
    `source`(원문 줄)에 있는 문자열일 때만 인용으로 친다(_quote_dropper 참고).
    그 밖에서는 한글과 영문이 아닌 글자가 한 자라도 있으면 새는 중이다 --
    실제로 샌 모양은 한국어로 시작해 문장 중간에 중국어로 넘어가는 것이었고,
    영어 줄에서는 키릴 문자가 한 단어 섞여 나왔다. 영문은 허용하되(PDF, OK 같은
    표기) 영어 원문이 통째로 되돌아온 경우를 막으려고 한글 글자 수가 영문 낱말
    수 이상이어야 한다. 영문을 글자로 세면 `PDF를 USB로 주세요`처럼 약어 몇 개로
    한국어 뜻이 거절된다.
    """
    bare = _QUOTED.sub(_quote_dropper(source), text)
    hangul = len(_HANGUL.findall(bare))
    latin_words = len(_LATIN_WORD.findall(bare))
    foreign = sum(1 for ch in bare
                  if ch.isalpha() and not _HANGUL.match(ch) and not _LATIN_LETTER.match(ch))
    return hangul > 0 and foreign == 0 and hangul >= latin_words


class _NoMeaning(Exception):
    pass


def _cached_translation(language: str, text: str) -> str | None:
    """성공한 뜻만 기억한다. 실패(None)는 캐시하지 않는다.

    실패는 모델이 죽은 경우만이 아니다 -- 일본어 줄은 되묻고도 두 번 새는
    경우가 흔하다. 그 None이 남으면 그 줄은 대본 패널, 같은 말풍선, 이어서
    하기까지 서버를 재시작할 때까지 즉시 503이 된다. 모델이 죽어 있는 동안
    펼칠 때마다 14b를 다시 두드리는 비용은 학습자가 버튼을 누를 때뿐이라
    감수할 만하다.
    lru_cache는 예외를 캐시하지 않으므로, 실패를 예외로 바꿔 그 아래로
    보내고 여기서 None으로 되돌린다."""
    try:
        return _successful_translation(language, text)
    except _NoMeaning:
        return None


@functools.lru_cache(maxsize=512)
def _successful_translation(language: str, text: str) -> str:
    try:
        messages = prompts.build_translate_messages(language, text)
        meaning = _first_line(_translate_call(messages))
        if meaning and not _is_korean_meaning(meaning, source=text):
            # One retry, with the leaked answer in view. In the prompt probe
            # (29 Japanese lines x3 = 87 calls on the real model, judged by the
            # probe's own Korean check) it took Korean meanings from 56% to
            # 79% over the wrapped prompt alone. The app's real path, judged
            # by _is_korean_meaning, measured 75% (65/87) Japanese and 95%
            # (19/20) English -- see test_translate_quality.py. A second retry
            # was not worth it at temperature 0.2, where a line that leaks
            # twice leaks in the same place again.
            messages = prompts.build_translate_retry_messages(messages, meaning)
            meaning = _first_line(_translate_call(messages))
    except Exception as exc:
        raise _NoMeaning from exc
    if not (meaning and _is_korean_meaning(meaning, source=text)):
        raise _NoMeaning
    return meaning


# 테스트는 캐시를 이 이름으로 비운다.
_cached_translation.cache_clear = _successful_translation.cache_clear


# A meaning is one line. Leaking answers ran on in Chinese commentary until the
# request timed out, so the cap is what keeps a failure fast. It is still well
# above one line: an honest meaning cut off at the cap would pass the Korean
# check and be served half-finished, as if it were complete.
_TRANSLATE_MAX_TOKENS = 300


def _translate_call(messages):
    return llm.chat(messages, temperature=0.2, max_tokens=_TRANSLATE_MAX_TOKENS)


def _first_line(raw: str) -> str | None:
    """The first non-empty line, or None.

    An empty (or whitespace-only) completion is a success by llm.chat's
    contract -- it did not raise -- but it is exactly the string the 503 exists
    to prevent: a line whose meaning renders as genuinely absent,
    indistinguishable on screen from a broken feature. Taking only the first
    line also enforces the "one line" contract server-side: a model that
    appends a parenthetical aside or a second sentence still yields a single
    clean line. An echoed source line is not stripped here; _is_korean_meaning
    refuses it -- an echoed Japanese line has kana or kanji outside quotation
    marks, and an echoed English line has fewer Hangul letters than Latin
    words (Latin itself is allowed, for PDF or OK).
    """
    for line in raw.strip().splitlines():
        line = line.strip()
        if line:
            return line
    return None


# 💡 뭐라고 하지? -- what makes a generated reply worth showing.
_KANA = re.compile(r"[぀-ヿ]")
_SUGGEST_MAX_WORDS_EN = 12
_SUGGEST_MAX_CHARS_JA = 30
_SUGGEST_MAX_REPLIES = 3
# 일본어 답장에는 금지된 것: 로마자 표기와 괄호(둘 다 반각/전각). 프롬프트가 이미
# 로마자와 괄호를 쓰지 말라고 하므로, 여기서는 그 규칙을 어긴 답을 거른다 --
# 가끔 "OK" 한 줄을 잃는 대가는 감수할 만하다.
_JA_FORBIDDEN = re.compile(r"[A-Za-z()（）]")


def _sayable(text: str, language: str) -> bool:
    """Can the learner say this line as practice in `language`?

    Any Hangul means the model answered in the wrong language. Japanese needs
    at least one kana: a kanji-only line is exactly what a Chinese leak looks
    like. Too long is refused rather than cut -- a truncated sentence is a
    wrong sentence, and the learner would practise it. An English reply with
    any CJK ideograph or kana leaked the wrong language too, even though it
    also has Latin letters. A Japanese reply may not carry Latin letters or
    brackets -- those are exactly a romaji gloss or a parenthetical aside,
    both of which the prompt forbids.
    """
    if _HANGUL.search(text):
        return False
    if language == "ja":
        if _JA_FORBIDDEN.search(text):
            return False
        return bool(_KANA.search(text)) and len(normalize(text).replace(" ", "")) <= _SUGGEST_MAX_CHARS_JA
    if _CJK_IDEOGRAPH.search(text) or _KANA.search(text):
        return False
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


class ReadingPrefs(BaseModel):
    furigana: bool
    # 발음 줄을 보일지. 이름이 romaji인 것은 표기 선택이 생기기 전부터 저장된 값을
    # 그대로 잇기 위해서다 -- 로마자를 꺼 둔 사람은 발음 줄도 꺼진 채로 남는다.
    romaji: bool
    # 발음 줄의 표기. 한글이 기본이다: 가나를 아직 못 읽는 한국어 화자에게는
    # 로마자보다 한글이 바로 소리로 읽힌다. 두 필드만 보내던 요청도 받는다.
    pron_script: Literal["hangul", "romaji"] = "hangul"


_PREF_KEYS = {"furigana": "reading_furigana", "romaji": "reading_romaji"}
_PRON_SCRIPT_KEY = "reading_pron_script"


@router.get("/reading-prefs")
def get_reading_prefs():
    # 기본은 둘 다 켜짐 -- 완전 초보가 아무것도 설정하지 않고 읽을 수 있어야 한다.
    prefs = {name: db.get_setting(key, "1") == "1" for name, key in _PREF_KEYS.items()}
    script = db.get_setting(_PRON_SCRIPT_KEY, "hangul")
    prefs["pron_script"] = script if script in ("hangul", "romaji") else "hangul"
    return prefs


@router.post("/reading-prefs")
def set_reading_prefs(payload: ReadingPrefs):
    for name, key in _PREF_KEYS.items():
        db.set_setting(key, "1" if getattr(payload, name) else "0")
    db.set_setting(_PRON_SCRIPT_KEY, payload.pron_script)
    return {"furigana": payload.furigana, "romaji": payload.romaji,
            "pron_script": payload.pron_script}


class SessionStart(BaseModel):
    language: Language
    mode: Mode
    scenario_id: str | None = None
    topic: str | None = None
    shadowing: bool = False


class ChatTurn(BaseModel):
    session_id: int
    text: str


def _history(session_id: int) -> list[dict]:
    """Conversation so far in Ollama's message format."""
    role = {"bot": "assistant", "user": "user"}
    return [
        {"role": role[m["speaker"]], "content": m["text"]}
        for m in db.get_messages(session_id)
    ]


def _last_bot_message(session_id: int) -> str | None:
    """The bot's most recent line, for the feedback prompt's context paragraph.

    Called before the current learner turn is stored, so in practice this is
    just the last message in the session -- but filtering by speaker rather
    than assuming that keeps it correct even if that ordering ever changes.
    """
    for m in reversed(db.get_messages(session_id)):
        if m["speaker"] == "bot":
            return m["text"]
    return None


def _speak(text: str, language: str) -> str | None:
    """Synthesise to the cache and return its key, or None if TTS is unavailable.

    A TTS outage must never stop a practice session — the browser falls back to
    its own speech synthesis when the key is None.
    """
    try:
        return tts.synthesize_to_cache(text, language, selected_voice(language))
    except tts.TTSError:
        return None


_NO_FEEDBACK = {"ok": None, "fixed": None, "tag": None,
                "correction": None, "suggestion": None}

# Quote styles the model actually uses when quoting an example sentence back:
# straight and curly single/double quotes, and Japanese corner brackets. The
# straight single quote is also an apostrophe inside a contraction (I'd,
# don't), so it may only open a quote when not preceded by a Latin letter and
# only close one when not followed by a Latin letter -- otherwise "I'd" reads
# as a one-letter quote closing right after the "I". The lazy `.+?` then
# skips straight past an internal apostrophe like that (its lookahead fails)
# and keeps extending until it finds a real closing quote, so a trailing
# Korean particle ('...'라고) still closes it correctly.
_QUOTED_SPAN = re.compile(
    r"(?<![A-Za-z])'(.+?)'(?![A-Za-z])|\"([^\"]*)\"|‘([^’]*)’|“([^”]*)”|"
    r"「([^」]*)」"
)


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


def _feedback(language: str, text: str, *, scenario_title=None,
             scenario_goal=None, bot_last=None, topic=None) -> dict:
    """Structured grammar feedback for one learner line.

    Never raises. A model hiccup must not cost the learner their turn -- the
    conversation continues and the message is stored without feedback. The
    guard covers the whole body, not just the call: chat_json guarantees the
    response parsed as JSON, not that it parsed as an *object*, so a stray
    array or string would otherwise reach .get() and propagate an
    AttributeError out of here.

    `text` is graded after text_cleanup.strip_fillers removes standalone
    speech-disfluency fillers (uh, um, ...) -- the caller's `text` argument is
    never shown or stored, only what reaches the model here. If stripping
    empties it (the learner said nothing but filler), grading is skipped
    entirely: there is nothing to grade, and sending an empty string to the
    model would just invite it to invent something.
    """
    graded_text = text_cleanup.strip_fillers(text, language)
    if not graded_text:
        return dict(_NO_FEEDBACK)
    try:
        result = llm.chat_json(
            prompts.build_feedback_messages(
                language, graded_text, scenario_title=scenario_title,
                scenario_goal=scenario_goal, bot_last=bot_last, topic=topic,
            ),
            prompts.feedback_schema(language),
        )
        ok = result.get("ok")
        fixed = result.get("fixed")
        # Browser speech recognition never returns punctuation, so the model
        # routinely "corrects" a perfectly correct sentence by adding commas
        # and a full stop. If the only difference from what was sent for
        # grading is punctuation/casing (app.text_match.normalize, the Python
        # twin of static/js/match.js's normalize()), that is an artifact of
        # speech recognition, not the learner's mistake -- it must not be
        # stored as one. `suggestion` survives: it is not a correction but "a
        # native speaker might also say it this way", worth keeping even when
        # the sentence was fine. isinstance guards normalize(fixed): the
        # schema makes a non-string `fixed` unlikely, but if it ever happens
        # this must skip neutralisation, not raise into the outer except and
        # discard a tag/correction the model actually gave.
        if ok is False and isinstance(fixed, str) and fixed and normalize(graded_text) == normalize(fixed):
            return {
                "ok": True,
                "fixed": None,
                "tag": None,
                "correction": None,
                "suggestion": _drop_self_quoting_suggestion(
                    result.get("suggestion"), graded_text
                ),
            }
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
    except Exception:
        return dict(_NO_FEEDBACK)


@router.post("/sessions")
def start_session(payload: SessionStart):
    if payload.shadowing and payload.mode != "script":
        raise HTTPException(400, "shadowing is a script session")
    if payload.mode == "timed":
        # 질문 화면에서 학생이 고른 질문이 topic으로 온다. 시나리오도 모델 호출도
        # 봇 첫마디도 없다 -- 1분 말하기는 학생 혼자 타이머 앞에서 말하는 시간이고,
        # 질문은 GET /timed/questions에서 이미 골랐다.
        if payload.scenario_id:
            raise HTTPException(400, "timed mode has no scenario")
        topic = (payload.topic or "").strip()
        if not topic:
            raise HTTPException(400, "timed mode needs a topic")
        session_id = db.create_session(payload.language, payload.mode, topic=topic)
        return {"session_id": session_id, "mode": "timed", "topic": topic}
    scenario = None
    if payload.mode in ("free", "script"):
        if not payload.scenario_id:
            raise HTTPException(400, f"{payload.mode} mode needs a scenario_id")
        scenario = scenarios.get_scenario(payload.scenario_id)
        if scenario is None:
            raise HTTPException(404, f"no scenario {payload.scenario_id}")
        # Defence in depth, and the check whose absence made a frontend race
        # silent instead of loud: a scenario id resolves here with no reference
        # to the language asked for, so a session could be stamped `ja` while
        # bound to an `en` scenario. Nothing downstream ever notices -- the
        # session's turns simply feed home_stats() and stable_level() for a
        # language it was not practised in, permanently and invisibly. Any
        # route to that outcome ends here now, not only the one the browser
        # has been taught to avoid.
        if scenario["language"] != payload.language:
            raise HTTPException(
                400,
                f"scenario {payload.scenario_id} is {scenario['language']},"
                f" not {payload.language}",
            )
        # The same class of mismatch on the other axis, and the one that was
        # left open because it was believed to fail loudly. It does not: only
        # two of its three shapes crash (`script` mode on a free scenario dies
        # on scenario["lines"], `free` mode on a *built-in* script scenario
        # dies on scenario["persona_prompt"]). A `free` request naming a
        # *generated* script scenario returns 200, because scenarios.from_row
        # materialises persona_prompt for script rows too -- NULL for any the
        # generator never gave one -- and prompts.py reads it with a bracket,
        # so the `or`-fallback that defuses `goal` never applies. The prompt
        # then carries the literal line "Your character: None" and the session
        # is written anyway: silent, permanent, nothing on screen to say so.
        # Not reachable from today's home screen (loadChips clears #chips
        # synchronously before any await), which is exactly the reasoning that
        # made the language mismatch invisible for a whole phase.
        #
        # Before create_session on purpose: the two crashing shapes above blow
        # up *after* the row is written, so each has been leaving an orphaned
        # empty session behind. Rejecting here removes both.
        if scenario["type"] != payload.mode:
            raise HTTPException(
                400,
                f"scenario {payload.scenario_id} is a {scenario['type']} scenario,"
                f" not {payload.mode}",
            )

    session_id = db.create_session(payload.language, payload.mode,
                                   scenario_id=payload.scenario_id, topic=payload.topic,
                                   shadowing=payload.shadowing)

    if payload.mode == "script":
        lines = []
        for line in scenario["lines"]:
            # 화자를 가리지 않는다. 학습자가 자기 차례 줄을 미리 듣고 따라 읽는 것이
            # 대본 모드의 핵심 동작이고, 그러려면 내 줄에도 음성이 있어야 한다. 대본은
            # 16줄 남짓이고 tts는 캐시되므로 전부 선합성해도 비용은 무시할 만하다.
            key = _speak(line["text"], payload.language)
            lines.append({"speaker": line["speaker"], "text": line["text"], "audio_key": key})
        return {"session_id": session_id, "mode": "script", "lines": lines,
               "shadowing": payload.shadowing}

    system = prompts.build_system_prompt(
        payload.mode, payload.language, scenario=scenario, topic=payload.topic,
        level=db.stable_level(payload.language) or "beginner",
    )
    opening = llm.chat([
        {"role": "system", "content": system},
        {"role": "user", "content": "Start the conversation with your first line."},
    ])
    db.add_message(session_id, "bot", opening)
    return {
        "session_id": session_id,
        "mode": payload.mode,
        "opening": opening,
        "opening_audio": _speak(opening, payload.language),
        # The side panel's only content in free mode -- lesson mode has no
        # scenario, so this is None there and the frontend falls back to the
        # learner's own typed topic.
        "goal": scenario.get("goal") if scenario else None,
    }


@router.post("/chat")
def chat_turn(payload: ChatTurn):
    session = db.get_session(payload.session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")

    language = session["language"]
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    turns_used = sum(1 for m in db.get_messages(payload.session_id) if m["speaker"] == "user")

    feedback = _feedback(
        language, text,
        scenario_title=scenario.get("title") if scenario else None,
        scenario_goal=scenario.get("goal") if scenario else None,
        bot_last=_last_bot_message(payload.session_id),
        topic=session["topic"] if session["mode"] == "lesson" else None,
    )
    message_id = db.add_message(payload.session_id, "user", text,
                   correction=feedback["correction"],
                   suggestion=feedback["suggestion"],
                   ok=feedback["ok"], fixed=feedback["fixed"], tag=feedback["tag"])
    if feedback["ok"] is False and feedback["fixed"]:
        # Tomorrow, not today: the learner just saw the fix. Spec: mypage design.
        db.enqueue_review(message_id, language, _today() + timedelta(days=1))

    system = prompts.build_system_prompt(
        session["mode"], language, scenario=scenario, topic=session["topic"],
        level=db.stable_level(language) or "beginner", turns_used=turns_used + 1,
    )
    reply = llm.chat([{"role": "system", "content": system}] + _history(payload.session_id))
    db.add_message(payload.session_id, "bot", reply)

    return {
        "turn": turns_used + 1,
        "bot_reply": reply,
        "audio_key": _speak(reply, language),
        **feedback,
    }


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
    and the bot reply after it) never leaves a stale entry reachable.

    Two presses on the same still-fresh line can both miss the cache and both
    call the model -- lru_cache does not coalesce in-flight calls. The 💡
    button disables itself while a request is out, so this needs no lock."""
    session = db.get_session(session_id)
    messages = db.get_messages(session_id)
    # Undo can remove the bot line between the route's own lookup and this
    # read (sync routes run in a threadpool, so the two reads are not
    # atomic); treat a vanished line the same as a model failure rather than
    # letting StopIteration escape.
    index = next((i for i, m in enumerate(messages) if m["id"] == bot_message_id), None)
    if index is None:
        raise _NoSuggestions
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


class ScriptLineStore(BaseModel):
    index: int


@router.post("/sessions/{session_id}/script-line")
def store_script_line(session_id: int, payload: ScriptLineStore):
    """Record a bot script line at the moment it is actually shown.

    Script mode's own /sessions response never stores anything -- the learner
    has not seen a single line yet at that point (see start_session's script
    branch) -- so without this call the database never learns what the
    learner was actually shown, and resume/report have nothing true to work
    from. Storing every line up front instead was considered and rejected:
    that would put lines the learner has not reached yet into the record, and
    resuming would show them the future.
    """
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["mode"] != "script":
        raise HTTPException(400, "not a script session")
    if session["shadowing"]:
        raise HTTPException(400, "a shadowing session stores lines through /shadow-line")
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    lines = scenario["lines"] if scenario else []
    if payload.index < 0 or payload.index >= len(lines):
        raise HTTPException(400, "line index out of range")
    line = lines[payload.index]
    if line["speaker"] != "bot":
        raise HTTPException(400, "only bot lines are stored through this route")

    # Idempotent: a refresh or a retried request landing on the same index
    # must not double the record. db.add_script_line_message enforces this at
    # the database via a UNIQUE(session_id, script_index) index, not by
    # comparing the index against a message count -- that count answers "how
    # many messages exist", not "was this index stored", and an interleaved
    # or out-of-order sequence of indices (or two requests racing each other)
    # could fool it either into storing the same line twice or into silently
    # dropping a line that was never actually recorded.
    message_id = db.add_script_line_message(session_id, payload.index, line["text"])
    return {"stored": message_id is not None}


class ScriptTurn(BaseModel):
    session_id: int
    text: str


@router.post("/script-turn")
def script_turn(payload: ScriptTurn):
    """The learner's line in script mode: read from a fixed script, not
    composed on the spot. Unlike /chat, this never calls the LLM -- the bot's
    next line already exists in the script, and the learner did not write the
    sentence they just read, so there is nothing here for grammar feedback to
    judge. The client compares what was said against the script line itself
    (static/js/match.js's matches()) and shows accuracy, not correctness.
    """
    session = db.get_session(payload.session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if session["mode"] != "script":
        raise HTTPException(400, "not a script session")
    if session["shadowing"]:
        raise HTTPException(400, "a shadowing session stores lines through /shadow-line")

    turns_used = sum(1 for m in db.get_messages(payload.session_id) if m["speaker"] == "user")
    db.add_message(payload.session_id, "user", text)
    return {"turn": turns_used + 1}


class ShadowLine(BaseModel):
    index: int
    text: str
    peeked: bool = False


@router.post("/sessions/{session_id}/shadow-line")
def shadow_line(session_id: int, payload: ShadowLine):
    """One attempt at shadowing script line `index`. The verdict is the
    server's (text_match.matches, the twin of match.js), and a retry replaces
    the attempt in place -- see db.save_shadow_line."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    if not session["shadowing"]:
        raise HTTPException(400, "not a shadowing session")
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    lines = scenario["lines"] if scenario else []
    if payload.index < 0 or payload.index >= len(lines):
        raise HTTPException(400, "line index out of range")
    target = lines[payload.index]["text"]
    matched = text_match.matches(text, target, session["language"])
    message_id = db.save_shadow_line(session_id, payload.index, text, target, matched, payload.peeked)
    return {"message_id": message_id, "matched": matched}


@router.delete("/sessions/{session_id}/last-turn")
def undo_last_turn(session_id: int):
    """Discard the most recent learner turn so it can be spoken again."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    if session["shadowing"]:
        raise HTTPException(400, "shadowing retries a line instead of undoing it")
    deleted, paths = db.delete_last_turn(session_id)
    # Undo is used exactly when recognition mishears, which is often -- without
    # this the deleted turn's recording becomes a file no row ever points to
    # again: clear_session_audio can't see it once the row is gone, and
    # stale_open_sessions' EXISTS clause means the end-of-session sweep never
    # will either.
    _unlink_audio(paths)
    return {"deleted": deleted}


@router.get("/audio/{key}.wav")
def get_audio(key: str):
    path = tts.cached_path(key)
    if not path.exists():
        raise HTTPException(404, "no such audio")
    return Response(content=path.read_bytes(), media_type="audio/wav")


@router.post("/sessions/{session_id}/audio")
async def upload_recording(session_id: int, message_id: int = Form(...),
                           file: UploadFile = File(...)):
    """Store the learner's raw recording. Phase 1 only keeps it; Phase 2 scores it."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    # /end runs _forget_recordings synchronously before returning, and a
    # sendText already in flight when /end lands keeps going -- awaiting
    # uploadPendingRecording after the reply. Without this check that upload
    # writes the file and sets audio_path *after* the sweep already ran, and
    # nothing ever collects it: the sweep skips ended sessions and a second
    # /end 409s. Matches /chat and /last-turn, which already reject this way.
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    if message_id not in {m["id"] for m in db.get_messages(session_id)}:
        raise HTTPException(404, "no such message in this session")
    config.AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    name = f"s{session_id}_m{message_id}.webm"
    (config.AUDIO_DIR / name).write_bytes(await file.read())
    stored = f"audio/{name}"
    db.set_message_audio(message_id, stored)
    return {"audio_path": stored}


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


# ---------------------------------------------------------------------------
# 1분 말하기: 회차 올리기, 문장 교정, 원어민이라면
# ---------------------------------------------------------------------------

TIMED_STT_UNAVAILABLE = "받아쓰기를 할 수 없어요"
TIMED_NATIVE_UNAVAILABLE = "지금은 원어민 답을 만들 수 없어요"
# 원어민이라면의 길이 상한. 목표(en 120~160단어, ja 250~350자)를 넘어도 이 정도까지는
# 받아 주고, 그 이상은 자르지 않고 거절한다 -- 잘린 1분 답은 문장 중간에서 끝난다.
_NATIVE_MAX = {"en": 220, "ja": 450}
# 한 회차 문장 목록의 읽기-고치기-쓰기를 한 줄로 세운다. 교정 호출(수 초) 자체는
# 밖에서 돈다 -- 잠그는 것은 DB를 다시 읽고 문장 하나를 바꿔 쓰는 순간뿐이다.
_ROUND_WRITE = threading.Lock()
_TIMED_MAX_SECONDS = 120
# What is left of a sentence once its fillers are gone: "Um." leaves ".", so
# "nothing left" means no letter or digit at all, not an empty string.
_WORD_CHAR = re.compile(r"\w")


def _timed_session(session_id: int) -> dict:
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["mode"] != "timed":
        raise HTTPException(400, "not a timed session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    return session


def _timed_round(session_id: int, n: int) -> dict:
    for r in db.get_rounds(session_id):
        if r["round"] == n:
            return r
    raise HTTPException(404, "no such round")


def _round_response(n: int, seconds: float, stats: dict) -> dict:
    return {"round": n, "seconds": seconds, "words": stats["words"], "wpm": stats["wpm"],
            "long_pauses": stats["long_pauses"],
            "sentences": [{"text": s} for s in stats["sentences"]]}


async def _transcribe_round(audio: bytes, language: str, seconds: float, n: int) -> dict:
    """Segments -> round_stats, or a 503 carrying the round number so the
    client can retry /transcribe on the recording that is already saved."""
    try:
        segments = await run_in_threadpool(stt.transcribe_segments, audio, language)
    except stt.SttUnavailable:
        log.debug("stt unavailable for a timed round; the recording is kept for a retry")
        raise HTTPException(503, detail={"message": TIMED_STT_UNAVAILABLE, "round": n})
    except Exception:
        # A real failure, not a model still loading -- see /transcribe.
        log.warning("timed round transcription failed; the recording is kept for a retry",
                    exc_info=True)
        raise HTTPException(503, detail={"message": TIMED_STT_UNAVAILABLE, "round": n})
    return timed.round_stats(segments, language, seconds)


@router.post("/sessions/{session_id}/timed/rounds")
async def upload_timed_round(session_id: int, seconds: float = Form(...),
                             file: UploadFile = File(...)):
    """One round = one continuous recording. The file and the round number are
    kept *before* transcription, so a failed transcription never loses the
    learner's minute: the round is stored with no sentences and the 503 says
    which round to retry."""
    session = _timed_session(session_id)
    # The client's own clock: it stops at 60 s. Anything not a real length
    # (nan, inf, zero, negative, far past the safety cap) is refused before a
    # file is written or a round number is taken -- wpm divides by it.
    if not (math.isfinite(seconds) and 0 < seconds <= _TIMED_MAX_SECONDS):
        raise HTTPException(422, "seconds must be a real length, 0 < seconds <= 120")
    audio = await file.read(_MAX_TRANSCRIBE_BYTES + 1)
    if len(audio) > _MAX_TRANSCRIBE_BYTES:
        raise HTTPException(413, "녹음이 너무 큽니다")
    n = db.next_round(session_id)
    config.AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    name = f"s{session_id}_r{n}.webm"
    (config.AUDIO_DIR / name).write_bytes(audio)
    stored = f"audio/{name}"
    try:
        stats = await _transcribe_round(audio, session["language"], seconds, n)
    except HTTPException:
        db.add_round(session_id, n, seconds, 0, 0, [], stored)
        raise
    db.add_round(session_id, n, seconds, stats["words"], stats["long_pauses"],
                 stats["sentences"], stored)
    return _round_response(n, seconds, stats)


@router.post("/sessions/{session_id}/timed/rounds/{n}/transcribe")
async def retranscribe_timed_round(session_id: int, n: int):
    """Transcribe a round again from its saved recording -- the retry after a 503."""
    session = _timed_session(session_id)
    rnd = _timed_round(session_id, n)
    if rnd["sentences"]:
        raise HTTPException(409, "this round is already transcribed")
    path = config.AUDIO_DIR / Path(rnd["audio_path"] or "").name
    if not rnd["audio_path"] or not path.is_file():
        raise HTTPException(404, "no recording for this round")
    stats = await _transcribe_round(path.read_bytes(), session["language"], rnd["seconds"], n)
    db.set_round_transcript(session_id, n, stats["words"], stats["long_pauses"], stats["sentences"])
    return _round_response(n, rnd["seconds"], stats)


def _graded_response(i: int, s: dict) -> dict:
    out = {"i": i, "text": s["text"], "ok": s["ok"], "fixed": s["fixed"],
           "correction": s["correction"], "suggestion": s["suggestion"], "tag": s["tag"]}
    if s.get("filler"):
        out["filler"] = True
    return out


def _is_filler_only(text: str, language: str) -> bool:
    return not _WORD_CHAR.search(text_cleanup.strip_fillers(text, language))


@router.post("/sessions/{session_id}/timed/rounds/{n}/grade/{i}")
def grade_timed_sentence(session_id: int, n: int, i: int):
    """Grade one sentence of a round with the same _feedback every turn gets.

    Only round 1 is practice record: its sentences become messages rows (and a
    wrong one joins tomorrow's review), so a retelling of the same minute never
    counts twice toward accuracy, weak spots or reviews. A sentence already
    graded comes back as stored, with no model call and no second row.
    """
    session = _timed_session(session_id)
    rnd = _timed_round(session_id, n)
    if not 0 <= i < len(rnd["sentences"]):
        raise HTTPException(404, "no such sentence")
    sentence = rnd["sentences"][i]
    if sentence["graded"]:
        return _graded_response(i, sentence)

    language = session["language"]
    text = sentence["text"]
    if _is_filler_only(text, language):
        # Nothing but "Um." -- there is nothing to grade, and _feedback would
        # either skip it (ok None, so the client retries forever) or send the
        # bare punctuation to the model. It is done: graded, no verdict, no
        # messages row, no model call.
        with _ROUND_WRITE:
            current = _timed_round(session_id, n)["sentences"]
            if not current[i]["graded"]:
                current[i] = {**current[i], "graded": True, "ok": None, "fixed": None,
                              "correction": None, "suggestion": None, "tag": None,
                              "message_id": None, "filler": True}
                db.set_round_sentences(session_id, n, current)
        return _graded_response(i, current[i])
    # The question is literally what the learner is answering -- the line
    # said right before, not a lesson topic ("오늘 수업 주제" in the prompt).
    feedback = _feedback(language, text, bot_last=session["topic"])
    if feedback["ok"] is None:
        # The model failed: leave it ungraded so the client can offer a retry.
        return {"i": i, "text": text, **feedback}

    with _ROUND_WRITE:
        current = _timed_round(session_id, n)["sentences"]
        if current[i]["graded"]:
            # Another request graded it while the model was thinking.
            return _graded_response(i, current[i])
        message_id = None
        if n == 1:
            message_id = db.add_message(session_id, "user", text,
                                        correction=feedback["correction"],
                                        suggestion=feedback["suggestion"],
                                        ok=feedback["ok"], fixed=feedback["fixed"],
                                        tag=feedback["tag"])
            if feedback["ok"] is False and feedback["fixed"]:
                db.enqueue_review(message_id, language, _today() + timedelta(days=1))
        current[i] = {**current[i], **feedback, "graded": True, "message_id": message_id}
        db.set_round_sentences(session_id, n, current)
    return _graded_response(i, current[i])


def _native_ok(text: str, language: str) -> bool:
    if _HANGUL.search(text):
        return False
    if language == "ja":
        return bool(_KANA.search(text))
    return bool(_LATIN_LETTER.search(text))


@router.post("/sessions/{session_id}/timed/rounds/{n}/native")
def timed_native(session_id: int, n: int):
    """원어민이라면: one model call rewriting the round as a native speaker's
    one-minute answer, a step above the learner's level -- plus, for round 1
    only, the model's read of the learner's level. Stored once; asked again,
    the stored answer comes back with no model call."""
    session = _timed_session(session_id)
    rnd = _timed_round(session_id, n)
    language = session["language"]
    if rnd["native"]:
        return {"native": rnd["native"], "level": rnd["level"],
                "audio_key": _speak(rnd["native"], language)}
    said = [s["fixed"] if s["ok"] is False and s["fixed"] else s["text"]
            for s in rnd["sentences"]
            if not (s.get("filler") or _is_filler_only(s["text"], language))]
    if not said:
        raise HTTPException(503, TIMED_NATIVE_UNAVAILABLE)
    messages = prompts.build_timed_native_messages(
        language, session["topic"], said, db.stable_level(language) or "beginner")
    try:
        result = llm.chat_json(messages, prompts.timed_native_schema())
        native = result.get("native")
        level = result.get("level")
    except Exception:
        log.warning("timed native answer failed", exc_info=True)
        raise HTTPException(503, TIMED_NATIVE_UNAVAILABLE)
    native = native.strip() if isinstance(native, str) else ""
    if (not native or not _native_ok(native, language)
            or timed.count_words(native, language) > _NATIVE_MAX[language]):
        raise HTTPException(503, TIMED_NATIVE_UNAVAILABLE)
    level = str(level or "").strip().lower() if n == 1 else None
    if level not in config.LEVELS:
        level = None
    db.set_round_native(session_id, n, native, level)
    return {"native": native, "level": level, "audio_key": _speak(native, language)}


REPORT_UNAVAILABLE = "리포트를 만들지 못했습니다. 대화 기록은 그대로 저장되어 있습니다."


def _transcript(session_id: int) -> str:
    session = db.get_session(session_id)
    lines = []

    # In script mode the learner was reading fixed lines, so the report is far
    # more useful if the model can compare what they said against the original.
    if session and session["mode"] == "script" and session["scenario_id"]:
        scenario = scenarios.get_scenario(session["scenario_id"])
        if scenario:
            lines.append("The script the learner was reading from:")
            lines += [f"  {l['speaker']}: {l['text']}" for l in scenario["lines"]]
            lines.append("")
            lines.append("What the learner actually said:")

    for m in db.get_messages(session_id):
        lines.append(f"{m['speaker']}: {m['text']}")
        if m["correction"]:
            lines.append(f"  [correction] {m['correction']}")
        if m["suggestion"]:
            lines.append(f"  [suggestion] {m['suggestion']}")
        if m["tag"] and m["tag"] != "없음":
            lines.append(f"  [tag] {m['tag']}")
    return "\n".join(lines)


def _unlink_audio(paths) -> None:
    """Delete recording files given their stored paths.

    app/db.py never touches the filesystem, so this is where every caller
    that has audio_path values in hand -- from a full session sweep or from a
    single undone turn -- actually unlinks them. Only the basename of the
    stored path is used, so this can never reach outside AUDIO_DIR even if a
    stored value were ever unexpected.

    Never raises: losing a recording is not worth failing the request it was
    incidental to.
    """
    for stored in paths:
        try:
            (config.AUDIO_DIR / Path(stored).name).unlink(missing_ok=True)
        except OSError:
            pass


def _forget_recordings(session_id: int) -> None:
    """Delete one session's clips from disk.

    db.clear_session_audio only nulls the audio_path column and hands back
    the paths it cleared -- the actual unlink is _unlink_audio's job.
    """
    _unlink_audio(db.clear_session_audio(session_id))


def _sweep_recordings(session_id: int) -> None:
    """Best-effort cleanup shared by every path that ends a session: forget
    this session's own clips, then sweep any sessions nobody came back to
    while we're here. A failure here is housekeeping, not something the
    caller's already-committed report should turn into an error."""
    try:
        _forget_recordings(session_id)
        for stale in db.stale_open_sessions():
            _forget_recordings(stale)
    except Exception:
        pass


def _shadow_report(session: dict) -> dict:
    """Shadowing's report: counts and the lines to try again. No model call and
    no level -- the learner repeated lines they were given, which says nothing
    about the level they would speak at."""
    summary = db.shadow_summary(session["id"])
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    summary["lines"] = len(scenario["lines"]) if scenario else summary["done"]
    for h in summary["hard"]:
        h["audio_key"] = _speak(h["target"], session["language"])
    stats = db.session_stats(session["id"])
    stats["minutes"] = db.active_minutes(session["id"])
    return {"kind": "shadow", "summary": "", "weak_points": [], "expressions": [], "next_focus": "",
            "level": None, "stats": stats, "shadow": summary}


def _timed_report(session: dict) -> dict:
    """1분 말하기's report: every round exactly as it was graded live, plus the
    level round 1 settled on. No model call, like _shadow_report -- a timed
    session is graded sentence by sentence as it happens, so by the time it
    ends there is nothing left to ask the model for.

    wpm is recomputed here rather than read back from storage (round rows
    don't carry it): round(words / (max(seconds, 1) / 60)), same formula as
    app/timed.py's round_stats so a round's number never drifts from what the
    learner saw while recording it.

    `stats` mirrors what the free/lesson report shows, but built from round 1
    alone: `turns` is every sentence round 1 produced (whether graded or
    not), `wrong` is how many of them came back marked wrong, and `minutes`
    sums every round's own seconds -- round 2+ took real time even though
    only round 1 becomes messages rows. Minutes round half up (not Python's
    banker's round(), which reads 30 s as 0) and are at least 1 once there is
    a round.
    """
    rounds = db.get_rounds(session["id"])
    round_reports = [{
        "round": r["round"],
        "seconds": r["seconds"],
        "words": r["words"],
        "wpm": round(r["words"] / (max(r["seconds"], 1) / 60)),
        "long_pauses": r["long_pauses"],
        "fixed": sum(1 for s in r["sentences"] if s["ok"] is False),
        "graded": sum(1 for s in r["sentences"] if s["graded"] and not s.get("filler")),
        "sentences": r["sentences"],
        "native": r["native"],
    } for r in rounds]
    first_sentences = rounds[0]["sentences"] if rounds else []
    return {
        "kind": "timed", "topic": session["topic"], "level": rounds[0]["level"] if rounds else None,
        "rounds": round_reports, "summary": "", "weak_points": [], "expressions": [], "next_focus": "",
        "stats": {
            "turns": len(first_sentences),
            "wrong": sum(1 for s in first_sentences if s["ok"] is False),
            "minutes": max(int(sum(r["seconds"] for r in rounds) / 60 + 0.5), 1) if rounds else 0,
        },
    }


@router.post("/sessions/{session_id}/end")
def finish_session(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")

    if session["shadowing"]:
        result = _shadow_report(session)
        db.end_session(session_id, json.dumps({"kind": "shadow"}), None)
        tomorrow = _today() + timedelta(days=1)
        for h in result["shadow"]["hard"]:
            db.enqueue_review(h["message_id"], session["language"], tomorrow)
        _sweep_recordings(session_id)
        return result

    if session["mode"] == "timed":
        result = _timed_report(session)
        db.end_session(session_id, json.dumps({"kind": "timed"}), result["level"])
        _sweep_recordings(session_id)
        return result

    stats = db.session_stats(session_id)
    # The right-hand panel's "분" -- active time, not wall time since the
    # session opened (see db.active_minutes).
    stats["minutes"] = db.active_minutes(session_id)
    try:
        result = llm.chat_json(
            prompts.build_report_messages(session["language"], _transcript(session_id), stats),
            prompts.REPORT_SCHEMA,
        )
    except Exception:
        result = {}

    report = {
        "summary": result.get("summary") or REPORT_UNAVAILABLE,
        "weak_points": result.get("weak_points") or [],
        "expressions": result.get("expressions") or [],
        "next_focus": result.get("next_focus") or "",
    }

    # The schema constrains this, but a local model can still drift. Normalise
    # case and whitespace first: a stray "Advanced" is the model getting the
    # value right, and silently demoting it would change how the next lesson
    # teaches. Anything genuinely unrecognised still falls back to beginner.
    level = str(result.get("level") or "").strip().lower()
    if level not in config.LEVELS:
        level = "beginner"

    # sessions.report is TEXT, so storing JSON keeps the whole report in one
    # column without a migration. Sessions written before this change hold
    # plain prose there instead of JSON -- nothing in this phase reads a
    # report back from storage, but a later phase that does (e.g. a session
    # history screen) will need to handle both shapes.
    db.end_session(session_id, json.dumps(report, ensure_ascii=False), level)

    _sweep_recordings(session_id)

    return {**report, "level": level, "stats": stats}


@router.get("/sessions")
def session_history(limit: int = Query(default=20, ge=1, le=100)):
    return {"sessions": db.list_sessions(limit)}


@router.get("/sessions/resumable")
def resumable(language: Language):
    """Offer the session the learner walked away from, and clear out the ones
    they are never coming back to while we are here.

    Registered before /sessions/{session_id}: FastAPI matches routes in
    registration order, so if that route came first it would swallow
    "resumable" as a session_id and return 422.
    """
    # Order matters and must not be swapped: stale_open_sessions only sees
    # sessions where ended_at IS NULL, so it must run -- and its recordings
    # must be collected -- before abandon_stale_sessions stamps ended_at on
    # that same population. Reverse the order and those sessions' audio can
    # never be found again; it would sit on disk forever, which is exactly
    # the guarantee (recordings are deleted once a session is over) this
    # project promised the learner in exchange for writing a report instead.
    # Best-effort like finish_session's identical cleanup: a failure here is
    # housekeeping, not something the resumable lookup below should surface.
    try:
        for stale in db.stale_open_sessions():
            _forget_recordings(stale)
        db.abandon_stale_sessions()
    except Exception:
        pass
    session = db.resumable_session(language)
    if session is None:
        return {"session": None}
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    return {"session": {
        "id": session["id"], "mode": session["mode"], "turns": session["turns"],
        "title": scenario["title"] if scenario else (session["topic"] or "수업"),
        # Same rule as POST /sessions' opening response: the scenario's goal
        # when there is a scenario, None for a lesson or scenario-less session.
        "goal": scenario.get("goal") if scenario else None,
    }}


_WEEKDAY_LABELS = "월화수목금토일"
_WEEKLY_GOAL_KEY = "weekly_goal"
_WEEKLY_GOAL_DEFAULT = 5
_RECENT_THEMES = 4


def _today() -> date:
    # Local, like db.home_stats -- the learner's week starts at their Monday midnight.
    return datetime.now().date()


def _weekly_goal() -> int:
    try:
        goal = int(db.get_setting(_WEEKLY_GOAL_KEY, _WEEKLY_GOAL_DEFAULT))
    except (TypeError, ValueError):
        return _WEEKLY_GOAL_DEFAULT
    return goal if 1 <= goal <= 14 else _WEEKLY_GOAL_DEFAULT


def _week(language, today):
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    practiced = db.practice_days(language, monday, sunday)
    days = []
    for i in range(7):
        d = monday + timedelta(days=i)
        days.append({"date": d.isoformat(), "label": _WEEKDAY_LABELS[i], "practiced": d.isoformat() in practiced,
                     "today": d == today, "future": d > today})
    return {"days": days, "sessions": db.sessions_completed_since(language, monday), "goal": _weekly_goal()}


def _recent_themes(language):
    out, seen = [], set()
    for row in db.library_sessions(language):
        theme_id = library.theme_of(row["scenario_id"])
        theme = library.get_theme(theme_id) if theme_id else None
        if theme is None or theme_id in seen:
            continue
        seen.add(theme_id)
        # A shadowing session is stored as a flagged script session (mode is
        # still "script"); the client needs the flag itself to show 쉐도잉
        # instead of 스크립트 and to start the theme back into shadowing.
        out.append({"theme_id": theme_id, "title": theme["title"], "mode": row["mode"],
                    "shadowing": bool(row["shadowing"])})
        if len(out) == _RECENT_THEMES:
            break
    return out


@router.get("/stats/home")
def home_stats(language: Language):
    stats = db.home_stats(language)
    stats["recent"] = [_recent_row(r) for r in db.recent_sessions(language)]
    today = _today()
    stats["has_history"] = db.has_sessions(language)
    stats["week"] = _week(language, today)
    stats["recommend"] = library.recommend(language, today)
    stats["recent_themes"] = _recent_themes(language)
    stats["library"] = {"scripts": db.library_script_count(language),
                        "target": len(library.load_themes()) * config.LIBRARY_PER_THEME}
    counts = db.review_counts(language, today)
    first = db.due_reviews(language, today, limit=1)
    stats["review"] = {"due": counts["due"],
                       "first": {"id": first[0]["id"], "fixed": first[0]["fixed"]} if first else None}
    return stats


class WeeklyGoal(BaseModel):
    goal: int = Field(ge=1, le=14)


@router.post("/settings/weekly-goal")
def set_weekly_goal(payload: WeeklyGoal):
    db.set_setting(_WEEKLY_GOAL_KEY, str(payload.goal))
    return {"goal": payload.goal}


def _recent_row(row: dict) -> dict:
    """최근 연습 한 줄. title 은 절대 비지 않는다.

    순서는 /sessions/resumable 이 제목을 고르는 순서와 같다: 시나리오가 있으면
    그 제목, 없으면 topic, 둘 다 없으면 고정 문자열. 다만 마지막 고정 문자열은
    다르다 -- resumable은 "수업"으로 떨어지고(다시 들어갈 살아 있는 수업 하나를
    가리키므로), 이쪽은 "자유 대화"로 떨어진다(모든 모드의 끝난 세션을 나열하는
    목록이므로). 그래서 이 로직을 resumable과 공유하지 않는다: 두 화면은 애초에
    같이 움직여야 할 이유가 없고, 공유하면 한쪽만 바뀌어야 할 때 다른 쪽도 따라
    바뀌어야 한다.
    """
    scenario = scenarios.get_scenario(row["scenario_id"]) if row["scenario_id"] else None
    return {
        "id": row["id"],
        "title": (scenario["title"] if scenario else row["topic"]) or "자유 대화",
        "ended_at": row["ended_at"],
        "fixed": row["fixed"],
        "shadowing": bool(row.get("shadowing")),
    }


def _resumable_audio_key(text: str, language: str, voice: str) -> str | None:
    """The clip's cache key if it is already on disk, else None -- never
    synthesises.

    Only reachable for bot messages: those are the only ones this app ever
    hands to TTS, and their clip (if it still exists) was made while the
    session was live. Deliberately never calls synthesize/synthesize_to_cache
    here -- this backs the resume path, which replays every message in the
    conversation at once, and putting N TTS calls on that path could stall
    reopening a long session on a cold cache. A missing clip just means the
    learner hears nothing when they click that bubble again, which is the
    honest answer -- nothing failed just now, nothing was attempted.
    """
    key = tts.cache_key(clean_for_tts(text), language, voice)
    return key if tts.cached_path(key).exists() else None


_LEVEL_NEED_SESSIONS = 3
_LEVEL_NEED_UTTERANCES = 15
_ACCURACY_DAYS = 30
_HISTORY_PAGE = 20


COACH_UNAVAILABLE = "지금은 코치 한마디를 만들 수 없어요"
_COACH_DAYS = 30
_COACH_MIN_WRONG = 5
_COACH_MAX_ITEMS = 3
_COACH_EXAMPLE_HABITS = frozenset(i["habit"].strip() for i in prompts.COACH_EXAMPLE_OUTPUT["items"])
_coach_locks = {"en": threading.Lock(), "ja": threading.Lock()}


class _NoCoach(Exception):
    pass


def _valid_coach_items(raw, rows, kept: list[dict]) -> list[dict]:
    """Items that can be shown, appended to `kept`. The model names its
    example by number only; the sentence shown is the learner's own row, so
    an invented example cannot reach the screen. A habit or tip that is not
    Korean (a Chinese leak, an English answer) is dropped -- quoted target-
    language phrases inside a tip are allowed, as in the ▸ 뜻 check. A habit
    copied word for word from the few-shot answer is the example talking, not
    the learner's sentences, and is dropped too."""
    out = list(kept)
    source = "\n".join(f"{r['text']} {r['fixed']}" for r in rows)
    for item in raw if isinstance(raw, list) else []:
        if len(out) >= _COACH_MAX_ITEMS:
            break
        if not isinstance(item, dict):
            continue
        habit, tip, no = item.get("habit"), item.get("tip"), item.get("example_no")
        if not (isinstance(habit, str) and isinstance(tip, str) and isinstance(no, int)):
            continue
        habit, tip = _first_line(habit), _first_line(tip)
        if not habit or not tip or not 1 <= no <= len(rows):
            continue
        if not (_is_korean_meaning(habit, source=source) and _is_korean_meaning(tip, source=source)):
            continue
        if habit in _COACH_EXAMPLE_HABITS or any(o["habit"] == habit for o in out):
            continue
        row = rows[no - 1]
        out.append({"habit": habit, "tip": tip, "said": row["text"], "fixed": row["fixed"], "tag": row.get("tag")})
    return out


def _generate_coach(language, rows) -> list[dict]:
    """Two or three habits, or _NoCoach. Fewer than two survivors earns one
    more sample at the same temperature; a dead model does not (same rule as
    _generate_suggestions)."""
    messages = prompts.build_coach_messages(language, rows)
    kept: list[dict] = []
    for _ in range(2):
        try:
            result = llm.chat_json(messages, prompts.coach_schema(), temperature=0.3)
        except Exception as exc:
            if kept:
                break
            raise _NoCoach from exc
        kept = _valid_coach_items(result.get("items") if isinstance(result, dict) else None, rows, kept)
        if len(kept) >= 2:
            break
    if not kept:
        raise _NoCoach
    return kept


@router.get("/mypage/coach")
def mypage_coach(language: Language):
    """코치 한마디: habits read off the learner's own wrong sentences, made
    once a day per language. The lock keeps two opens of the weak tab (or two
    tabs) from making the same note twice; the second waits and reads the
    first's."""
    today = _today()
    since = today - timedelta(days=_COACH_DAYS - 1)
    count = db.wrong_count_since(language, since)
    if count < _COACH_MIN_WRONG:
        return {"status": "too_few", "count": count, "need": _COACH_MIN_WRONG}
    with _coach_locks[language]:
        cached = db.get_coach(language)
        if cached and cached["day"] == today.isoformat():
            return {"status": "ready", "day": cached["day"], "count": count, "items": cached["items"]}
        rows = db.coach_inputs(language, since)
        try:
            items = _generate_coach(language, rows)
        except _NoCoach:
            raise HTTPException(503, COACH_UNAVAILABLE)
        db.save_coach(language, today.isoformat(), items)
    return {"status": "ready", "day": today.isoformat(), "count": count, "items": items}


@router.get("/stats/mypage")
def mypage_stats(language: Language):
    today = _today()
    sample = db.level_sample(language)
    enough = sample["sessions"] >= _LEVEL_NEED_SESSIONS and sample["utterances"] >= _LEVEL_NEED_UTTERANCES
    # A finished level test is the level however thin the practice sample is
    # (db.stable_level reads it first); the thin-sample gate is only for the
    # session-mode guess.
    test = db.latest_level_test(language)
    summary = ({k: test["result"].get(k) for k in ("cefr", "step", "ielts", "toefl", "jf", "finished_at")}
               if test else None)
    return {
        "level": {"value": db.stable_level(language) if test or enough else None, **sample,
                  "need_sessions": _LEVEL_NEED_SESSIONS, "need_utterances": _LEVEL_NEED_UTTERANCES,
                  "test": summary},
        "accuracy": db.accuracy_since(language, today - timedelta(days=_ACCURACY_DAYS - 1)),
        "tags": db.wrong_tag_counts(language),
        "review": db.review_counts(language, today),
    }


@router.get("/review")
def review_items(language: Language):
    items = db.due_reviews(language, _today())
    return {"items": [{**{k: i[k] for k in ("id", "text", "fixed", "correction", "tag", "created_at")},
                       "shadowing": bool(i["shadowing"])} for i in items]}


class ReviewResult(BaseModel):
    result: Literal["pass", "fail", "skip"]


@router.post("/review/{review_id}/result")
def review_result(review_id: int, payload: ReviewResult):
    try:
        return db.record_review(review_id, payload.result, _today())
    except KeyError:
        raise HTTPException(404, "no such review")
    except ValueError:
        raise HTTPException(409, "already mastered")


@router.post("/review/{review_id}/audio")
def review_audio(review_id: int):
    review = db.get_review(review_id)
    if review is None:
        raise HTTPException(404, "no such review")
    message = db.get_message(review["message_id"])
    return {"audio_key": _speak(message["fixed"], review["language"]) if message and message["fixed"] else None}


@router.get("/sessions/history")
def session_history_page(language: Language, offset: int = Query(default=0, ge=0)):
    rows = db.history(language, offset, _HISTORY_PAGE + 1)
    items = []
    for row in rows[:_HISTORY_PAGE]:
        # _recent_row only reads "fixed" to pass it through unused here (we only
        # want its "title"); reusing it for the wrong count is harmless stand-in data.
        titled = _recent_row({**row, "fixed": row["wrong"]})
        items.append({"id": row["id"], "ended_at": row["ended_at"], "title": titled["title"],
                      "mode": row["mode"], "turns": row["turns"], "wrong": row["wrong"],
                      "graded": row["graded"], "shadowing": bool(row.get("shadowing")),
                      "rounds": row["rounds"]})
    return {"items": items, "more": len(rows) > _HISTORY_PAGE}


@router.get("/sessions/{session_id}/report")
def session_report(session_id: int):
    session = db.get_session(session_id)
    if session is None or not session["report"]:
        raise HTTPException(404, "no report for this session")
    # A prose report predates graded turns: its sessions were never graded, so
    # graded: false tells the report screen not to count them as ungraded.
    graded = True
    try:
        report = json.loads(session["report"])
        if not isinstance(report, dict):
            raise ValueError
    except ValueError:
        report = {"summary": session["report"]}
        graded = False
    if session["shadowing"]:
        return {**_shadow_report(session), "mode": session["mode"], "shadowing": True, "graded": True}
    if report.get("kind") == "timed":
        return {**_timed_report(session), "mode": session["mode"], "graded": True}
    stats = db.session_stats(session_id)
    stats["minutes"] = db.active_minutes(session_id)
    return {"summary": report.get("summary") or "", "weak_points": report.get("weak_points") or [],
            "expressions": report.get("expressions") or [], "next_focus": report.get("next_focus") or "",
            "level": session["level"], "stats": stats, "mode": session["mode"], "graded": graded}


@router.get("/sessions/{session_id}")
def session_detail(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    messages = db.get_messages(session_id)
    voice = selected_voice(session["language"])
    for m in messages:
        m["audio_key"] = (
            _resumable_audio_key(m["text"], session["language"], voice)
            if m["speaker"] == "bot" else None
        )
    return {"session": session, "messages": messages}



# ---------------------------------------------------------------------------
# 레벨 테스트 (docs/superpowers/specs/2026-09-19-monologue-level-test-design.md).
# Nothing here is practice: no session, no messages row, no review, and no
# recording is kept -- each upload is transcribed and thrown away. A finished
# test's app_level becomes db.stable_level's answer, which every level consumer
# reads, so the whole app follows it.
# ---------------------------------------------------------------------------

LEVEL_STT_UNAVAILABLE = "받아쓰기를 할 수 없어요"
LEVEL_NOT_DONE = "아직 따라 말하기가 끝나지 않았어요"
LEVEL_NO_VOICE = "지금은 문장 음성을 준비할 수 없어요"
LEVEL_NO_STT = "지금은 받아쓰기를 할 수 없어요"
_LEVEL_ANSWER_MAX_SECONDS = 60


class LevelTestStart(BaseModel):
    language: Language


@router.post("/level-test")
def start_level_test(payload: LevelTestStart):
    """The sentences go out as audio only: the learner repeats what they
    heard, so sending the text would hand them the answer -- which also means
    there is no browser-voice fallback. No voice, no test: the voices are made
    first, the first one TTS cannot make is a 503, and only then is a test row
    created, so a failed start leaves nothing behind. Every step is judged
    from a transcription, so a speech model that failed to load stops the
    test here rather than seven minutes in; one still loading is let through,
    since the uploads retry on 503 until it is ready."""
    if stt.status() == "unavailable":
        raise HTTPException(503, LEVEL_NO_STT)
    language = payload.language
    bank = leveltest.load_bank(language)
    items = []
    for it in bank["items"]:
        key = _speak(it["text"], language)
        if key is None:
            raise HTTPException(503, LEVEL_NO_VOICE)
        items.append({"i": it["i"], "audio_key": key})
    test_id = db.create_level_test(language)
    return {"test_id": test_id, "items": items,
            "questions": [{"q": q["q"], "text": q["text"], "meaning": q["meaning"]}
                          for q in bank["questions"]]}


def _open_level_test(test_id: int) -> dict:
    test = db.get_level_test(test_id)
    if test is None:
        raise HTTPException(404, "no such level test")
    if test["finished_at"]:
        raise HTTPException(409, "this level test is already finished")
    return test


async def _read_level_audio(file: UploadFile) -> bytes:
    audio = await file.read(_MAX_TRANSCRIBE_BYTES + 1)
    if len(audio) > _MAX_TRANSCRIBE_BYTES:
        raise HTTPException(413, "녹음이 너무 큽니다")
    return audio


async def _level_stt(fn, audio: bytes, language: str):
    try:
        return await run_in_threadpool(fn, audio, language)
    except stt.SttUnavailable:
        log.debug("stt unavailable for a level test upload; the client retries")
        raise HTTPException(503, LEVEL_STT_UNAVAILABLE)
    except Exception:
        # A real failure, not a model still loading -- see /transcribe.
        log.warning("level test transcription failed", exc_info=True)
        raise HTTPException(503, LEVEL_STT_UNAVAILABLE)


@router.post("/level-test/{test_id}/items/{i}")
async def level_test_item(test_id: int, i: int, file: UploadFile = File(...)):
    """One repeated sentence: transcribe, score against the hidden original,
    keep only what was heard and the score. Uploading the same i again
    replaces it (the client retries a failed upload)."""
    test = _open_level_test(test_id)
    language = test["language"]
    items = leveltest.load_bank(language)["items"]
    if not 0 <= i < len(items):
        raise HTTPException(404, "no such item")
    audio = await _read_level_audio(file)
    heard = await _level_stt(stt.transcribe, audio, language)
    db.set_level_item(test_id, i, heard, leveltest.item_score(heard, items[i]["text"], language))
    return {"i": i, "done": True}


@router.post("/level-test/{test_id}/answers/{q}")
async def level_test_answer(test_id: int, q: int, seconds: float = Form(...),
                            file: UploadFile = File(...)):
    test = _open_level_test(test_id)
    language = test["language"]
    if not 0 <= q < len(leveltest.load_bank(language)["questions"]):
        raise HTTPException(404, "no such question")
    # 45 s on the client's clock; wpm divides by it, so nan/inf/0 never get in.
    if not (math.isfinite(seconds) and 0 < seconds <= _LEVEL_ANSWER_MAX_SECONDS):
        raise HTTPException(422, "seconds must be a real length, 0 < seconds <= 60")
    audio = await _read_level_audio(file)
    segments = await _level_stt(stt.transcribe_segments, audio, language)
    stats = timed.round_stats(segments, language, seconds)
    # Japanese is written without spaces between sentences.
    joiner = "" if language == "ja" else " "
    db.set_level_answer(test_id, q, {"text": joiner.join(stats["sentences"]), "seconds": seconds,
                                     "words": stats["words"], "wpm": stats["wpm"],
                                     "long_pauses": stats["long_pauses"]})
    return {"q": q, "done": True}


def _level_judgments(raw, answers: dict) -> dict:
    """{q: {"cefr", "comment"}} from one model answer. The comment is "" unless
    it is Korean; a word quoted from that learner's own answer (「週末」) is
    not a leak. "raw_comment" keeps the untranslated comment when it failed the
    Korean check, so _judge_level_answers can try translating it instead of
    dropping it outright."""
    items = raw.get("answers") if isinstance(raw, dict) else None
    out: dict = {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        q, cefr = item.get("q"), item.get("cefr")
        if not isinstance(q, int) or q not in answers or q in out or cefr not in leveltest.CEFR:
            continue
        comment = item.get("comment")
        comment = _first_line(comment) if isinstance(comment, str) else None
        korean = comment and _is_korean_meaning(comment, source=answers[q]["text"] or "")
        out[q] = {"cefr": cefr, "comment": comment if korean else "",
                  "raw_comment": None if korean else comment}
    return out


def _judge_level_answers(language: str, answers: dict, questions: list) -> dict:
    """{q: {"cefr", "comment"}} from the model, or {} when there is nothing
    to judge or the model fails -- the test then stands on the sentences alone.

    A comment that is not Korean earns one re-ask (a Japanese answer pulls the
    comment into Japanese even with a Korean example); the comments come from
    the retry, falling back to a ja->ko translation of whichever call's raw
    Japanese comment is freshest when both calls leak, and "" only when
    neither call's raw comment looks Japanese or the translation itself
    fails. The cefr stays either way -- the label is the part the score uses
    -- and the first call's label holds wherever the retry fails or leaves
    it out."""
    if not answers:
        return {}
    by_q = {q["q"]: q for q in questions}
    qa = [{"q": q, "question": by_q[q]["text"], "text": a["text"], "wpm": a["wpm"],
           "long_pauses": a["long_pauses"]} for q, a in sorted(answers.items())]
    messages = prompts.build_level_answers_messages(language, qa)
    schema = prompts.level_answers_schema()
    try:
        raw = llm.chat_json(messages, schema)
    except Exception:
        log.warning("level test answer judging failed; the result stands on the sentences",
                    exc_info=True)
        return {}
    out = _level_judgments(raw, answers)
    # raw_comment only matters for the merge and the translation fallback
    # below; strip it from what a caller sees so the {"cefr", "comment"}
    # contract holds either way out.
    result = {q: {"cefr": j["cefr"], "comment": j["comment"]} for q, j in out.items()}
    if all(j["comment"] for j in result.values()):
        return result
    try:
        retry = _level_judgments(llm.chat_json(
            prompts.build_level_answers_retry_messages(messages, json.dumps(raw, ensure_ascii=False)),
            schema), answers)
    except Exception:
        log.warning("level test comment re-ask failed; the first labels stand", exc_info=True)
        retry = {}
    for q, j in retry.items():
        first = result.get(q, {})
        comment = j["comment"] or first.get("comment", "")
        result[q] = {"cefr": j["cefr"], "comment": comment}
    # Measured on the real model twice: a Japanese B1 answer pulls the
    # comment into Japanese, and the Korean re-ask ALSO comes back Japanese
    # -- or the re-ask raises, comes back unparseable, or simply omits that
    # q, in which case the FIRST call's Japanese comment is the only one
    # there is. Either way, rather than drop it, translate it with the same
    # checked ja->ko path the ▸ 뜻 button uses (_cached_translation) -- it
    # already rejects Chinese leaks and returns None on failure. Prefer the
    # retry's raw comment when the retry answered that q, else fall back to
    # the first call's. Only a comment that still fails the Korean check and
    # looks Japanese (has kana) is translated; an English comment that
    # merely isn't Korean is left "".
    for q in result:
        if result[q]["comment"]:
            continue
        raw_comment = retry.get(q, {}).get("raw_comment") or out.get(q, {}).get("raw_comment")
        if raw_comment and _KANA.search(raw_comment):
            translated = _cached_translation(language, raw_comment)
            if translated and _is_korean_meaning(translated, source=answers[q]["text"] or ""):
                result[q]["comment"] = translated
    return result


@router.post("/level-test/{test_id}/finish")
def finish_level_test(test_id: int):
    """Once finished, the stored result comes back as it is -- no second
    model call, no second score."""
    test = db.get_level_test(test_id)
    if test is None:
        raise HTTPException(404, "no such level test")
    if test["result"] is not None:
        return test["result"]
    language = test["language"]
    bank = leveltest.load_bank(language)
    if any(it["i"] not in test["items"] for it in bank["items"]):
        raise HTTPException(400, LEVEL_NOT_DONE)
    scores = [test["items"][it["i"]]["score"] for it in bank["items"]]
    judged = _judge_level_answers(language, test["answers"], bank["questions"])
    score = sum(scores)
    cefr, step = leveltest.cefr_from_ei(score)
    cefr, step = leveltest.apply_boundary(
        score, cefr, step, leveltest.answers_level([j["cefr"] for j in judged.values()]))
    app_level = leveltest.app_level(cefr)
    answers = [{"q": q, "question": bank["questions"][q]["text"], "text": a["text"],
                "cefr": judged.get(q, {}).get("cefr"),
                "comment": judged.get(q, {}).get("comment"), "wpm": a["wpm"],
                "long_pauses": a["long_pauses"]} for q, a in sorted(test["answers"].items())]
    result = {"test_id": test_id, "language": language, "cefr": cefr, "step": step,
              "app_level": app_level,
              "ei": {"score": score, "max": 48, "by_level": leveltest.by_level(scores, bank["items"])},
              "answers": answers, **leveltest.conversions(cefr, step, language)}
    return db.finish_level_test(test_id, result, app_level)


@router.get("/level-test/latest")
def latest_level_test(language: Language):
    test = db.latest_level_test(language)
    return {"result": test["result"] if test else None}
