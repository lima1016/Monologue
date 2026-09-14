"""테마 라이브러리 생성 품질 -- 실제 모델. `-m engine`에서만 돈다.

실측 (2026-09-14, qwen2.5:14b, 리뷰 수정 뒤 -- autojunk 끈 유사도 검사, 한국어
제목 검사, free setup 재시도): added 12/12, gave_up 0, retries 2, stopped None,
reasons {line-count: 1, language: 1}, too-similar 0, 185.1초 (12편 + free setup
4개, 평균 15.4초/편). 같은 테마·언어 안 대본끼리 유사도 최대 0.40(en), 0.29(ja).
제목 12개 모두 한글; ja 6개 중 5개는 제목이 상황 이름 그대로다(걸러져 대체됐는지
모델이 그렇게 썼는지는 로그로 구분되지 않는다),
"Just In Case 주문 변경"처럼 영어가 섞인 한글 제목은 통과한다.
이전 실측(수정 전): added 12/12, retries 5, 232.2초. 문턱은 실측 아래로 둔다.
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
