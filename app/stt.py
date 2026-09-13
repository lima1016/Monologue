"""The final transcript of a spoken turn, from faster-whisper.

Chrome's recognition stays as the live preview; this is what the turn is
actually sent as. It is an accuracy layer, never a required path: while the
model loads, on a machine without CUDA, or when anything here fails, the
browser falls back to its own transcript (static/js/session.js).

One model for the process, loaded on a background thread at startup so the
server does not wait ~5-40s before it can serve the page, and a lock so two
requests never share it at once.
"""
import io
import logging
import os
import site
import threading
from pathlib import Path

from app import config

log = logging.getLogger(__name__)


class SttUnavailable(Exception):
    """The model is not loaded (yet, or at all)."""


_lock = threading.Lock()
_model = None
_status = "idle"  # idle | loading | ready | unavailable


def status() -> str:
    return _status


def _register_cuda_dlls():
    """pip's nvidia-cublas-cu12 / nvidia-cudnn-cu12 put their DLLs under
    site-packages/nvidia/*/bin, which Windows does not search. ctranslate2
    fails to load without them (confirmed in the 2026-09-13 spike)."""
    if os.name != "nt":
        return
    for base in site.getsitepackages():
        for bin_dir in (Path(base) / "nvidia").glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


def _default_factory():
    _register_cuda_dlls()
    from faster_whisper import WhisperModel
    return WhisperModel(config.STT_MODEL, device=config.STT_DEVICE,
                        compute_type=config.STT_COMPUTE_TYPE)


def load(factory=None) -> None:
    global _model, _status
    _status = "loading"
    try:
        model = (factory or _default_factory)()
    except Exception:
        _model, _status = None, "unavailable"
        log.warning("faster-whisper could not load; turns will use the "
                    "browser transcript", exc_info=True)
        return
    _model, _status = model, "ready"
    log.info("faster-whisper %s ready", config.STT_MODEL)


def start_loading(factory=None):
    global _status
    if _status in ("loading", "ready"):
        return None
    _status = "loading"
    thread = threading.Thread(target=load, args=(factory,), name="stt-loader", daemon=True)
    thread.start()
    return thread


def transcribe(audio: bytes, language: str) -> str:
    if _status != "ready" or _model is None:
        raise SttUnavailable(_status)
    with _lock:
        # Never pass a script line as initial_prompt: a hint makes a misread
        # line come back as the script, which inflates the accuracy score.
        segments, _info = _model.transcribe(
            io.BytesIO(audio), language=language, vad_filter=True,
            beam_size=1, condition_on_previous_text=False,
        )
        return "".join(segment.text for segment in segments).strip()


def _reset_for_tests() -> None:
    global _model, _status
    _model, _status = None, "idle"
