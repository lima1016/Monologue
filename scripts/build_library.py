"""테마 라이브러리 일괄 생성. 앱 밖에서 한 번(또는 끊어서 여러 번) 돌린다.

    C:/git/Monologue/venv/Scripts/python.exe scripts/build_library.py
    ... --language ja --theme hotel cafe-restaurant --per-theme 3

이미 저장된 편수만큼 건너뛰므로 중간에 끊어도 다시 실행하면 이어진다.
GPU를 다른 프로그램(게임)이 쓰면 10배 가까이 느려진다(2026-09-14 실측).
"""
import argparse
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config, db, library, llm, prompts, scenarios  # noqa: E402

_ATTEMPTS = 3   # retries after the first try


def prepare_console(stream):
    """UTF-8, flushed line by line. A Windows console defaults to cp949 and to
    block buffering when redirected to a file: the first model error quoting an
    emoji would kill the run, and a log file would show nothing for minutes.
    A test runner's captured stream may not have reconfigure; leave it be."""
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def console_log(stream):
    """A log function that never raises on a character the stream cannot hold.
    prepare_console already covers sys.stdout; this covers any stream that
    could not be reconfigured, which is why it is the one the tests pin."""
    def log(text):
        text = str(text)
        try:
            stream.write(text + "\n")
        except UnicodeEncodeError:
            encoding = getattr(stream, "encoding", None) or "ascii"
            stream.write(text.encode(encoding, "replace").decode(encoding) + "\n")
        stream.flush()
    return log


def _stored(language, theme, per_theme):
    wanted = {f"lib-{theme['id']}-{language}-{n:02d}" for n in range(1, per_theme + 1)}
    return sum(s["id"] in wanted for s in db.library_scenarios(language, theme["id"], "script"))


def plan_lines(themes, languages, per_theme):
    """What the run is about to do, printed before the first model call."""
    lines = [f"database: {config.DB_PATH}",
             f"languages: {', '.join(languages)} | themes: {len(themes)} | per theme: {per_theme}"]
    for language in languages:
        stored = sum(_stored(language, t, per_theme) for t in themes)
        target = per_theme * len(themes)
        lines.append(f"[{language}] stored {stored} / target {target}, missing {target - stored}")
    return lines


class _ModelFailed(Exception):
    """One model call failed; already counted and logged."""


class _Stopped(Exception):
    """Too many model failures in a row -- the model is down, not unlucky."""


_STOP_AFTER = 5   # consecutive model errors, across attempts, scripts and free setups


def _free_setup(theme, language, ask):
    wish = f"{theme['title']} ({', '.join(theme['situations'])})"
    result = ask(prompts.build_scenario_messages(language, "free", wish), prompts.scenario_schema("free"))
    item = {"id": f"lib-{theme['id']}-{language}-free", "theme_id": theme["id"], "situation": None,
            "language": language, "type": "free", "title": theme["title"],
            "goal": (result.get("goal") or "").strip() or None,
            "persona_prompt": (result.get("persona_prompt") or "").strip(),
            "max_turns": config.DEFAULT_MAX_TURNS}
    scenarios.validate_item(item)
    db.add_library_scenario(item)


