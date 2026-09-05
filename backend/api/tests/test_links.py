from app.generation.links import strip_external_links


def test_removes_markdown_external_link_keeping_text():
    assert strip_external_links("veja a [documentação](https://python.org) hoje") == (
        "veja a documentação hoje"
    )


def test_removes_bare_url():
    assert strip_external_links("acesse https://exemplo.com para ver").strip() == "acesse para ver"


def test_removes_www_url():
    assert strip_external_links("fonte: www.exemplo.com").strip() == "fonte:"


def test_keeps_internal_anchor():
    markdown = "- [Como funciona](#como-funciona)"
    assert strip_external_links(markdown) == markdown


def test_keeps_url_inside_fenced_code_block():
    markdown = "```python\nrequests.get('https://api.exemplo.com')\n```"
    assert strip_external_links(markdown) == markdown


def test_keeps_url_inside_inline_code():
    markdown = "use `https://api.exemplo.com` no cliente"
    assert strip_external_links(markdown) == markdown


def test_removes_angle_bracket_url():
    assert strip_external_links("leia <https://exemplo.com>").strip() == "leia"


def test_keeps_plain_source_mention():
    markdown = "segundo a documentação oficial do Python"
    assert strip_external_links(markdown) == markdown
