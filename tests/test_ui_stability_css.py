import re
from pathlib import Path

CSS = (Path(__file__).resolve().parents[1] / "static" / "css")


def _all_css():
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(CSS.glob("*.css")))


def test_notice_floats_instead_of_pushing_the_page():
    css = _all_css()
    assert ".toast" in css and "position: fixed" in css.split(".toast", 1)[1].split("}", 1)[0]


def test_stability_utilities_exist():
    css = _all_css()
    for rule in (".is-invisible", ".skeleton", ".is-refreshing", ".screen-enter", "scrollbar-gutter: stable"):
        assert rule in css, rule


def _reduced_motion_blocks(css):
    """The declaration body of every `@media (prefers-reduced-motion: reduce)
    { ... }` block, found by brace counting so a nested rule's own `}`
    doesn't end a match early (the loose version of this test split on the
    first `}` and could match past the block's own close). There can be more
    than one such block in the combined CSS -- e.g. an existing one for
    `.thinking`/`.mic.listening` alongside the one this task adds -- so every
    occurrence of the marker is collected, not just the first."""
    marker = "prefers-reduced-motion: reduce"
    blocks = []
    pos = 0
    while True:
        idx = css.find(marker, pos)
        if idx == -1:
            break
        start = css.index("{", idx + len(marker)) + 1
        depth, i = 1, start
        while depth:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        blocks.append(css[start:i - 1])
        pos = i
    return blocks


def test_motion_is_switched_off_for_reduced_motion():
    css = _all_css()
    block = "\n".join(_reduced_motion_blocks(css))
    for selector in (".screen-enter", ".skeleton"):
        # The selector must appear in a rule inside the block, and that rule's
        # declarations must turn its animation off -- not merely mention the
        # selector's name somewhere in the block.
        assert selector in block, f"{selector} must be disabled under reduced motion"
        rule_start = block.index(selector)
        body_start = block.index("{", rule_start) + 1
        body_end = block.index("}", body_start)
        body = block[body_start:body_end]
        assert "animation: none" in body, f"{selector}'s reduced-motion rule must set animation: none"


def _rule_body(css, selector_with_brace):
    """The declaration body of the first rule whose selector text is exactly
    `selector_with_brace` (e.g. `.screen-enter {`), found by brace counting."""
    idx = css.index(selector_with_brace)
    body_start = idx + len(selector_with_brace)
    depth, i = 1, body_start
    while depth:
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
        i += 1
    return css[body_start:i - 1]


def _keyframes_body(css, name):
    marker = f"@keyframes {name}"
    idx = css.index(marker)
    body_start = css.index("{", idx + len(marker)) + 1
    depth, i = 1, body_start
    while depth:
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
        i += 1
    return css[body_start:i - 1]


def _animation_name(rule_body):
    m = re.search(r"animation(?:-name)?:\s*([\w-]+)", rule_body)
    assert m, f"no animation-name found in rule: {rule_body!r}"
    return m.group(1)


def test_screen_enter_keyframes_animate_opacity_only_not_transform():
    """A transform on `.screen-enter` (the screen element itself) makes it the
    containing block for any `position: fixed` descendant -- #report-wait
    lives inside #session -- and breaks `position: sticky` on any descendant
    too -- #mic-dock also lives inside #session. Both are dormant today (the
    session screen isn't wired to router.show() yet) but real in a browser
    and invisible to node tests, so screens fade with opacity only.

    `.toast` has no fixed/sticky descendants of its own, so it may still
    translate -- this test only constrains `.screen-enter`'s keyframes."""
    css = _all_css()
    screen_enter_name = _animation_name(_rule_body(css, ".screen-enter {"))
    screen_enter_body = _keyframes_body(css, screen_enter_name)
    assert "transform" not in screen_enter_body, (
        ".screen-enter's keyframes must not animate transform -- it would break "
        "fixed/sticky descendants of the screen it's applied to"
    )

    toast_name = _animation_name(_rule_body(css, ".toast {"))
    toast_body = _keyframes_body(css, toast_name)
    assert "transform" in toast_body, ".toast has no fixed/sticky descendants and may still translate"


def test_mic_hint_is_two_lines_tall_and_clamped():
    """#mic-hint never changes the dock's height (spec R6): two lines held
    open, two lines at most."""
    body = _rule_body(_all_css(), "#mic-hint {")
    assert "-webkit-line-clamp: 2" in body
    assert "display: -webkit-box" in body
    assert "overflow: hidden" in body
    assert "min-height: calc(2 * 1.55em)" in body


def test_chip_detail_opens_by_grid_rows_not_hidden():
    """The correction chip's detail eases open (spec R8): a grid row from 0fr
    to 1fr, its inner wrapper clipped, and its content fading in with it."""
    css = _all_css()
    detail = _rule_body(css, ".chip-detail {")
    assert "display: grid" in detail and "grid-template-rows: 1fr" in detail
    assert "transition: grid-template-rows" in detail
    assert "grid-template-rows: 0fr" in _rule_body(css, ".chip-detail.is-collapsed {")
    inner = _rule_body(css, ".chip-detail-inner {")
    assert "overflow: hidden" in inner and "opacity" in inner


def test_report_wait_fades_in_with_opacity_only():
    """#report-wait is itself position: fixed; its fade is opacity alone."""
    css = _all_css()
    name = _animation_name(_rule_body(css, ".report-wait {"))
    frames = _keyframes_body(css, name)
    assert "opacity" in frames and "transform" not in frames


REFRESHED_CARDS = ("#today-card", "#today-alt", "#recommend", "#resume-card",
                   "#week-card", "#recent-themes-wrap", "#library-progress")


def test_refreshed_cards_ease_both_ways_and_only_dim_on_a_slow_reload():
    """The opacity transition sits on the cards themselves, so un-dimming eases
    back as well as dimming; the dim side waits 200ms so a fast local reload
    never visibly dims at all. The base rule is `:where(...)` (no specificity)
    so `.is-refreshing`'s transition-delay is not overruled by an id rule."""
    css = _all_css()
    marker = ":where(" + ", ".join(REFRESHED_CARDS) + ") {"
    assert "transition: opacity var(--dur-fast) ease" in _rule_body(css, marker)
    dim = _rule_body(css, ".is-refreshing {")
    assert "opacity: .55" in dim
    assert "transition-delay: 200ms" in dim
    assert "transition:" not in dim, "a shorthand here would reset the base rule's easing"


def test_dimmed_cards_do_not_take_clicks():
    """home.js sets `inert` on the dimmed cards; this is the belt."""
    assert "pointer-events: none" in _rule_body(_all_css(), ".is-refreshing {")


def test_refreshed_cards_do_not_transition_under_reduced_motion():
    block = "\n".join(_reduced_motion_blocks(_all_css()))
    marker = ".is-refreshing, :where(" + ", ".join(REFRESHED_CARDS) + ") {"
    body = _rule_body(block, marker)
    assert "transition: none" in body and "transition-delay: 0s" in body
