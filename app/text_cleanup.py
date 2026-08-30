"""Prepare model input and output around the learner's spoken text.

Both functions here follow the same contract: they run on a *copy* of the text
sent to a model, never on what the learner actually said. The screen and the
database always keep the original text.
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

# Speech-recognition filler words, stripped only before the text is sent for
# grammar grading -- not from what is shown or stored. Kept deliberately
# narrow: only tokens that are *never* a real word or content-bearing particle
# on their own. That rules out "like", "well", "so" (all real English words
# doing real work in a sentence) and "あの" (a real Japanese demonstrative,
# "that (over there)" / a hedging "um" -- indistinguishable from a token, so
# stripping it would delete meaning some of the time). "uh"/"um"/"er"/"erm"/
# "hmm" and "えーと"/"えっと"/"ええと" have no other job. \b keeps English
# matches to standalone tokens so "umbrella" or "faster" are untouched.
_FILLERS = {
    "en": re.compile(r"\b(?:uh|um|er|erm|hmm)\b", re.IGNORECASE),
    "ja": re.compile(r"えーと|えっと|ええと"),
}


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


def strip_fillers(text: str, language: str) -> str:
    """Remove standalone speech-disfluency fillers before text is sent for
    grammar grading.

    This runs on the grading input only, the same contract clean_for_tts
    follows for speech synthesis -- the screen and the database always keep
    what the learner actually said, fillers included. If stripping empties
    the text (the learner said nothing but filler), the caller should skip
    grading rather than send an empty string to the model.
    """
    if not text:
        return text
    pattern = _FILLERS.get(language)
    if pattern is None:
        return text
    out = pattern.sub("", text)
    return re.sub(r"\s+", " ", out).strip()
