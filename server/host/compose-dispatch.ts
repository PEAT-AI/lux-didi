import type { McpPort } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { Store } from '../runtime/store.js';
import { connectorDescriptor } from '../connectors/index.js';
import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import { createdEventResult, draftChatResult, draftEmailResult, notAuthorizedFor, type ComposeName } from '../tools/compose.js';
import { decodeGoogleEnvelope, googleToolStatus, readGooglePayload } from '../tools/google.js';
import { validatePolicy } from '../tools/index.js';
import type { ComposeDispatch, ComposeOutcome, ConnectionPolicy } from '../tools/types.js';
import type { JsonObject } from '../adapters/model/types.js';

/**
 * W1030: the host's compose port, the one thing that may reach a mail, chat or calendar write. It calls
 * the real endpoints through the registry the host already owns, under that endpoint's own approved
 * grant, and answers the closed outcome the compose tools already speak: `connected` only for an
 * endpoint whose write family is admitted and consented, `not_authorized` with the one command to run
 * for a family that is not, and `unknown` rather than an invented success when the answer is lost.
 *
 * Every call goes through the connector's own reader, so the family's argument guards apply: an event
 * carries no attendee and no update notification, a draft carries no send, and a delete names the exact
 * event id. Nothing here can send, post or invite.
 */
