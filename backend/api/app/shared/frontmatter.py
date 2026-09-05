import re

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_frontmatter(content: str) -> tuple[dict[str, str], str]:
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}, content

    meta: dict[str, str] = {}
    for line in match.group(1).split("\n"):
        separator = line.find(":")
        if separator > 0:
            meta[line[:separator].strip()] = line[separator + 1 :].strip()
    return meta, match.group(2).strip()


def add_frontmatter(content: str, file_type: str | None = None) -> str:
    if not file_type:
        return content
    return f"---\ntype: {file_type}\n---\n\n{content}"
