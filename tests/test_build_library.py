import sqlite3

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


def test_a_non_llm_error_from_the_model_still_counts_as_a_retry(store):
    """chat_json can raise something other than llm.LLMError -- e.g. a bare
    TypeError out of json.loads(None) when Ollama returns a null content. A
    4-hour unattended run must survive that, not die on it."""
    model = FakeModel([TypeError("content was null"), ("ok", _lines("Recovered zeta9"))])
    report = build_library.build([THEME], ["en"], 1, chat_json=model, log=lambda *a: None)
    assert report["added"] == 1 and report["reasons"]["model-error"] == 1


def test_a_database_error_while_saving_is_retried(store, monkeypatch):
    """The app server can hold the same SQLite file open at the same time this
    runs -- a lock timeout on the insert must be retried, not crash the run."""
    db.add_library_scenario({
        "id": "lib-hotel-en-free", "theme_id": "hotel", "situation": None, "language": "en",
        "type": "free", "title": "호텔", "goal": "체크인 한다",
        "persona_prompt": "You are a hotel clerk.", "max_turns": config.DEFAULT_MAX_TURNS,
    })
    real_add = db.add_library_scenario
    calls = {"n": 0}

    def flaky(item):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return real_add(item)

    monkeypatch.setattr(db, "add_library_scenario", flaky)
    model = FakeModel([("first", _lines("Locked eta3")), ("second", _lines("Locked eta4"))])
    report = build_library.build([THEME], ["en"], 1, chat_json=model, log=lambda *a: None)
    assert report["reasons"]["db-error"] == 1
    assert [s["id"] for s in db.library_scenarios("en", "hotel", "script")] == ["lib-hotel-en-01"]


# ---------- an unattended run: what reaches the console ----------

def test_a_log_line_the_console_cannot_encode_does_not_raise():
    """A Windows console defaults to cp949, and a model error can quote
    anything -- an emoji in an exception message must not kill a six-hour run."""
    import io
    raw = io.BytesIO()
    stream = io.TextIOWrapper(raw, encoding="cp949")
    log = build_library.console_log(stream)
    log("[ja] cafe model error: bad char 😀 in 咖啡點餐")
    stream.flush()
    out = raw.getvalue().decode("cp949")
    assert out.startswith("[ja] cafe model error: bad char ?") and out.endswith("\n")


def test_the_console_is_switched_to_utf8_line_buffered_when_it_can_be():
    import io
    stream = io.TextIOWrapper(io.BytesIO(), encoding="cp949")
    build_library.prepare_console(stream)
    assert stream.encoding == "utf-8" and stream.line_buffering
    build_library.prepare_console(io.StringIO())    # no reconfigure: left alone, no error


def test_the_plan_says_what_is_stored_and_what_is_missing(store):
    other = {**THEME, "id": "cafe-restaurant"}
    for n in (1, 2):
        db.add_library_scenario({"id": f"lib-hotel-en-{n:02d}", "theme_id": "hotel", "situation": "s",
                                 "language": "en", "type": "script", "title": "t", "lines": _lines(f"P{n}")})
    lines = build_library.plan_lines([THEME, other], ["en", "ja"], 3)
    text = "\n".join(lines)
    assert str(config.DB_PATH) in text
    assert "en, ja" in text and "themes: 2" in text and "per theme: 3" in text
    assert "[en] stored 2 / target 6, missing 4" in text
    assert "[ja] stored 0 / target 6, missing 6" in text


def test_progress_lines_carry_the_theme_position_and_a_running_total(store):
    other = {**THEME, "id": "cafe-restaurant"}
    db.add_library_scenario({"id": "lib-hotel-en-01", "theme_id": "hotel", "situation": "s",
                             "language": "en", "type": "script", "title": "t", "lines": _lines("Stored kappa")})
    model = FakeModel([(f"t{i}", _lines(f"Run{i} lambda{i*19}")) for i in range(3)])
    said = []
    build_library.build([THEME, other], ["en"], 2, chat_json=model, log=said.append)
    ok = [s for s in said if s.endswith("ok") or " ok " in s]
    assert any("theme 1/2" in s and "done 2/4" in s for s in ok), said
    assert any("theme 2/2" in s and "done 4/4" in s for s in ok), said


# ---------- Ollama down: stop, do not spin for hours ----------

def test_five_model_errors_in_a_row_stop_the_run_cleanly(store):
    from app.llm import LLMError
    model = FakeModel([LLMError("connection refused")] * 5 + [("never", _lines("Never mu1"))])
    said = []
    report = build_library.build([THEME], ["en"], 3, chat_json=model, log=said.append)
    assert report["stopped"] == "model-errors"
    assert report["added"] == 0 and report["reasons"]["model-error"] == 5
    assert len(model.scripts) == 1, "the run kept calling a model that was down"
    assert any("connection refused" in s for s in said), "the model's own message was not logged"
    assert any("LLMError" in s for s in said)
    assert any("다시 실행하면 이어서" in s for s in said), said[-1]


def test_a_model_answer_resets_the_error_count(store):
    from app.llm import LLMError
    e = LLMError("busy")
    model = FakeModel([e, e, e, e, ("ok", _lines("Between nu2")), e, e, e, e])
    report = build_library.build([THEME], ["en"], 3, chat_json=model, log=lambda *a: None)
    assert report["stopped"] is None
    assert report["added"] == 1 and report["gave_up"] == 2 and report["reasons"]["model-error"] == 8


def test_a_stop_also_counts_failures_of_the_free_setup(store):
    from app.llm import LLMError

    calls = []

    def down(messages, schema, **kw):
        calls.append(1)
        raise LLMError("down")
    # per_theme 0: only free setups are asked for, so the fifth error lands inside one.
    themes = [{**THEME, "id": f"t{i}"} for i in range(8)]
    report = build_library.build(themes, ["en"], 0, chat_json=down, log=lambda *a: None)
    assert report["stopped"] == "model-errors" and len(calls) == 5


def test_main_refuses_to_start_when_ollama_is_not_answering(store, monkeypatch, capsys):
    from app import llm
    monkeypatch.setattr(llm, "is_healthy", lambda: False)
    called = []
    monkeypatch.setattr(build_library, "build", lambda *a, **k: called.append(1))
    with pytest.raises(SystemExit) as exc:
        build_library.main(["--language", "en", "--theme", "hotel", "--per-theme", "1"])
    assert exc.value.code != 0 and called == []
    assert "Ollama" in capsys.readouterr().out


def test_main_prints_the_partial_report_of_a_stopped_run(store, monkeypatch, capsys):
    from app import llm
    monkeypatch.setattr(llm, "is_healthy", lambda: True)
    monkeypatch.setattr(build_library, "build",
                        lambda *a, **k: {"added": 2, "retries": 5, "gave_up": 0, "reasons": {}, "stopped": "model-errors"})
    build_library.main(["--language", "en", "--theme", "hotel", "--per-theme", "1"])
    out = capsys.readouterr().out
    assert "'stopped': 'model-errors'" in out and "'added': 2" in out