export function createComposeDispatch(options: { store: Store; ownerId: string; registry: McpRegistry; port: McpPort }): ComposeDispatch {
  const { store, ownerId, registry, port } = options;

  /** The approved policy of the one connection whose grant names this published tool, or undefined. */
  const policyFor = (connector: string, tool: string): ConnectionPolicy | undefined => {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = store.transaction(tx => tx.all('SELECT policy_json FROM tool_connections WHERE owner_id=?', [ownerId]));
    } catch { return undefined; }
    for (const row of rows) {
      try {
        const policy = validatePolicy(JSON.parse(String(row['policy_json'])) as ConnectionPolicy);
        if (policy.enabled && policy.connector === connector && policy.toolNames.includes(tool)) return policy;
      } catch { /* an unreadable row is not an approval this port may spend */ }
    }
    return undefined;
  };

  const call = async (connector: string, tool: string, args: Record<string, unknown>): Promise<ConnectorResult> => {
    const policy = policyFor(connector, tool);
    const descriptor = connectorDescriptor(connector);
    if (policy === undefined || descriptor === undefined) return { state: 'refused', reason: 'not-configured' };
    const reader = descriptor.createReader({ port, registry, endpoint: policy.endpoint, schemaDigest: policy.schemaDigest, generation: policy.generation, policy });
    return await reader.call(tool, args);
  };

  /** The written id from one completed helper answer, or undefined when the answer carries none. */
  const writtenId = (result: ConnectorResult, field: string): string | undefined => {
    if (result.state !== 'completed') return undefined;
    const payload = readGooglePayload(port, result);
    if (!payload.ok) return undefined;
    const decoded = decodeGoogleEnvelope(payload.text);
    if (!decoded.ok) return undefined;
    const data = decoded.envelope['data'];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
    const value = (data as Record<string, unknown>)[field];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  /** One closed outcome for one failed connector answer, with the owner line for a missing consent. */
  const failed = (name: ComposeName, result: ConnectorResult): ComposeOutcome => {
    if (result.state === 'refused') return notAuthorizedFor(name);
    if (result.state === 'unknown') return { state: 'unknown', reason: result.reason };
    // Beyond the two local states above, the result is the endpoint's own evidence.
    const status = googleToolStatus(result as ConnectorEvidence);
    // A pinned credential or identity row is the family telling the owner to sign in again, which is
    // the same closed answer as a family that was never consented.
    if (status !== undefined && status.state === 'configured') return notAuthorizedFor(name);
    return { state: 'failed', reason: status?.code ?? (result.state === 'protocol-error' ? 'protocol_error' : 'helper_error') };
  };

  const write = async (name: ComposeName, connector: string, tool: string, args: Record<string, unknown>, build: (result: ConnectorResult) => JsonObject): Promise<ComposeOutcome> => {
    try {
      const result = await call(connector, tool, args);
      if (result.state === 'completed') return { state: 'done', response: build(result) };
      return failed(name, result);
    } catch { return { state: 'failed', reason: 'compose_unavailable' }; }
  };

  return {
    async draftEmail(input): Promise<ComposeOutcome> {
      return await write('draft_email', 'google', 'gmail_create_draft', {
        to: [input.to], subject: input.subject, body: input.body,
      }, result => {
        const draftId = writtenId(result, 'draft_id');
        return draftId === undefined ? { status: 'failed', code: 'draft_unconfirmed' } : draftEmailResult({ draftId, to: input.to, subject: input.subject });
      });
    },

    async draftChat(input): Promise<ComposeOutcome> {
      const target = input.channel !== undefined ? { channelId: input.channel } : input.person !== undefined ? { dmUsername: input.person } : undefined;
      if (target === undefined) return { state: 'failed', reason: 'invalid-draft-target' };
      const args: Record<string, unknown> = { message: input.message, ...target, ...(input.rootId !== undefined ? { rootId: input.rootId } : {}) };
      return await write('draft_chat', 'mattermost', 'mattermost_save_draft', args, () => draftChatResult({
        channelId: input.channel ?? input.person ?? '', target: input.person ?? input.channel ?? '', ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
      }));
    },

    async createEvent(input): Promise<ComposeOutcome> {
      return await write('create_event', 'google', 'calendar_create_event', {
        summary: input.summary, start: new Date(input.startUtc).toISOString(), end: new Date(input.endUtc).toISOString(),
        timeZone: input.timeZone, description: input.description, clientRequestId: input.clientRequestId,
      }, result => createdEventResult({
        eventId: writtenId(result, 'event_id') ?? '', window: { status: 'ready', startUtc: input.startUtc, endUtc: input.endUtc, timeZone: input.timeZone, names: [] },
        ...(writtenId(result, 'html_link') !== undefined ? { htmlLink: writtenId(result, 'html_link')! } : {}),
      }));
    },

    async deleteEvent(input): Promise<ComposeOutcome> {
      return await write('delete_event', 'google', 'calendar_delete_event', { eventId: input.eventId }, () => ({
        status: 'event_deleted', event_id: input.eventId,
        say: 'That block is off your calendar. I told nobody and invited nobody.',
      }));
    },

    /** W1030: the second delete arm, resolved through the calendar read this host already reaches. */
    async findNamedEvent(input): Promise<Awaited<ReturnType<NonNullable<ComposeDispatch['findNamedEvent']>>>> {
      try {
        const result = await call('google', 'calendar_list_events', { q: input.words, maxResults: 10 });
        if (result.state !== 'completed') return { state: 'none' };
        const payload = readGooglePayload(port, result);
        if (!payload.ok) return { state: 'none' };
        const decoded = decodeGoogleEnvelope(payload.text);
        if (!decoded.ok) return { state: 'none' };
        const data = decoded.envelope['data'];
        const events = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)['events'] : undefined;
        if (!Array.isArray(events)) return { state: 'none' };
        const words = input.words.toLowerCase();
        const named = events.flatMap(event => {
          if (event === null || typeof event !== 'object') return [];
          const id = (event as Record<string, unknown>)['id'];
          const summary = (event as Record<string, unknown>)['summary'];
          if (typeof id !== 'string' || typeof summary !== 'string') return [];
          return summary.trim() !== '' && words.includes(summary.trim().toLowerCase()) ? [id] : [];
        });
        if (named.length === 1) return { state: 'found', eventId: named[0]! };
        return named.length === 0 ? { state: 'none' } : { state: 'ambiguous', candidates: named };
      } catch { return { state: 'none' }; }
    },
  };
}
