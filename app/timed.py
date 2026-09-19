"""1분 말하기의 계산. 모델도 DB도 부르지 않는 순수 함수만 -- 테스트가 숫자를 못박는다."""
import re

_END = re.compile(r"(?<=[.?!。？！])\s*")
_JA_SKIP = re.compile(r"[\s、。，．？！?!「」『』（）()・…ー~〜]")
_MIN_WORDS = {"en": 3, "ja": 4}   # 이보다 짧은 조각은 앞 문장에 붙인다(ja는 글자 수)
LONG_PAUSE = 3.0


def count_words(text, language) -> int:
    if language == "ja":
        return len(_JA_SKIP.sub("", text))
    return len([w for w in text.split() if re.search(r"[A-Za-z0-9]", w)])


def split_sentences(segments, language) -> list[str]:
    joiner = "" if language == "ja" else " "
    text = joiner.join(s["text"].strip() for s in segments if s["text"].strip())
    parts = [p.strip() for p in _END.split(text) if p.strip()]
    out: list[str] = []
    for p in parts:
        if out and count_words(p, language) < _MIN_WORDS[language]:
            out[-1] = f"{out[-1]}{joiner}{p}"
        else:
            out.append(p)
    return out


def long_pauses(segments, threshold=LONG_PAUSE) -> int:
    ordered = sorted(segments, key=lambda s: s["start"])
    return sum(1 for a, b in zip(ordered, ordered[1:]) if b["start"] - a["end"] >= threshold)


def round_stats(segments, language, seconds) -> dict:
    sentences = split_sentences(segments, language)
    words = sum(count_words(s, language) for s in sentences)
    minutes = max(seconds, 1) / 60
    return {"words": words, "wpm": round(words / minutes), "long_pauses": long_pauses(segments),
            "sentences": sentences}
