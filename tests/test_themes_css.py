"""화면 테마(기본/숲/바다/보라/먹/하양) x 밝기(밝게/어둡게)를 tokens.css에서
직접 풀어 보고, 기본 팔레트가 지키는 대비 규칙을 12가지 조합 모두에 적용한다.

브라우저 없이 확인할 수 있는 것은 여기까지다: 각 조합에서 어떤 값이 이기는지
(선택자와 순서), 그 값들의 WCAG 대비. 눈으로 보는 확인은 이 테스트가 대신하지
못한다.
"""
import math
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "static" / "css" / "tokens.css"
INDEX = ROOT / "static" / "index.html"
SETTINGS_JS = ROOT / "static" / "js" / "settings.js"

THEMES = ["forest", "sea", "lavender", "ink", "white"]
ALL_THEMES = ["default", *THEMES]
MEDIA_DARK = "(prefers-color-scheme: dark)"


def _read(path):
    # Windows autocrlf 체크아웃이 \r\n 을 줄 수 있다.
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def _rules(css):
    """[(media or None, selector, {name: value})] in source order."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out, i = [], 0

    def parse(body, media):
        j = 0
        while True:
            open_ = body.find("{", j)
            if open_ < 0:
                return
            head = body[j:open_].strip()
            depth, k = 1, open_ + 1
            while depth:
                depth += {"{": 1, "}": -1}.get(body[k], 0)
                k += 1
            inner = body[open_ + 1:k - 1]
            if head.startswith("@media"):
                parse(inner, head[len("@media"):].strip())
            else:
                decls = {}
                for d in inner.split(";"):
                    if ":" in d:
                        name, value = d.split(":", 1)
                        decls[name.strip()] = " ".join(value.split())
                out.append((media, head, decls))
            j = k

    parse(css, None)
    return out


RULES = _rules(_read(TOKENS))


def _block(selector, media=None):
    """Every declaration made under exactly this selector, later ones winning
    -- `:root[data-mode="dark"]` is written as two rules (color-scheme, and
    the forced-dark palette)."""
    found = [d for m, s, d in RULES if s == selector and m == media]
    assert found, f"no `{selector}` block (media={media})"
    merged = {}
    for d in found:
        merged.update(d)
    return merged


def _tokens(decls):
    return {k: v for k, v in decls.items() if k.startswith("--")}


def _has_block(selector, media=None):
    return any(s == selector and m == media for m, s, _ in RULES)


ROOT_LIGHT = _block(":root")
COLOUR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\(")
# 기본 팔레트가 색으로 정의하는 모든 토큰 -- 그림자도 색이 들어 있으니 포함한다.
COLOUR_TOKENS = sorted(k for k, v in ROOT_LIGHT.items() if k.startswith("--") and COLOUR_RE.search(v))


def _dark_selectors(theme):
    """(media 안의 선택자, media 밖의 선택자) -- 자동+OS 다크 / 어둡게."""
    base = ":root" if theme == "default" else f':root[data-theme="{theme}"]'
    return f'{base}:not([data-mode="light"])', f'{base}[data-mode="dark"]'


def resolve(theme, mode):
    """Cascade the way the browser does for these selectors: each later/more
    specific block only ever adds to the one before, so source-order layering
    is exact here (the default dark blocks sit after every theme's light block,
    and each theme's dark block is more specific than the default's)."""
    tokens = dict(ROOT_LIGHT)
    if theme != "default":
        tokens.update(_block(f':root[data-theme="{theme}"]'))
    if mode == "dark":
        tokens.update(_block(_dark_selectors("default")[0], MEDIA_DARK))
        if theme != "default":
            tokens.update(_block(_dark_selectors(theme)[0], MEDIA_DARK))
    return tokens


# ---------- colour maths ----------

def _hex(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _rgb(value, over=None):
    value = value.strip()
    if value.startswith("#"):
        return _hex(value)
    m = re.fullmatch(r"rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)", value)
    assert m, f"can't read colour {value!r}"
    assert over is not None, f"{value!r} is translucent and needs a backdrop"
    r, g, b, a = (float(x) for x in m.groups())
    return tuple(a * c / 255 + (1 - a) * o for c, o in zip((r, g, b), over))


def _lum(c):
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    hi, lo = sorted((_lum(a), _lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _lab(c):
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    r, g, b = lin
    x = (r * .4124 + g * .3576 + b * .1805) / .95047
    y = r * .2126 + g * .7152 + b * .0722
    z = (r * .0193 + g * .1192 + b * .9505) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


def delta_e(a, b):
    return math.dist(_lab(a), _lab(b))


def _c(tokens, name):
    return _rgb(tokens[name], over=_rgb(tokens["--bg"]))


COMBOS = [(t, m) for t in ALL_THEMES for m in ("light", "dark")]
ids = [f"{t}-{m}" for t, m in COMBOS]

# (foreground, background, minimum). The default palette's own rules -- see
# the comments beside its values in tokens.css.
CONTRAST_RULES = [
    ("--text", "--bg", 7),
    ("--text", "--surface", 7),
    ("--text-dim", "--bg", 4.5),
    ("--accent-ink", "--accent-soft", 4.5),
    ("--on-accent", "--accent", 4.5),
    ("--correct-ink", "--correct-bg", 4.5),
    ("--suggest-ink", "--suggest-bg", 4.5),
    ("--warn-ink", "--warn-bg", 4.5),
]


@pytest.mark.parametrize("theme,mode", COMBOS, ids=ids)
@pytest.mark.parametrize("fg,bg,minimum", CONTRAST_RULES, ids=[f"{f}-on-{b}" for f, b, _ in CONTRAST_RULES])
def test_contrast(theme, mode, fg, bg, minimum):
    t = resolve(theme, mode)
    ratio = contrast(_c(t, fg), _c(t, bg))
    assert ratio >= minimum, f"{theme}/{mode}: {fg} on {bg} is {ratio:.2f}:1, needs {minimum}:1"


@pytest.mark.parametrize("theme,mode", COMBOS, ids=ids)
def test_surface_is_visibly_distinct_from_bg(theme, mode):
    """The file's own history: 1.04:1 left .msg.bot as bare text on the page.
    New themes clear 1.08:1; the default light pair, measured the same way,
    is 1.068:1 and is held there rather than silently changed."""
    t = resolve(theme, mode)
    ratio = contrast(_c(t, "--surface"), _c(t, "--bg"))
    minimum = 1.065 if (theme, mode) == ("default", "light") else 1.08
    assert ratio >= minimum, f"{theme}/{mode}: --surface on --bg is {ratio:.3f}:1"


@pytest.mark.parametrize("theme,mode", COMBOS, ids=ids)
def test_correction_suggestion_and_accent_stay_apart(theme, mode):
    """Rose (fix this), green (another way to say it) and the accent (press
    this) must not blur into each other. Light compares the hues themselves;
    dark compares the inks, which are what the dark palette shows. CIE76
    delta-E >= 15 -- the default palette's accent/rose pair, the closest one it
    has, is 16."""
    t = resolve(theme, mode)
    names = ("--accent", "--correct", "--suggest") if mode == "light" else ("--accent", "--correct-ink", "--suggest-ink")
    cols = {n: _c(t, n) for n in names}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            d = delta_e(cols[a], cols[b])
            assert d >= 15, f"{theme}/{mode}: {a} and {b} are only delta-E {d:.1f} apart"


@pytest.mark.parametrize("theme", THEMES)
def test_every_theme_defines_every_colour_token_itself(theme):
    """No colour inherited from 기본: a theme that forgets one shows a stray
    terracotta instead of failing anywhere visible."""
    assert COLOUR_TOKENS, "found no colour tokens in :root"
    light = _block(f':root[data-theme="{theme}"]')
    dark = _block(_dark_selectors(theme)[0], MEDIA_DARK)
    for label, block in (("light", light), ("dark", dark)):
        missing = [n for n in COLOUR_TOKENS if n not in block]
        assert not missing, f"{theme} {label} block lacks {missing}"


@pytest.mark.parametrize("theme", ALL_THEMES)
def test_dark_applies_on_os_dark_unless_light_is_chosen(theme):
    """자동 + OS 다크 → dark; 밝게 must win over an OS in dark mode, so the
    media-query copy is guarded by :not([data-mode="light"])."""
    inside, _ = _dark_selectors(theme)
    assert _has_block(inside, MEDIA_DARK), (
        f"no `{inside}` inside @media {MEDIA_DARK} -- 밝게 would lose to a dark OS"
    )
    bare = ":root" if theme == "default" else f':root[data-theme="{theme}"]'
    assert not _has_block(bare, MEDIA_DARK), (
        f"`{bare}` inside the dark media query ignores data-mode=\"light\""
    )


@pytest.mark.parametrize("theme", ALL_THEMES)
def test_dark_chosen_outright_matches_the_os_dark_copy(theme):
    """어둡게 applies the same values with no media query; the two copies are
    written out twice, so they are held equal here."""
    inside, outside = _dark_selectors(theme)
    assert _tokens(_block(outside)) == _tokens(_block(inside, MEDIA_DARK))


def test_color_scheme_follows_the_chosen_brightness():
    assert ROOT_LIGHT.get("color-scheme") == "light dark"
    assert _block(':root[data-mode="light"]').get("color-scheme") == "light"
    assert _block(':root[data-mode="dark"]').get("color-scheme") == "dark"


def test_no_colour_is_defined_only_in_a_dark_block():
    light_names = set(ROOT_LIGHT)
    for media, selector, decls in RULES:
        if media == MEDIA_DARK or '[data-mode="dark"]' in selector:
            extra = {n for n in decls if n.startswith("--")} - light_names
            assert not extra, f"`{selector}` defines {extra}, which no light block does"


def test_theme_ids_agree_across_css_html_and_js():
    """The CSS, the pre-paint script in index.html, the swatches and
    settings.js must name the same themes."""
    html = _read(INDEX)
    js = _read(SETTINGS_JS)
    css_themes = sorted({m for m in re.findall(r'data-theme="([\w-]+)"', _read(TOKENS))})
    assert css_themes == sorted(THEMES)
    for theme in ALL_THEMES:
        assert f'data-theme-choice="{theme}"' in html, f"no swatch for {theme}"
        assert f"'{theme}'" in js, f"settings.js doesn't know {theme}"
    head = html[:html.index("</head>")]
    for theme in ALL_THEMES:
        assert theme in head.split("<script>", 1)[1], f"pre-paint script doesn't accept {theme}"


def test_pre_paint_script_runs_before_the_stylesheets():
    """No flash of 기본: the attributes must be on <html> before tokens.css
    applies, so the inline script sits above the first stylesheet link."""
    html = _read(INDEX)
    script = html.find("<script>")
    css = html.find('<link rel="stylesheet"')
    assert 0 <= script < css < html.index("</head>")


@pytest.mark.parametrize("theme", ALL_THEMES)
def test_swatch_shows_the_themes_own_light_colours(theme):
    html = _read(INDEX)
    m = re.search(rf'data-theme-choice="{theme}"[^>]*style="--sw-bg: (#[0-9a-f]+); --sw-accent: (#[0-9a-f]+);"', html)
    assert m, f"no swatch colours for {theme}"
    t = resolve(theme, "light")
    assert (m.group(1), m.group(2)) == (t["--bg"], t["--accent"])
