# Lux Knowledge connector

Lux Knowledge is an optional source Naya can search through the canonical host. Its read connector is integrated with the source registry and typed helper tools; it is not an unconnected prototype or a copy of the knowledge database inside Didi.

## Read boundary

`LUX_KNOWLEDGE_TOOLS` in `server/connectors/lux-knowledge.ts` contains `search_knowledge` and `get_insight`. `createLuxKnowledgeReader` implements `LuxKnowledgeReader` against an approved endpoint, account/resource, schema digest and generation. `LuxKnowledgeResult` distinguishes accepted evidence from refused or unknown outcomes.

The `luxKnowledgeDescriptor` entry in `server/connectors/index.ts` publishes the local read contract. `projectLuxResult` in `server/tools/lux-knowledge.ts` produces the model-visible projection. A remote response is not permission to pass arbitrary tool text, private fields or instructions directly to a model.

## Search and source reads

Use search to find relevant evidence, then retrieve the identified insight when the question needs its body. A weak or empty match is not a confident fact. Preserve source identity and coverage, including when a body is bounded or unavailable.

The helper chooses explicit typed reads. `search_knowledge` returns candidate hits; when the answer needs an entry's body, the helper can follow its id with `read_knowledge`. The connector maps that read to the service's `get_insight` with the requested id. There is no automatic second-stage batch selected by the wording of the question. Preserve the returned entry's identity and distinguish an unavailable body from an empty result.

The search's `mode` is the vault's own depth, `full` (ranked hybrid search, the server default) or `fast` (keyword only: titles and snippets, unranked, quick). The connector accepts exactly those two spellings and forwards the mode only when the caller chose one, so an unstated mode keeps the ranked wire shape. The helper searches fast first for a named topic, person or project at a small limit, reads the matching record with `read_knowledge` and answers from its body; when the fast hit does not clearly match the asked name, or fast is empty, it searches full. A fast hit is a lead, never an answer and never proof of absence: the in-process bench measured fast 70 ms at p50 (62 ms at limit 3) against full 1528 ms, and fast's top three held full's top hit for only seven of ten verified queries while returning hits for three of five absent topics. A title is never a fact, and the `confidence` and `low_confidence` header fields are not a trust gate, because they contradict each other in fast mode.

The reader owns accepted argument shapes and budgets. `KNOWLEDGE_BODY_MIN_CHARS`, `KNOWLEDGE_BODY_MAX_CHARS`, `KNOWLEDGE_DEADLINE_MIN_MS` and `KNOWLEDGE_DEADLINE_MAX_MS` are source constants, not a second set of documentation defaults. The source's result envelope and actual capture determine what was received; a local projection is not proof that the entire corpus was searched.

## Setup and authority

Configure the owner's endpoint and account through [mcp-configuration.md](mcp-configuration.md). A reachable knowledge server still needs a valid connection approval and allowed inference route/classes. Missing configuration or sign-in must remain unavailable, not become a successful empty answer.

The read envelope does not authorize remote writes. Dictated and composed Lux notes use separate host-owned write paths with different owner gates; see [tool-owner.md](tool-owner.md) and [privacy-and-authority.md](privacy-and-authority.md). Searching knowledge is not consent to save conversation content back into it. Both write paths name exactly one remote tool, `save_insight` under project `didi-voice`; `update_insight`, the delete and purge tools and every other write stay unreachable, so a helper or model-initiated call can reach only the two reads above.

## Diagnosis and verification

[Diagnostic store](diagnostic-store.md) explains canonical tool executions, captured source results and gated local inspection. Never publish private insight bodies or connection credentials as test fixtures. `scripts/check-knowledge-connector.sh` is the focused producer; use [checks.md](checks.md) for managed routing. Its fake source proves protocol and projection handling, not real account access or retrieval quality.
