"""HTTP routes. Thin — every route delegates to a module and shapes the response."""
import functools
import json
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel

from app import config, db, llm, prompts, reading, scenarios, text_cleanup, tts
from app.text_cleanup import clean_for_tts
from app.text_match import normalize
from app.tts import voicevox_backend

router = APIRouter(prefix="/api")

Language = Literal["en", "ja"]
Mode = Literal["free", "script", "lesson"]


class VoiceSelection(BaseModel):
    language: Language
    voice: str


def _voice_setting_key(language: str) -> str:
    return f"voice_{language}"


def selected_voice(language: str) -> str:
    return db.get_setting(_voice_setting_key(language), config.DEFAULT_VOICE[language])


@router.get("/health")
def health():
    return {"ollama": llm.is_healthy(), "voicevox": voicevox_backend.is_healthy()}


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

    try:
        result = llm.chat_json(
            prompts.build_scenario_messages(payload.language, payload.mode, wish),
            prompts.scenario_schema(payload.mode),
        )
    except Exception:
        raise HTTPException(503, "상황을 만들지 못했습니다. 잠시 뒤에 다시 시도해 주세요.")

    item = {
        "id": f"user-{uuid.uuid4().hex[:12]}",
        "language": payload.language,
        "type": payload.mode,
        "title": (result.get("title") or wish).strip(),
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
        raw = llm.chat(prompts.build_translate_messages(text), temperature=0.2)
        # An empty (or whitespace-only) completion is a success by llm.chat's
        # contract -- it did not raise -- but it is exactly the string the 503
        # exists to prevent: a line whose meaning renders as genuinely absent,
        # indistinguishable on screen from a broken feature. Falling through to
        # `return None` here folds that case into the same failure path as a
        # model that is down.
        #
        # Taking only the first non-empty line also enforces the "one line"
        # contract server-side: a model that appends a parenthetical aside or a
        # second sentence still yields a single clean line here. This is
        # deliberately not more clever than that -- no attempt is made to
        # detect or strip an echoed Japanese source line, since a heuristic for
        # that would also mangle a legitimate translation that quotes a
        # loanword, place name, or term in quotation marks. An echo is visible
        # on screen and reportable; an empty string was not, which is the only
        # reason one of these is worth guarding against here and the other isn't.
        for line in raw.strip().splitlines():
            line = line.strip()
            if line:
                return line
        return None
    except Exception:
        return None


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


class SessionStart(BaseModel):
    language: Language
    mode: Mode
    scenario_id: str | None = None
    topic: str | None = None


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
                "suggestion": result.get("suggestion"),
            }
        return {
            "ok": None if ok is None else bool(ok),
            "fixed": fixed,
            "tag": result.get("tag"),
            "correction": result.get("correction"),
            "suggestion": result.get("suggestion"),
        }
    except Exception:
        return dict(_NO_FEEDBACK)


@router.post("/sessions")
def start_session(payload: SessionStart):
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
                                   scenario_id=payload.scenario_id, topic=payload.topic)

    if payload.mode == "script":
        lines = []
        for line in scenario["lines"]:
            # 화자를 가리지 않는다. 학습자가 자기 차례 줄을 미리 듣고 따라 읽는 것이
            # 대본 모드의 핵심 동작이고, 그러려면 내 줄에도 음성이 있어야 한다. 대본은
            # 8줄 남짓이고 tts는 캐시되므로 전부 선합성해도 비용은 무시할 만하다.
            key = _speak(line["text"], payload.language)
            lines.append({"speaker": line["speaker"], "text": line["text"], "audio_key": key})
        return {"session_id": session_id, "mode": "script", "lines": lines}

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
    db.add_message(payload.session_id, "user", text,
                   correction=feedback["correction"],
                   suggestion=feedback["suggestion"],
                   ok=feedback["ok"], fixed=feedback["fixed"], tag=feedback["tag"])

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


@router.delete("/sessions/{session_id}/last-turn")
def undo_last_turn(session_id: int):
    """Discard the most recent learner turn so it can be spoken again."""
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
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


@router.post("/sessions/{session_id}/end")
def finish_session(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")

    stats = db.session_stats(session_id)
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

    # The report is already committed. Cleanup is housekeeping, and no failure
    # in it is worth turning a finished report into an error the learner sees.
    try:
        _forget_recordings(session_id)
        for stale in db.stale_open_sessions():
            _forget_recordings(stale)
    except Exception:
        pass

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


@router.get("/stats/home")
def home_stats(language: Language):
    return db.home_stats(language)


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
