# Lux Knowledge connector

Lux Knowledge is an optional source Naya can search through the canonical host. Its read connector is integrated with the registry, tools and research path; it is not an unconnected prototype or a copy of the knowledge database inside Didi.

## Read boundary

`LUX_KNOWLEDGE_TOOLS` in `server/connectors/lux-knowledge.ts` contains `search_knowledge` and `get_insight`. `createLuxKnowledgeReader` implements `LuxKnowledgeReader` against an approved endpoint, account/resource, schema digest and generation. `LuxKnowledgeResult` distinguishes accepted evidence from refused or unknown outcomes.

The `luxKnowledgeDescriptor` entry in `server/connectors/index.ts` publishes the local read contract. `projectLuxResult` in `server/tools/lux-knowledge.ts` produces the model-visible projection. A remote response is not permission to pass arbitrary tool text, private fields or instructions directly to a model.

## Search and source reads

Use search to find relevant evidence, then retrieve the identified insight when the question needs its body. A weak or empty match is not a confident fact. Preserve source identity and coverage, including when a body is bounded or unavailable.

The reader owns accepted argument shapes and budgets. `KNOWLEDGE_BODY_MIN_CHARS`, `KNOWLEDGE_BODY_MAX_CHARS`, `KNOWLEDGE_DEADLINE_MIN_MS` and `KNOWLEDGE_DEADLINE_MAX_MS` are source constants, not a second set of documentation defaults. The source's result envelope and actual capture determine what was received; a local projection is not proof that the entire corpus was searched.

## Setup and authority

Configure the owner's endpoint and account through [mcp-configuration.md](mcp-configuration.md). A reachable knowledge server still needs a valid connection approval and allowed inference route/classes. Missing configuration or sign-in must remain unavailable, not become a successful empty answer.

The read envelope does not authorize remote writes. Dictated and composed Lux notes use separate host-owned write paths with different owner gates; see [tool-owner.md](tool-owner.md) and [privacy-and-authority.md](privacy-and-authority.md). Searching knowledge is not consent to save conversation content back into it.

## Diagnosis and verification

[Diagnostic store](diagnostic-store.md) explains canonical tool executions, captured source results and gated local inspection. Never publish private insight bodies or connection credentials as test fixtures. `scripts/check-knowledge-connector.sh` is the focused producer; use [checks.md](checks.md) for managed routing. Its fake source proves protocol and projection handling, not real account access or retrieval quality.
