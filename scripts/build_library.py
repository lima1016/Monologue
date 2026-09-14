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


def _free_setup(theme, language, chat_json):
    wish = f"{theme['title']} ({', '.join(theme['situations'])})"
    result = chat_json(prompts.build_scenario_messages(language, "free", wish),
                       prompts.scenario_schema("free"))
    item = {"id": f"lib-{theme['id']}-{language}-free", "theme_id": theme["id"], "situation": None,
            "language": language, "type": "free", "title": theme["title"],
            "goal": (result.get("goal") or "").strip() or None,
            "persona_prompt": (result.get("persona_prompt") or "").strip(),
            "max_turns": config.DEFAULT_MAX_TURNS}
    scenarios.validate_item(item)
    db.add_library_scenario(item)


def build(themes, languages, per_theme, *, chat_json=llm.chat_json, log=print):
    stats = {"added": 0, "retries": 0, "gave_up": 0, "reasons": Counter()}
    for language in languages:
        for theme in themes:
            if not db.library_scenarios(language, theme["id"], "free"):
                try:
                    _free_setup(theme, language, chat_json)
                except Exception as exc:  # a missing free setup is retried next run
                    stats["reasons"]["free-setup"] += 1
                    log(f"[{language}] {theme['id']} free setup failed: {exc}")
            existing = db.library_scenarios(language, theme["id"], "script")
            used = {s["id"] for s in existing}
            for n in range(1, per_theme + 1):
                sid = f"lib-{theme['id']}-{language}-{n:02d}"
                if sid in used:
                    continue
                situation = theme["situations"][(n - 1) % len(theme["situations"])]
                previous = [{"title": s["title"], "opening": s["lines"][0]["text"]} for s in existing]
                messages = prompts.build_library_script_messages(language, theme["title"], situation, previous)
                for attempt in range(_ATTEMPTS + 1):
                    if attempt:
                        stats["retries"] += 1
                    try:
                        result = chat_json(messages, prompts.scenario_schema("script"))
                    except llm.LLMError:
                        stats["reasons"]["model-error"] += 1
                        continue
                    lines = result.get("lines") if isinstance(result, dict) else None
                    reason = library.check_script(lines, language, [s["lines"] for s in existing])
                    if reason:
                        stats["reasons"][reason] += 1
                        continue
                    item = {"id": sid, "theme_id": theme["id"], "situation": situation, "language": language,
                            "type": "script", "title": (result.get("title") or situation).strip(),
                            "lines": lines}
                    db.add_library_scenario(item)
                    existing.append(db.get_library_scenario(sid))
                    stats["added"] += 1
                    log(f"[{language}] {theme['id']} {n:02d}/{per_theme} ok")
                    break
                else:
                    stats["gave_up"] += 1
                    log(f"[{language}] {theme['id']} {n:02d}/{per_theme} gave up")
    stats["reasons"] = dict(stats["reasons"])
    return stats


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=config.LANGUAGES, action="append")
    parser.add_argument("--theme", nargs="*")
    parser.add_argument("--per-theme", type=int, default=config.LIBRARY_PER_THEME)
    args = parser.parse_args(argv)
    db.init_db()
    themes = library.load_themes()
    if args.theme:
        themes = [t for t in themes if t["id"] in args.theme]
    started = time.perf_counter()
    report = build(themes, args.language or list(config.LANGUAGES), args.per_theme)
    report["minutes"] = round((time.perf_counter() - started) / 60, 1)
    print(report)


if __name__ == "__main__":
    main()
