"""폰트를 자체 호스팅한다는 결정을 지키는 계기.

CDN 링크로 되돌아가면 이 앱은 인터넷이 끊긴 날 멀쩡히 돌면서 글꼴만 맑은 고딕으로
떨어진다 -- 고치려던 문제가 조용히 되살아나는 실패 방식이고, 화면을 열어보지
않으면 아무도 모른다.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONTS_CSS = ROOT / "static" / "css" / "fonts.css"
FONT_FILE = ROOT / "static" / "fonts" / "PretendardVariable.woff2"


def test_font_file_is_committed_and_real():
    assert FONT_FILE.exists(), "Pretendard woff2 가 static/fonts 에 없다"
    size = FONT_FILE.stat().st_size
    assert size > 100_000, f"폰트 파일이 너무 작다({size}B) -- 받다 만 것 아닌가"
    assert size < 2_500_000, f"폰트 파일이 {size}B -- 비정상적으로 크다. 받은 파일이 맞는지 확인할 것"


def test_fonts_css_is_self_hosted():
    text = FONTS_CSS.read_text(encoding="utf-8")
    assert "@font-face" in text
    assert "/fonts/PretendardVariable.woff2" in text
    assert "font-display: swap" in text
    for host in ("http://", "https://", "//cdn."):
        assert host not in text, f"폰트를 원격에서 받고 있다: {host}"
