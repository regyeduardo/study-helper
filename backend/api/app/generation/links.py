import re

_FENCE_RE = re.compile(r"(```.*?```|~~~.*?~~~|`[^`\n]*`)", re.DOTALL)
_MD_LINK_RE = re.compile(r"\[([^\]\n]*)\]\(\s*([^)\s]+)[^)]*\)")
_ANGLE_URL_RE = re.compile(r"<\s*(https?://[^>\s]+)\s*>")
_BARE_URL_RE = re.compile(r"(?<![\w(])((?:https?://|www\.)[^\s<>)\]]+)")
_EXTERNAL_RE = re.compile(r"^(https?://|www\.|//)", re.IGNORECASE)


def strip_external_links(markdown: str) -> str:
    parts = _FENCE_RE.split(markdown)
    for index, part in enumerate(parts):
        if index % 2 == 1:
            continue
        parts[index] = _clean(part)
    return "".join(parts)


def _clean(text: str) -> str:
    text = _MD_LINK_RE.sub(_replace_markdown_link, text)
    text = _ANGLE_URL_RE.sub("", text)
    text = _BARE_URL_RE.sub("", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r" +([,.;:!?])", r"\1", text)
    return text


def _replace_markdown_link(match: re.Match) -> str:
    label, target = match.group(1), match.group(2)
    if _EXTERNAL_RE.match(target):
        return label
    return match.group(0)
