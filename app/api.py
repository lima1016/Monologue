"""HTTP routes. Thin — every route delegates to a module and shapes the response."""
import json
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel

from app import config, db, llm, prompts, scenarios, tts
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


def _feedback(language: str, text: str) -> dict:
    """Structured grammar feedback for one learner line.

    Never raises. A model hiccup must not cost the learner their turn -- the
    conversation continues and the message is stored without feedback. The
    guard covers the whole body, not just the call: chat_json guarantees the
    response parsed as JSON, not that it parsed as an *object*, so a stray
    array or string would otherwise reach .get() and propagate an
    AttributeError out of here.
    """
    try:
        result = llm.chat_json(prompts.build_feedback_messages(language, text),
                               prompts.feedback_schema(language))
        ok = result.get("ok")
        return {
            "ok": None if ok is None else bool(ok),
            "fixed": result.get("fixed"),
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

    session_id = db.create_session(payload.language, payload.mode,
                                   scenario_id=payload.scenario_id, topic=payload.topic)

    if payload.mode == "script":
        lines = []
        for line in scenario["lines"]:
            key = _speak(line["text"], payload.language) if line["speaker"] == "bot" else None
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

    feedback = _feedback(language, text)
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
    db.abandon_stale_sessions()
    session = db.resumable_session(language)
    if session is None:
        return {"session": None}
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    return {"session": {
        "id": session["id"], "mode": session["mode"], "turns": session["turns"],
        "title": scenario["title"] if scenario else (session["topic"] or "수업"),
    }}


@router.get("/sessions/{session_id}")
def session_detail(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    return {"session": session, "messages": db.get_messages(session_id)}
