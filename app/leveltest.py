"""레벨 테스트의 채점과 환산. 모델도 DB도 부르지 않는다 -- 표를 테스트가 못박는다.
docs/superpowers/specs/2026-09-19-monologue-level-test-design.md"""
import functools
import json

from app import config, text_match

CEFR = ("A1", "A2", "B1", "B2", "C1", "C2")
# 48점 만점의 하한. 앱이 정한 컷이다(검증된 시험이 아님) -- 화면이 그렇게 말한다.
_CUTS = {"A1": 0, "A2": 10, "B1": 20, "B2": 30, "C1": 39, "C2": 45}
_TOP = {"A1": 9, "A2": 19, "B1": 29, "B2": 38, "C1": 44, "C2": 48}
_BOUNDARY = 2
NOTE = "말하기만 본 추정이에요 · 공식 점수가 아니에요"

# ielts.org / British Council: B1 4.0–5.0, B2 5.5–6.5, C1 7.0–8.0, C2 8.5–9.0; B1 아래는 대응 없음.
_IELTS = {("B1", "하위"): "4.0–4.5", ("B1", "상위"): "4.5–5.0", ("B2", "하위"): "5.5–6.0", ("B2", "상위"): "6.0–6.5",
          ("C1", "하위"): "7.0–7.5", ("C1", "상위"): "7.5–8.0", ("C2", "하위"): "8.5–9.0", ("C2", "상위"): "8.5–9.0"}
# ets.org TOEFL iBT score scale update (2026-01): 1–6 band per CEFR, and the old 0–30 speaking range per band.
_TOEFL_BAND = {("A1", "하위"): "1.0", ("A1", "상위"): "1.5", ("A2", "하위"): "2.0", ("A2", "상위"): "2.5",
               ("B1", "하위"): "3.0", ("B1", "상위"): "3.5", ("B2", "하위"): "4.0", ("B2", "상위"): "4.5",
               ("C1", "하위"): "5.0", ("C1", "상위"): "5.5", ("C2", "하위"): "6.0", ("C2", "상위"): "6.0"}
_TOEFL_OLD = {"1.0": "0–4", "1.5": "5–9", "2.0": "10–12", "2.5": "13–15", "3.0": "16–17", "3.5": "18–19",
              "4.0": "20–22", "4.5": "23–24", "5.0": "25–26", "5.5": "27", "6.0": "28–30"}
_APP = {"A1": "beginner", "A2": "beginner", "B1": "intermediate", "B2": "intermediate",
        "C1": "advanced", "C2": "advanced"}


@functools.lru_cache(maxsize=None)
def _bank() -> dict:
    return json.loads((config.DATA_DIR / "level_test.json").read_text(encoding="utf-8"))


def load_bank(language) -> dict:
    return _bank()[language]


def item_score(heard, target, language) -> int:
    r = text_match.similarity(heard or "", target, language)
    for points, floor in ((4, 0.95), (3, 0.8), (2, 0.6), (1, 0.3)):
        if r >= floor:
            return points
    return 0


def cefr_from_ei(score) -> tuple[str, str]:
    level = max(c for c in CEFR if score >= _CUTS[c])  # CEFR is ordered, and so are its strings
    low, high = _CUTS[level], _TOP[level]
    return level, ("하위" if score - low < (high - low + 1) / 2 else "상위")


def answers_level(cefrs) -> str | None:
    ranks = [CEFR.index(c) for c in cefrs if c in CEFR]
    if not ranks:
        return None
    return CEFR[sum(ranks) // len(ranks)]


def apply_boundary(score, cefr, step, answers_cefr) -> tuple[str, str]:
    if answers_cefr not in CEFR:
        return cefr, step
    k, a = CEFR.index(cefr), CEFR.index(answers_cefr)
    if k + 1 < len(CEFR) and _CUTS[CEFR[k + 1]] - score <= _BOUNDARY and a > k:
        return CEFR[k + 1], "하위"
    if k > 0 and score - _CUTS[cefr] < _BOUNDARY and a < k:
        return CEFR[k - 1], "상위"
    return cefr, step


def conversions(cefr, step, language) -> dict:
    if language == "ja":
        return {"ielts": None, "toefl": None, "jf": f"JF 스탠다드 {cefr}",
                "note": NOTE + " · JLPT에는 말하기 시험이 없어 환산하지 않아요"}
    band = _TOEFL_BAND[(cefr, step)]
    return {"ielts": _IELTS.get((cefr, step), "4.0 미만"), "toefl": {"band": band, "old": _TOEFL_OLD[band]},
            "jf": None, "note": NOTE}


def app_level(cefr) -> str:
    return _APP[cefr]


def by_level(scores, items) -> dict:
    out: dict = {}
    for item, s in zip(items, scores):
        got, top = out.get(item["cefr"], [0, 0])
        out[item["cefr"]] = [got + s, top + 4]
    return out
