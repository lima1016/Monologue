import pytest

from app import config, db
from scripts import build_library


def _lines(prefix, n=16):
    """Lines that differ from any other prefix's lines almost entirely -- the
    builder's similarity check (0.8) would otherwise reject a shared template.
    The same prefix gives the same lines (that is how the duplicate test works)."""
    import hashlib
    out = []
    for i in range(n):
        h = hashlib.sha1(f"{prefix}-{i}".encode()).hexdigest().translate(str.maketrans("0123456789", "ghijklmnop"))
        text = f"{prefix} line {i} for practice." if i == 0 else f"{h[:7]} {h[7:14]} {h[14:21]}."
        out.append({"speaker": "bot" if i % 2 == 0 else "user", "text": text})
    return out


THEME = {"id": "hotel", "category": "travel", "title": "호텔", "situations": ["체크인", "방 문제", "짐 맡기기"]}


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    db.init_db()
    return db


class FakeModel:
    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.calls = []

    def __call__(self, messages, schema, **kw):
        self.calls.append(messages)
        if "persona_prompt" in schema.get("properties", {}):
            return {"title": "호텔 프런트", "goal": "방 열쇠를 받는다", "persona_prompt": "You are a hotel clerk."}
        nxt = self.scripts.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return {"title": nxt[0], "lines": nxt[1]}


def test_builds_the_missing_count_and_the_free_setup(store):
    model = FakeModel([(f"t{i}", _lines(f"Unique{i} alpha{i*13}")) for i in range(3)])
    report = build_library.build([THEME], ["en"], 3, chat_json=model, log=lambda *a: None)
    scripts = db.library_scenarios("en", "hotel", "script")
    assert [s["id"] for s in scripts] == ["lib-hotel-en-01", "lib-hotel-en-02", "lib-hotel-en-03"]
    assert [s["situation"] for s in scripts] == ["체크인", "방 문제", "짐 맡기기"]
    assert db.get_library_scenario("lib-hotel-en-free")["max_turns"] == config.DEFAULT_MAX_TURNS
    assert report["added"] == 3


def test_resumes_where_it_stopped(store):
    build_library.build([THEME], ["en"], 2, chat_json=FakeModel(
        [(f"t{i}", _lines(f"First{i} beta{i*17}")) for i in range(2)]), log=lambda *a: None)
    model = FakeModel([("t9", _lines("Third gamma99"))])
    build_library.build([THEME], ["en"], 3, chat_json=model, log=lambda *a: None)
    assert len(db.library_scenarios("en", "hotel", "script")) == 3
    assert db.library_scenarios("en", "hotel", "script")[-1]["situation"] == "짐 맡기기"
    assert sum("persona_prompt" not in str(c) for c in model.calls) == 1   # only the one missing script


def test_a_failing_generation_is_retried_then_given_up(store):
    bad = ("bad", _lines("Short", n=15))
    model = FakeModel([bad, bad, bad, bad, ("ok", _lines("Fine delta42"))])
    report = build_library.build([THEME], ["en"], 2, chat_json=model, log=lambda *a: None)
    assert report["gave_up"] == 1 and report["retries"] == 3
    assert report["reasons"]["line-count"] == 4
    assert [s["id"] for s in db.library_scenarios("en", "hotel", "script")] == ["lib-hotel-en-02"]


def test_model_errors_count_as_retries(store):
    from app.llm import LLMError
    model = FakeModel([LLMError("down"), ("ok", _lines("Recovered eps7"))])
    report = build_library.build([THEME], ["en"], 1, chat_json=model, log=lambda *a: None)
    assert report["added"] == 1 and report["reasons"]["model-error"] == 1


def test_duplicates_of_stored_scripts_are_rejected(store):
    same = _lines("Repeat zeta")
    model = FakeModel([("a", same), ("b", same), ("c", _lines("Other eta88"))])
    report = build_library.build([THEME], ["en"], 2, chat_json=model, log=lambda *a: None)
    assert report["added"] == 2 and report["reasons"]["same-opening"] == 1


def test_previous_titles_and_openings_reach_the_prompt(store):
    model = FakeModel([("first title", _lines("Opening theta1")), ("second", _lines("Opening iota2"))])
    build_library.build([THEME], ["en"], 2, chat_json=model, log=lambda *a: None)
    last_user = [c for c in model.calls if "persona_prompt" not in str(c)][-1][-1]["content"]
    assert "first title" in last_user and "Opening theta1 line 0 for practice." in last_user
