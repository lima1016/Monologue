"""테마 라이브러리 생성 품질 -- 실제 모델. `-m engine`에서만 돈다.

실측 (2026-09-14, qwen2.5:14b): added 12/12, gave_up 0, retries 5,
reasons {line-count: 1, language: 3, same-opening: 1}, 232.2초
(12편 + free setup 4개, 평균 19.4초/편). 문턱은 실측 아래로 둔다.
"""
import time

import pytest

from app import config, db, library
from scripts import build_library

pytestmark = pytest.mark.engine


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    mp.setattr(config, "DB_PATH", tmp_path_factory.mktemp("lib") / "t.db")
    db.init_db()
    themes = [library.get_theme("cafe-restaurant"), library.get_theme("meetings")]
    started = time.perf_counter()
    report = build_library.build(themes, ["en", "ja"], 3, log=print)
    report["seconds"] = time.perf_counter() - started
    yield report
    mp.undo()


def test_print_samples(run):
    print("\n", run)
    for language in ("en", "ja"):
        for theme in ("cafe-restaurant", "meetings"):
            for s in db.library_scenarios(language, theme, "script"):
                print(f"\n[{language}] {s['id']} {s['title']} ({s['situation']})")
                for line in s["lines"]:
                    print(f"   {line['speaker']}: {line['text']}")


def test_most_scripts_get_made(run):
    assert run["added"] >= 10, run      # 12 requested


def test_few_give_ups(run):
    assert run["gave_up"] <= 2, run


def test_every_theme_language_has_a_free_setup(run):
    for language in ("en", "ja"):
        for theme in ("cafe-restaurant", "meetings"):
            assert library.free_setup(language, theme), (language, theme)
