"""tokens.css가 정의하는 이름과 나머지 CSS가 참조하는 이름을 대조한다.

이 작업의 실패 방식을 정확히 겨냥한 계기다. 정의되지 않은 var()는 CSS 에러가
아니라 무효 선언이라, 토큰 이름 오타 하나로 화면이 무너져도 파이썬 스위트도
노드 스위트도 초록으로 남는다. 어느 쪽도 CSS를 읽지 않기 때문이다.
"""
import re
from pathlib import Path

CSS_DIR = Path(__file__).resolve().parent.parent / "static" / "css"

DEFINE_RE = re.compile(r"(--[\w-]+)\s*:")
# var(--x) 와 var(--x, fallback) 을 모두 잡는다.
REFERENCE_RE = re.compile(r"var\(\s*(--[\w-]+)")


def _css_files():
    files = sorted(CSS_DIR.glob("*.css"))
    assert files, f"CSS 파일을 하나도 못 찾았다: {CSS_DIR}"
    return files


def test_every_referenced_token_is_defined():
    defined, referenced = set(), {}
    for path in _css_files():
        text = path.read_text(encoding="utf-8")
        defined |= set(DEFINE_RE.findall(text))
        for name in REFERENCE_RE.findall(text):
            referenced.setdefault(name, path.name)

    missing = {n: f for n, f in referenced.items() if n not in defined}
    assert not missing, f"정의되지 않은 토큰을 참조한다: {missing}"


def _root_block(text, marker):
    """marker 로 시작하는 선언 블록의 본문."""
    start = text.index(marker) + len(marker)
    depth, i = 1, start
    while depth:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return text[start:i - 1]


def test_dark_defines_nothing_light_does_not():
    """다크 블록에만 있는 토큰이 없어야 한다.

    tokens.css의 규칙: "라이트 먼저, 다크는 같은 이름을 다시 정의하는 것으로
    처리 -- 색을 다크 블록 안에서만 정의하지 말 것." 다크에만 있는 이름은 라이트
    스킴에서 그냥 무효가 된다.
    """
    text = (CSS_DIR / "tokens.css").read_text(encoding="utf-8")
    light = set(DEFINE_RE.findall(_root_block(text, ":root {")))
    dark_media = text[text.index("@media (prefers-color-scheme: dark)"):]
    dark = set(DEFINE_RE.findall(dark_media))

    dark_only = dark - light
    assert not dark_only, f"다크 블록에만 정의된 토큰: {dark_only}"
