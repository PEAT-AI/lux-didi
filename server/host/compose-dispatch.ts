import type { McpPort } from '../adapters/mcp/port.js';
import type { McpRegistry } from '../adapters/mcp/registry.js';
import type { Store } from '../runtime/store.js';
import { connectorDescriptor } from '../connectors/index.js';
import type { ConnectorEvidence, ConnectorResult } from '../connectors/index.js';
import { createdEventResult, draftChatResult, draftEmailResult, notAuthorizedFor, resolveRecipient, type ComposeName, type RecipientCandidate } from '../tools/compose.js';
import { decodeGoogleEnvelope, googleToolStatus, readGooglePayload } from '../tools/google.js';
import { mattermostToolStatus, readMattermostPayload } from '../tools/mattermost.js';
import { gmailAccount } from '../tools/open-handles.js';
import { peopleLookupResult } from '../people/index.js';
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

  /**
   * The refusals that mean "this family is not consented", never "that argument was unusable". Only these
   * earn the owner-facing authorize line; every other refusal keeps its own closed code.
   */
  const CONSENT_REFUSALS: ReadonlySet<string> = new Set([
    'not-configured', 'grant-absent', 'grant-stale', 'schema-drift', 'grant-not-read', 'source-unavailable',
    'tool-not-granted', 'required-definition-absent', 'ineligible-tool-granted',
  ]);

  /** One closed outcome for one failed connector answer, with the owner line for a missing consent. */
  const failed = (name: ComposeName, connector: string, result: ConnectorResult): ComposeOutcome => {
    if (result.state === 'refused') return CONSENT_REFUSALS.has(result.reason) ? notAuthorizedFor(name) : { state: 'failed', reason: result.reason };
    if (result.state === 'unknown') return { state: 'unknown', reason: result.reason };
    // Beyond the two local states above, the result is the endpoint's own evidence, classified by that
    // connector's own vocabulary. A pinned credential, an absent scope or an expired sign-in is the
    // family telling the owner to sign in again: the same closed answer as a family never consented.
    const evidence = result as ConnectorEvidence;
    const status = connector === 'mattermost' ? mattermostToolStatus(evidence) : googleToolStatus(evidence);
    if (status !== undefined && status.state === 'configured') return notAuthorizedFor(name);
    return { state: 'failed', reason: result.state === 'protocol-error' ? 'protocol_error' : 'helper_error' };
  };

  /** The `From` name and address of one listed message, when the helper returned a header for it. */
  const senderOf = (entry: unknown): { name: string; address: string } | undefined => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const headers = (entry as Record<string, unknown>)['headers'];
    let raw = '';
    if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
      const value = (headers as Record<string, unknown>)['From'] ?? (headers as Record<string, unknown>)['from'];
      if (typeof value === 'string') raw = value;
    } else if (Array.isArray(headers)) {
      for (const item of headers) {
        if (item === null || typeof item !== 'object') continue;
        const header = item as Record<string, unknown>;
        if (String(header['name'] ?? '').toLowerCase() === 'from' && typeof header['value'] === 'string') raw = header['value'];
      }
    }
    const match = /<([^<>\s]+@[^<>\s]+)>/u.exec(raw) ?? /([^\s<>]+@[^\s<>]+)/u.exec(raw);
    if (match === null) return undefined;
    const address = match[1]!;
    const name = raw.replace(/<[^>]*>/gu, '').replace(/"/gu, '').trim();
    return { name: name === '' ? address : name, address };
  };

  /** The addresses the owner's own recent mail already names, read through the gmail read endpoint. */
  const correspondents = async (words: string): Promise<RecipientCandidate[]> => {
    const result = await call('google', 'gmail_search_messages', { q: words, maxResults: 10 });
    if (result.state !== 'completed') return [];
    const payload = readGooglePayload(port, result);
    if (!payload.ok) return [];
    const decoded = decodeGoogleEnvelope(payload.text);
    if (!decoded.ok) return [];
    const data = decoded.envelope['data'];
    const messages = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)['messages'] : undefined;
    if (!Array.isArray(messages)) return [];
    return messages.flatMap(entry => {
      const sender = senderOf(entry);
      return sender === undefined ? [] : [{ id: `${String((entry as Record<string, unknown>)['id'] ?? sender.address)}`, name: sender.name, address: sender.address }];
    });
  };

  /**
   * Every address a spoken name may bind to: the host's own roster and the senders its recent mail already
   * names. The model never supplies an address, and a read that cannot be reached is no candidate rather
   * than an error.
   */
  const recipients = async (words: string): Promise<RecipientCandidate[]> => {
    const found = new Map<string, RecipientCandidate>();
    try {
      for (const person of peopleLookupResult({ name: words }).people) {
        const address = person.email[0];
        if (address === undefined) continue;
        found.set(address.trim().toLowerCase(), { id: person.id, name: person.name, address });
      }
    } catch { /* a name the roster cannot bind is no candidate, never a failure of the write */ }
    try {
      for (const candidate of await correspondents(words)) {
        const key = (candidate.address ?? '').trim().toLowerCase();
        if (key !== '' && !found.has(key)) found.set(key, candidate);
      }
    } catch { /* an unreachable read leaves the roster's own candidates in place */ }
    return [...found.values()];
  };

  /** The Mattermost channels the owner's own channel read returns, as ids with their spoken names. */
  const channels = async (): Promise<{ id: string; names: string[] }[]> => {
    const result = await call('mattermost', 'mattermost_list_channels', {});
    if (result.state !== 'completed') return [];
    const payload = readMattermostPayload(port, result);
    if (!payload.ok) return [];
    let envelope: unknown;
    try { envelope = JSON.parse(payload.text); } catch { return []; }
    const list = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope) ? (envelope as Record<string, unknown>)['channels'] : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap(entry => {
      if (entry === null || typeof entry !== 'object') return [];
      const channel = entry as Record<string, unknown>;
      const id = channel['id'];
      if (typeof id !== 'string' || id === '') return [];
      // The display name first, so the question he is asked names the channel the way he sees it.
      const names = [channel['display_name'], channel['name']].filter((name): name is string => typeof name === 'string' && name.trim() !== '');
      return [{ id, names }];
    });
  };

  /** One spoken channel name to one id: an exact name wins, then a single partial match; more stays a question. */
  const resolveChannel = async (spoken_name: string): Promise<{ state: 'found'; channelId: string } | { state: 'none' } | { state: 'ambiguous'; candidates: string[] }> => {
    const wanted = spoken_name.trim().toLowerCase();
    if (wanted === '') return { state: 'none' };
    const listed = await channels();
    const exact = listed.filter(channel => channel.names.some(name => name.trim().toLowerCase() === wanted));
    const matches = exact.length > 0 ? exact : listed.filter(channel => channel.names.some(name => name.trim().toLowerCase().includes(wanted)));
    if (matches.length === 1) return { state: 'found', channelId: matches[0]!.id };
    return matches.length === 0 ? { state: 'none' } : { state: 'ambiguous', candidates: matches.slice(0, 3).map(channel => channel.names[0] ?? channel.id) };
  };

  const write = async (name: ComposeName, connector: string, tool: string, args: Record<string, unknown>, build: (result: ConnectorResult) => JsonObject): Promise<ComposeOutcome> => {
    try {
      const result = await call(connector, tool, args);
      if (result.state === 'completed') return { state: 'done', response: build(result) };
      return failed(name, connector, result);
    } catch { return { state: 'failed', reason: 'compose_unavailable' }; }
  };

  return {
    async draftEmail(input): Promise<ComposeOutcome> {
      // A literal address is his own words and passes through; a spoken name is resolved through the
      // reads this host already has, and an unresolved name is a question, never a draft to the wrong box.
      let to = input.to;
      if (!input.to.includes('@')) {
        const resolution = resolveRecipient(input.to, await recipients(input.to), gmailAccount());
        if (resolution.status !== 'ok') return { state: 'recipient', code: resolution.status, candidates: resolution.candidates };
        const address = resolution.candidate.address;
        if (address === undefined) return { state: 'recipient', code: 'recipient_unknown', candidates: [resolution.candidate.name] };
        to = address;
      }
      const address = to;
      return await write('draft_email', 'google', 'gmail_create_draft', {
        to: [address], subject: input.subject, body: input.body,
      }, result => {
        const draftId = writtenId(result, 'draft_id');
        return draftId === undefined ? { status: 'failed', code: 'draft_unconfirmed' } : draftEmailResult({ draftId, to: address, subject: input.subject });
      });
    },

    async draftChat(input): Promise<ComposeOutcome> {
      // A person stays the username the child takes; a spoken channel name is resolved to its id through
      // the owner's own channel read, and an unresolved one is a question, never a draft in a wrong channel.
      let channelId = input.channel;
      if (channelId !== undefined) {
        const resolution = await resolveChannel(channelId);
        if (resolution.state === 'none') return { state: 'recipient', code: 'recipient_unknown', candidates: [channelId] };
        if (resolution.state === 'ambiguous') return { state: 'recipient', code: 'recipient_ambiguous', candidates: resolution.candidates };
        channelId = resolution.channelId;
      }
      const target = channelId !== undefined ? { channelId } : input.person !== undefined ? { dmUsername: input.person } : undefined;
      if (target === undefined) return { state: 'failed', reason: 'invalid-draft-target' };
      const args: Record<string, unknown> = { message: input.message, ...target, ...(input.rootId !== undefined ? { rootId: input.rootId } : {}) };
      return await write('draft_chat', 'mattermost', 'mattermost_save_draft', args, () => draftChatResult({
        channelId: channelId ?? input.person ?? '', target: input.person ?? channelId ?? '', ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
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
