function splitClauses(hint: string): string[] {
  let best = [hint]
  for (const separator of ['. ', ', ', ';']) {
    const cleaned = hint
      .split(separator)
      .map(part => part.trim())
      .filter(Boolean)
    if (cleaned.length > best.length) best = cleaned
  }
  return best.length ? best : [hint]
}

function splitRow(clause: string): [string, string] {
  const fields = clause.trim().split(/\s+/).filter(Boolean)
  if (!fields.length) return ['', '']
  if (fields.length === 1) return [fields[0], '']
  return [fields[0], fields.slice(1).join(' ')]
}

export function tableFallback(hint: string): string {
  const rows = splitClauses(hint).map(splitRow)
  return ['| Conceito | Descrição |', '|----------|-----------|', ...rows.map(([concept, description]) => `| ${concept} | ${description} |`)].join('\n')
}
