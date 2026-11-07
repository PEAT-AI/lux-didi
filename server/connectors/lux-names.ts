/** Wire identities that the host must recognize. Discovery owns schemas and read admission. */
export const LUX_TOOLS = {
  search: 'search_insights', get: 'get_insight', meetings: 'list_meetings', meeting: 'get_meeting', insights: 'list_insights',
  create: 'create_insight', update: 'update_insight', link: 'create_insight_link', feedback: 'record_search_feedback',
} as const;
export const LUX_WRITE_TOOLS = [LUX_TOOLS.create, LUX_TOOLS.update, LUX_TOOLS.link, LUX_TOOLS.feedback] as const;
export const LUX_FORBIDDEN_TOOLS = ['archive_insight', 'unarchive_insight', 'purge_insight', 'revert_insight', 'remove_insight_expiry', 'checkpoint', 'list_link_proposals', 'list_contradiction_cases', 'resolve_contradiction_case'] as const;

/** Only non-destructive agent mutations qualify; being non-read-only alone grants nothing. */
export function luxWriteAdmitted(tool: { name: string; description?: string; annotations?: unknown }): boolean {
  if ((LUX_FORBIDDEN_TOOLS as readonly string[]).includes(tool.name)) return false;
  if (!tool.annotations || typeof tool.annotations !== 'object' || Array.isArray(tool.annotations)) return false;
  const hints = tool.annotations as Record<string, unknown>;
  if (hints.readOnlyHint !== false || hints.destructiveHint !== false) return false;
  return (hints.idempotentHint === true || /\b(create|store|update|correct|link|feedback)\b/i.test(tool.description ?? ''));
}

/** Only names the host itself must populate, inspect or bound. Other fields pass through untouched. */
export const LUX_PARAMS = {
  includeSensitive: 'include_sensitive', limit: 'limit', query: 'query', insightIds: 'insight_ids',
  insightId: 'insight_id', content: 'content', title: 'insight_title', category: 'insight_type', project: 'project',
  sourceKind: 'source_kind', sourceRef: 'source_ref', quote: 'quote', idempotencyKey: 'idempotency_key',
  followUpState: 'follow_up_state', revisionReason: 'revision_reason',
  sourceInsightId: 'source_insight_id', targetInsightId: 'target_insight_id', verdict: 'verdict',
} as const;
