def table_fallback(hint: str) -> str:
    rows = [_split_row(clause) for clause in _split_clauses(hint)]
    lines = ["| Conceito | Descrição |", "|----------|-----------|"]
    lines.extend(f"| {concept} | {description} |" for concept, description in rows)
    return "\n".join(lines)


def _split_clauses(hint: str) -> list[str]:
    best = [hint]
    for separator in (". ", ", ", ";"):
        parts = [part.strip() for part in hint.split(separator)]
        cleaned = [part for part in parts if part]
        if len(cleaned) > len(best):
            best = cleaned
    return best or [hint]


def _split_row(clause: str) -> tuple[str, str]:
    fields = clause.strip().split()
    if not fields:
        return "", ""
    if len(fields) == 1:
        return fields[0], ""
    return fields[0], " ".join(fields[1:])
