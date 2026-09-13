"""로고와 파비콘이 지키는 결정 두 가지의 계기.

1. 헤더 마크는 색을 파일에 박지 않는다. 박으면 다크 모드에서 라이트 테라코타가
   그대로 남는데, 어떤 스위트도 SVG 속성을 읽지 않아 초록으로 남는다.
2. 파비콘은 링크된 파일이 실제로 있다. 경로 오타는 404 한 줄로만 드러난다.
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
INDEX = (STATIC / "index.html").read_text(encoding="utf-8")


def _header():
    return re.search(r"<header>(.*?)</header>", INDEX, re.S).group(1)


def test_favicon_is_linked_and_exists():
    link = re.search(r'<link rel="icon" href="/([^"]+)" type="image/svg\+xml">', INDEX)
    assert link, "index.html 에 SVG 파비콘 링크가 없다"
    assert (STATIC / link.group(1)).exists(), f"링크된 파비콘이 없다: {link.group(1)}"


def test_favicon_is_well_formed_svg():
    """브라우저는 깨진 SVG 파비콘을 에러 없이 조용히 버린다.

    실제로 한 번 그랬다: 주석에 `--accent` 를 썼는데 XML 주석 안에서는 `--` 가
    금지라 파일 전체가 파싱되지 않았고, 탭에는 기본 아이콘만 떴다.
    """
    root = ET.parse(STATIC / "favicon.svg").getroot()
    assert root.tag == "{http://www.w3.org/2000/svg}svg"


def test_header_mark_takes_its_colour_from_the_page():
    header = _header()
    svg = re.search(r"<svg\b.*?</svg>", header, re.S)
    assert svg, "헤더에 로고 마크가 없다"
    body = svg.group(0)
    assert 'fill="currentColor"' in body
    assert not re.search(r"#[0-9a-fA-F]{3,6}\b", body), "헤더 마크에 색이 박혀 있다"


def test_logo_leads_home():
    assert re.search(r'<h1>\s*<a [^>]*href="/"', _header()), "로고가 홈 링크가 아니다"
