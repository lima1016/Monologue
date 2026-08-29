"""Prepare LLM output for speech synthesis.

The model is told not to emit markdown or emoji, but instructions are not a
guarantee, and a TTS engine will happily read asterisks aloud. This runs on the
TTS input only — the screen and the database always keep the original text.
"""
import re

from app import config

_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF️⤴⤵]+"
)
_PARENTHETICAL = re.compile(r"\s*[(（][^)）]*[)）]")
_LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*{1,3}|_{1,3}|`+|~~)")
_SENTENCE_END = re.compile(r"[.!?。！？]")


def clean_for_tts(text: str, max_chars: int | None = None) -> str:
    if not text:
        return ""
    limit = config.MAX_TTS_CHARS if max_chars is None else max_chars

    out = _EMOJI.sub("", text)
    out = _PARENTHETICAL.sub("", out)
    out = _HEADING.sub("", out)
    out = _LIST_MARKER.sub("", out)
    out = _EMPHASIS.sub("", out)
    out = re.sub(r"\s+", " ", out).strip()

    if len(out) <= limit:
        return out
    return _truncate(out, limit)


def _truncate(text: str, limit: int) -> str:
    """Cut at the last sentence end that fits; fall back to a hard cut."""
    ends = [m.end() for m in _SENTENCE_END.finditer(text) if m.end() <= limit]
    if ends:
        return text[: ends[-1]].strip()
    return text[:limit]
