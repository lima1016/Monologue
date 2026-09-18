"""Did the learner's text differ from the model's "correction" by more than
punctuation and casing?

Browser speech recognition never returns punctuation and its casing is
arbitrary, so the model routinely "fixes" a perfectly correct sentence by
adding commas and a full stop. Recording that as a learner mistake pollutes
every downstream count that reads `messages.ok`/`tag` -- the home screen's
고친 표현 counter, its weakness recommendation, and the end-of-session report.

This is the Python twin of static/js/match.js's `normalize()`. That file
solves the identical problem for the re-speak comparison; its header comment
explains why punctuation is *deleted* rather than replaced with a space, and
that reasoning holds here unchanged: Japanese has no spaces between words, so
turning `、` into a space would invent a token boundary that was never there,
and in English it would split contractions like "don't" into "don" and "t".
`similarity`/`matches` below are twins of that same file's functions of the
same name, for the same reason: shadowing's verdict is judged here, on the
server, and must never disagree with what the browser already shows.

The two files must be kept in sync by hand -- there is no build step to share
them. If you change the punctuation set here, change static/js/match.js's
PUNCT too, and vice versa.
"""
import re

PUNCT = re.compile(
    r"[.,!?;:'\"()\[\]{}\-–—…·、。！？「」『』（）]"
)


def normalize(text: str | None) -> str:
    return re.sub(r"\s+", " ", PUNCT.sub("", (text or "").lower())).strip()


PASS_THRESHOLD = 0.9


def _tokens(text: str | None, language: str) -> list[str]:
    cleaned = normalize(text)
    if not cleaned:
        return []
    return list(cleaned.replace(" ", "")) if language == "ja" else cleaned.split(" ")


def _edit_distance(a: list[str], b: list[str]) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i]
        for j in range(1, len(b) + 1):
            row.append(min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1])))
        prev = row
    return prev[len(b)]


def similarity(spoken: str | None, target: str | None, language: str) -> float:
    """Twin of static/js/match.js's similarity(): words in English, characters in Japanese."""
    a, b = _tokens(spoken, language), _tokens(target, language)
    if not a or not b:
        return 0.0
    return 1 - _edit_distance(a, b) / max(len(a), len(b))


def matches(spoken: str | None, target: str | None, language: str) -> bool:
    return similarity(spoken, target, language) >= PASS_THRESHOLD
