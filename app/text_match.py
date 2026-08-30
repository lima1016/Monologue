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
