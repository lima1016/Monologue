"""Application entry point.

Run with:
    venv\\Scripts\\python.exe -m uvicorn app.main:app --reload --port 8000
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import config, db
from app.api import router


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    for directory in (config.AUDIO_DIR, config.TTS_CACHE_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Monologue", lifespan=lifespan)
app.include_router(router)

if config.STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
