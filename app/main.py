"""Application entry point.

Run with:
    venv\\Scripts\\python.exe -m uvicorn app.main:app --port 8000

Without --reload: a reload re-loads the 1.6GB Whisper model, and on
Windows the reloader has been seen to hang serving old code.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import config, db, stt
from app.api import router


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    for directory in (config.AUDIO_DIR, config.TTS_CACHE_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    # Background: the page must not wait for a 1.6GB model. Until it is ready
    # /api/transcribe answers 503 and the browser uses its own transcript.
    stt.start_loading()
    yield


app = FastAPI(title="Monologue", lifespan=lifespan)
app.include_router(router)

if config.STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