def build(themes, languages, per_theme, *, chat_json=llm.chat_json, log=print):
    """Returns the report; `stopped` is None for a full run, or why it ended
    early. Everything stored before a stop stays stored, so a rerun resumes."""
    stats = {"added": 0, "retries": 0, "gave_up": 0, "reasons": Counter(), "stopped": None}
    target = per_theme * len(themes) * len(languages)
    done = sum(_stored(language, t, per_theme) for language in languages for t in themes)
    errors_in_a_row = 0
    label = ""

    def ask(messages, schema):
        nonlocal errors_in_a_row
        try:
            result = chat_json(messages, schema)
        except Exception as exc:
            # LLMError is the usual one (Ollama down, a timeout), but a
            # six-hour unattended run must also survive a shape llm.chat_json
            # does not itself guard -- e.g. Ollama returning a null content,
            # which surfaces as TypeError out of json.loads(None).
            errors_in_a_row += 1
            stats["reasons"]["model-error"] += 1
            log(f"{label} model error ({type(exc).__name__}): {exc}")
            if errors_in_a_row >= _STOP_AFTER:
                raise _Stopped from exc
            raise _ModelFailed from exc
        errors_in_a_row = 0
        return result

    try:
        for language in languages:
            for index, theme in enumerate(themes, 1):
                where = f"[{language}] theme {index}/{len(themes)} {theme['id']}"
                if not db.library_scenarios(language, theme["id"], "free"):
                    label = f"{where} free setup"
                    try:
                        _free_setup(theme, language, ask)
                    except _ModelFailed:
                        pass     # a missing free setup is retried next run
                    except _Stopped:
                        raise
                    except Exception as exc:
                        stats["reasons"]["free-setup"] += 1
                        log(f"{where} free setup failed: {exc}")
                existing = db.library_scenarios(language, theme["id"], "script")
                used = {s["id"] for s in existing}
                for n in range(1, per_theme + 1):
                    sid = f"lib-{theme['id']}-{language}-{n:02d}"
                    if sid in used:
                        continue
                    label = f"{where} {n:02d}/{per_theme}"
                    situation = theme["situations"][(n - 1) % len(theme["situations"])]
                    previous = [{"title": s["title"], "opening": s["lines"][0]["text"]} for s in existing]
                    messages = prompts.build_library_script_messages(language, theme["title"], situation, previous)
                    for attempt in range(_ATTEMPTS + 1):
                        if attempt:
                            stats["retries"] += 1
                        try:
                            result = ask(messages, prompts.scenario_schema("script"))
                        except _ModelFailed:
                            continue
                        lines = result.get("lines") if isinstance(result, dict) else None
                        reason = library.check_script(lines, language, [s["lines"] for s in existing])
                        if reason:
                            stats["reasons"][reason] += 1
                            continue
                        item = {"id": sid, "theme_id": theme["id"], "situation": situation, "language": language,
                                "type": "script", "title": (result.get("title") or situation).strip(),
                                "lines": lines}
                        try:
                            db.add_library_scenario(item)
                        except Exception as exc:
                            # The app server can hold the database at the same time
                            # this runs (a shared SQLite file, WAL mode) -- a lock
                            # timeout here is transient, not a reason to lose the
                            # rest of the run. Retried like any other bad attempt.
                            stats["reasons"]["db-error"] += 1
                            log(f"{label} unexpected {type(exc).__name__} saving: {exc}")
                            continue
                        existing.append(db.get_library_scenario(sid))
                        stats["added"] += 1
                        done += 1
                        log(f"{label} (done {done}/{target}) ok")
                        break
                    else:
                        stats["gave_up"] += 1
                        log(f"{label} (done {done}/{target}) gave up")
    except _Stopped:
        stats["stopped"] = "model-errors"
        log(f"모델 오류가 연속 {_STOP_AFTER}번 나서 멈춥니다 (done {done}/{target}). "
            "Ollama를 확인한 뒤 같은 명령을 다시 실행하면 이어서 만듭니다.")
    stats["reasons"] = dict(stats["reasons"])
    return stats


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=config.LANGUAGES, action="append")
    parser.add_argument("--theme", nargs="*")
    parser.add_argument("--per-theme", type=int, default=config.LIBRARY_PER_THEME)
    args = parser.parse_args(argv)
    prepare_console(sys.stdout)
    log = console_log(sys.stdout)
    db.init_db()
    themes = library.load_themes()
    if args.theme:
        themes = [t for t in themes if t["id"] in args.theme]
    languages = args.language or list(config.LANGUAGES)
    for line in plan_lines(themes, languages, args.per_theme):
        log(line)
    if not llm.is_healthy():
        log(f"Ollama가 응답하지 않습니다 ({config.OLLAMA_URL}). Ollama를 켠 뒤 다시 실행하세요.")
        sys.exit(1)
    started = time.perf_counter()
    report = build(themes, languages, args.per_theme, log=log)
    report["minutes"] = round((time.perf_counter() - started) / 60, 1)
    log(report)


if __name__ == "__main__":
    main()
