"""테마 라이브러리: 테마 목록, 생성된 대본의 검사, 다음 대본 고르기.

테마는 data/themes.json(사람이 고치는 목록), 대본은 DB library_scenarios
(scripts/build_library.py가 만든다). 검사는 생성 스크립트와 /scenarios/generate가
함께 쓴다 -- 16줄을 달라고 해도 15줄이 온 적이 있다(2026-09-14 실측).
"""
import difflib
import json
import random
import re
from functools import lru_cache

from app import config, db, scenarios
from app.text_match import normalize

_HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")
_KANA = re.compile(r"[぀-ヿ]")
_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿]")
_LATIN = re.compile(r"[A-Za-zＡ-Ｚａ-ｚ]")
_MAX_WORDS_EN = 20
_MAX_CHARS_JA = 45
_SIMILAR = 0.8


@lru_cache(maxsize=1)
def _themes() -> tuple:
    items = json.loads((config.DATA_DIR / "themes.json").read_text(encoding="utf-8"))
    return tuple(items)


def load_themes() -> list[dict]:
    return list(_themes())


def get_theme(theme_id):
    return next((t for t in _themes() if t["id"] == theme_id), None)


_TITLE_MAX = 40


def korean_title(title, fallback):
    """A card title the learner reads in Korean, or `fallback` (trimmed). The
    model has returned ",$咖啡店點餐" and "They Said No!" for a Korean title
    (2026-09-14): usable only with Hangul in it and no kana or ideographs."""
    text = title.strip() if isinstance(title, str) else ""
    if not text or not _HANGUL.search(text) or _CJK.search(text):
        return fallback.strip()
    return text[:_TITLE_MAX].strip()


def _line_ok(text: str, language: str) -> bool:
    if _HANGUL.search(text):
        return False
    if language == "en":
        return bool(_LATIN.search(text)) and not _CJK.search(text)
    return not _LATIN.search(text)


def _too_long(text: str, language: str) -> bool:
    if language == "en":
        return len(text.split()) > _MAX_WORDS_EN
    return len(normalize(text).replace(" ", "")) > _MAX_CHARS_JA


def _joined(lines) -> str:
    return " ".join(normalize(l["text"]) for l in lines)


def check_script(lines, language, existing=(), *, expected_lines=config.LIBRARY_SCRIPT_LINES,
                 check_duplicates=True):
    """Why this script cannot be used, or None. Order matters: cheap structural
    failures first, so a malformed generation never reaches the similarity pass."""
    if not isinstance(lines, list) or len(lines) != expected_lines:
        return "line-count"
    try:
        if any(not isinstance(l, dict) or not isinstance(l.get("text"), str) for l in lines):
            return "structure"
        scenarios.validate_item({"id": "check", "language": language, "type": "script",
                                 "title": "check", "lines": lines})
    except scenarios.ScenarioError:
        return "structure"
    texts = [l["text"] for l in lines]
    if not all(_line_ok(t, language) for t in texts):
        return "language"
    if language == "ja" and not any(_KANA.search(t) for t in texts):
        return "language"
    if any(_too_long(t, language) for t in texts):
        return "too-long"
    if check_duplicates:
        opening = normalize(texts[0])
        joined = _joined(lines)
        for other in existing:
            if other and normalize(other[0]["text"]) == opening:
                return "same-opening"
            # autojunk=False: on a 200+ character string difflib otherwise
            # drops every character seen in over 1% of it (all common letters)
            # and a copy with 4 of 16 lines reworded measured 0.28, not 0.91.
            if difflib.SequenceMatcher(None, joined, _joined(other), autojunk=False).ratio() >= _SIMILAR:
                return "too-similar"
    return None


def pick_script(language, theme_id, rng=random):
    """다음에 연습할 대본: 한 번도 안 해본 것 중 무작위, 다 해봤으면 가장 오래전에
    한 것. 같은 문장을 반복해 입에 붙이는 것도 연습이라 다 돌면 다시 준다."""
    items = db.library_scenarios(language, theme_id, "script")
    if not items:
        return None
    last = db.last_started([s["id"] for s in items])
    fresh = [s for s in items if s["id"] not in last]
    if fresh:
        return rng.choice(fresh)
    return min(items, key=lambda s: (last[s["id"]], s["id"]))


def free_setup(language, theme_id):
    items = db.library_scenarios(language, theme_id, "free")
    return items[0] if items else None
