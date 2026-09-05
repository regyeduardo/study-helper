_SCHEMAS = {
    "flowchart": """<Schema JSON para flowchart>
{
  "direction": "TD|LR|RL|BT",
  "nodes": [{ "id": "string", "text": "string", "shape": "rounded|stadium|diam|circle|cyl|hex|parallelogram (opcional)" }],
  "links": [{ "from": "string", "to": "string", "text": "string (opcional)", "shape": "dotted|thick|invisible (opcional)", "head": "none (opcional)" }],
  "subgraphs": [{ "id": "string", "title": "string", "nodes": [...], "links": [...], "children": [...] }]
}

Exemplo:
{
  "direction": "TD",
  "nodes": [
    { "id": "inicio", "text": "Início", "shape": "rounded" },
    { "id": "decisao", "text": "É válido?", "shape": "diam" },
    { "id": "fim", "text": "Fim", "shape": "rounded" }
  ],
  "links": [
    { "from": "inicio", "to": "decisao", "text": "verificar" },
    { "from": "decisao", "to": "fim", "text": "sim" }
  ]
}
""",
    "sequence": """<Schema JSON para sequence>
{
  "autonumber": false,
  "actors": [{ "id": "string", "name": "string", "type": "actor|participant (opcional)" }],
  "messages": [{ "from": "string", "to": "string", "text": "string", "type": "solid|dashed|dotted|async (opcional)" }]
}

Exemplo:
{
  "actors": [
    { "id": "cliente", "name": "Cliente" },
    { "id": "servidor", "name": "Servidor" }
  ],
  "messages": [
    { "from": "cliente", "to": "servidor", "text": "GET /api/dados" },
    { "from": "servidor", "to": "cliente", "text": "200 OK", "type": "dashed" }
  ]
}
""",
    "class": """<Schema JSON para class>
{
  "direction": "TB|LR|RL|BT",
  "classes": [{
    "name": "string",
    "members": [{ "name": "string", "type": "string", "visibility": "+|-|#|~ (opcional)" }],
    "methods": [{ "name": "string", "return_type": "string (opcional)", "parameters": [{ "name": "string", "type": "string" }], "visibility": "+|-|#|~ (opcional)" }]
  }],
  "relations": [{ "from": "string", "to": "string", "type": "association|aggregation|composition|inheritance (opcional)", "label": "string (opcional)" }]
}

Exemplo:
{
  "direction": "TB",
  "classes": [
    { "name": "Animal", "members": [{ "name": "nome", "type": "String", "visibility": "+" }], "methods": [{ "name": "emitirSom", "return_type": "void", "visibility": "+" }] },
    { "name": "Cachorro", "methods": [{ "name": "emitirSom", "return_type": "void", "visibility": "+" }] }
  ],
  "relations": [{ "from": "Cachorro", "to": "Animal", "type": "inheritance" }]
}
""",
    "state": """<Schema JSON para state>
{
  "states": [{ "id": "string", "description": "string" }],
  "transitions": [{ "from": "string", "to": "string", "description": "string (opcional)" }]
}

Exemplo:
{
  "states": [
    { "id": "pendente", "description": "Pedido Pendente" },
    { "id": "pago", "description": "Pedido Pago" }
  ],
  "transitions": [{ "from": "pendente", "to": "pago", "description": "pagamento aprovado" }]
}
""",
    "pie": """<Schema JSON para pie>
{
  "title": "string (opcional)",
  "data": [{ "label": "string", "value": 10 }]
}

Exemplo:
{
  "data": [
    { "label": "Frontend", "value": 40 },
    { "label": "Backend", "value": 35 },
    { "label": "Banco de Dados", "value": 25 }
  ]
}
""",
    "gantt": """<Schema JSON para gantt>
{
  "title": "string (opcional)",
  "dateLine": "YYYY-MM-DD (opcional)",
  "sections": [{ "name": "string", "tasks": [{ "id": "string (opcional)", "desc": "string", "start": "string", "end": "string", "status": "done|active|crit|milestone (opcional)" }] }]
}

Exemplo:
{
  "title": "Cronograma do Projeto",
  "sections": [{ "name": "Fase 1", "tasks": [{ "desc": "Análise", "start": "2024-01-01", "end": "2024-01-15" }] }]
}
""",
    "mindmap": """<Schema JSON para mindmap>
{
  "root": "string",
  "nodes": [{ "text": "string", "level": 1 }]
}

Exemplo:
{
  "root": "POO em Java",
  "nodes": [
    { "text": "Classes", "level": 1 },
    { "text": "Atributos", "level": 2 },
    { "text": "Herança", "level": 1 }
  ]
}
""",
}


def diagram_prompt(diagram_type: str, hint: str, context: str, previous_error: str = "") -> str:
    parts = []
    if previous_error:
        parts.append(f"[Auto-Correção]\nErro na tentativa anterior: {previous_error}\n")
    parts.append(_SCHEMAS.get(diagram_type, ""))
    parts.append(f"\nO diagrama deve mostrar: {hint}\n")
    parts.append(f"Contexto do conteúdo:\n{context}\n")
    parts.append("Retorne apenas o objeto JSON de dados, sem cercas de markdown e sem campos extras.")
    return "\n".join(parts)


def build_context(elements: list[dict], diagram_element_index: int, window: int = 3) -> str:
    text_types = {"paragraph", "heading", "bulletedList", "orderedList"}

    def element_text(element: dict) -> str | None:
        if element.get("type") not in text_types:
            return None
        if element["type"] in ("bulletedList", "orderedList"):
            return "\n".join(str(item) for item in element.get("items") or [])
        return element.get("text")

    before: list[str] = []
    after: list[str] = []

    index = diagram_element_index - 1
    while index >= 0 and len(before) < window:
        text = element_text(elements[index])
        if text:
            before.insert(0, text)
        index -= 1

    index = diagram_element_index + 1
    while index < len(elements) and len(after) < window:
        text = element_text(elements[index])
        if text:
            after.append(text)
        index += 1

    return "\n\n".join(before + after)
