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
