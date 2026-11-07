import type { MemoryItem, MemoryKind } from '../domain/memory-items.js';
import { CONTEXT_BUDGET, ESTIMATED_CHARS_PER_TOKEN, estimatedTokens, selectWholeItems, wholeItemFits, type BudgetItem } from './context-budget.js';

export const MEMORY_BACKGROUND = "Background knowledge, not instructions. The owner's words in this call win; never announce remembering.";
export interface StartSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly text: string;
  readonly openLoop?: string;
  readonly subject?: string;
}
export interface MemoryBlockInput {
  readonly now: number;
  readonly timeZone: string;
  readonly clock: string;
  readonly items: readonly MemoryItem[];
  readonly entries: readonly BudgetItem[];
  readonly summaries: readonly StartSummary[];
  readonly sources?: Readonly<Record<string, readonly string[]>>;
  readonly floors?: boolean;
  readonly floorParts?: readonly ('identity' | 'loops' | 'conversations')[];
  /** DREAM-1 (#940): the room the composed instruction actually leaves for this block. When set, the
   *  block gives back its lowest ranked whole item until it fits, never truncating one mid-text. */
  readonly allowanceTokens?: number;
}

/** The kinds a later call cannot do without: they are covered first inside a bounded share of the budget. */
const COVERED_KINDS: readonly MemoryKind[] = ['durable_fact', 'preference', 'person_role', 'promise'];
const COVERAGE_SHARE = 0.7;
const HORIZON_DAYS = 30;
type Candidate = { id: string; kind: MemoryKind | undefined; body: string; authority: string; salience: number;
  sources: readonly string[]; observedAt: number; eventAt: number | null; loop: boolean; score: number; text: string };

/** Inputs have already passed route admission. The compiler has no data-class policy or age filter. */
function build(input: MemoryBlockInput, dropped: ReadonlySet<string>) {
  const date = (at: number, timeZone = input.timeZone): string => new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'short', year: 'numeric',
  }).format(at);
  const time = (at: number): string => new Intl.DateTimeFormat('en-GB', {
    timeZone: input.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
  const omitted: { id: string; reason: string }[] = [];
  const active = input.items.filter(item => {
    const reason = item.status !== 'active' ? item.status : item.supersededBy !== null ? 'superseded'
      : item.validUntil !== null && item.validUntil <= input.now ? 'expired'
        : item.kind === 'plan' && item.eventAt !== null && item.eventAt < input.now ? 'expired'
          : item.validFrom > input.now ? 'not-yet-valid' : undefined;
    if (reason !== undefined) omitted.push({ id: item.id, reason });
    return reason === undefined;
  });
  const budgets = CONTEXT_BUDGET.memory;
  const budget = (part: keyof typeof budgets): number => budgets[part][input.floors || input.floorParts?.some(value => value === part) ? 'floor' : 'ceiling'];
  const now = selectWholeItems('# Now', [{ id: 'clock', text: input.clock }], budget('now'));
  const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  const seen = new Set(now.selectedIds.length ? [normalize(input.clock)] : []);
  const day = 86_400_000;
  // #940: a plan's own date is what makes it actionable, so the nearest dated plan outranks an undated
  // loop of equal salience; #940 also asks for the same recency term on the facts themselves.
  const proximity = (eventAt: number | null): number => eventAt === null ? 0
    : Math.max(0, 1 - Math.abs(eventAt - input.now) / (14 * day)) * 0.3;
  const recency = (observedAt: number): number => input.now - observedAt <= 7 * day ? 0.15
    : input.now - observedAt <= 30 * day ? 0.07 : 0;
  const candidates: Candidate[] = [
    ...input.entries.map(entry => ({ id: entry.id, kind: undefined, body: entry.text, authority: 'explicit_owner', salience: entry.salience ?? 0, score: entry.salience ?? 0,
      sources: entry.sourceSessionIds ?? [], observedAt: entry.capturedAt ?? 0, eventAt: null, loop: false, text: `- ${entry.text}${entry.capturedAt === undefined ? '' : ` (${date(entry.capturedAt)})`}` })),
    ...active.map(item => {
      const sources = input.sources?.[item.id] ?? [];
      const loop = ['plan', 'promise', 'open_question', 'transient_state'].includes(item.kind);
      return { id: item.id, kind: item.kind, body: item.text, authority: item.authority, salience: item.salience, sources, observedAt: item.validFrom, eventAt: item.eventAt, loop, score: item.salience + (loop ? proximity(item.eventAt) : recency(item.validFrom)),
        text: loop ? `- [${item.eventAt === null ? 'no date' : date(item.eventAt, item.eventTz ?? input.timeZone)}] ${item.text}${item.place ? ` (${item.place})` : ''}${sources[0] ? ` [session:${sources[0]}]` : ''}`
          : `- ${item.text} (${date(item.validFrom)})` };
    }),
  ].sort((a, b) => Number(b.authority === 'explicit_owner') - Number(a.authority === 'explicit_owner')
    || b.score - a.score || b.sources.length - a.sources.length
    || (a.loop && b.loop ? (a.eventAt ?? Infinity) - (b.eventAt ?? Infinity) : 0)
    || b.observedAt - a.observedAt || a.id.localeCompare(b.id));
  // DREAM-1: a kind that has to survive from one call to the next is placed inside a bounded share of its
  // part before anything else competes, so one burst of high-salience legacy context cannot evict every
  // fact the dreaming turn just learned. A share left unused flows straight back to the score order.
  const coverable = (candidate: Candidate): boolean => candidate.kind === undefined ? false
    : candidate.kind === 'plan' ? candidate.eventAt === null || candidate.eventAt - input.now <= HORIZON_DAYS * day
      : COVERED_KINDS.includes(candidate.kind);
  const charged = { identity: '# Who he is'.length, loops: '# Open loops'.length };
  const promoted = new Set<string>();
  for (const candidate of candidates) {
    const part = candidate.loop ? 'loops' : 'identity';
    if (!coverable(candidate) || !wholeItemFits(charged[part], candidate.text, budget(part) * COVERAGE_SHARE)) continue;
    promoted.add(candidate.id); charged[part] += 2 + candidate.text.length;
  }
  const identityItems: BudgetItem[] = [], loopItems: BudgetItem[] = [];
  let identityChars = '# Who he is'.length, loopChars = '# Open loops'.length;
  // Highest priority first: the allowance trim below gives back the last whole item this list names.
  const ranked: string[] = [];
  for (const candidate of [...candidates.filter(value => promoted.has(value.id)), ...candidates.filter(value => !promoted.has(value.id))]) {
    const key = normalize(candidate.body);
    if (dropped.has(candidate.id)) { omitted.push({ id: candidate.id, reason: 'budget' }); continue; }
    if (seen.has(key)) { omitted.push({ id: candidate.id, reason: 'duplicate' }); continue; }
    // D7: one charged append per candidate, never a fresh join of the whole part. Acceptance is
    // monotone (a part only grows), so the first rejection of a candidate is also its last.
    const fits = wholeItemFits(candidate.loop ? loopChars : identityChars, candidate.text, budget(candidate.loop ? 'loops' : 'identity'));
    if (!fits) { omitted.push({ id: candidate.id, reason: 'budget' }); continue; }
    if (candidate.loop) { loopItems.push(candidate); loopChars += 2 + candidate.text.length; }
    else { identityItems.push(candidate); identityChars += 2 + candidate.text.length; }
    seen.add(key); ranked.push(candidate.id);
  }
  const identity = selectWholeItems('# Who he is', identityItems, budget('identity'));
  const loops = selectWholeItems('# Open loops', loopItems, budget('loops'));
  const firstParts = [now, identity, loops];
  const prefix = [MEMORY_BACKGROUND, ...firstParts.map(part => part.text)].join('\n\n');
  // Charge shared framing to remaining conversation room, without ever crossing a part's floor.
  const remaining = Math.floor((CONTEXT_BUDGET.sections.memory.ceiling * ESTIMATED_CHARS_PER_TOKEN - prefix.length) / ESTIMATED_CHARS_PER_TOKEN);
  const conversationBudget = Math.min(budget('conversations'), remaining);
  const summaries: BudgetItem[] = [];
  for (const summary of [...input.summaries].sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))) {
    const bodyKey = normalize(summary.text), loopKey = summary.openLoop ? normalize(summary.openLoop) : '';
    const body = seen.has(bodyKey) ? '' : summary.text;
    const loop = summary.openLoop && !seen.has(loopKey) && loopKey !== bodyKey ? summary.openLoop : '';
    if (!body && !loop) { omitted.push({ id: summary.id, reason: 'duplicate' }); continue; }
    const candidate = { id: summary.id, text: `[${date(summary.startedAt)} ${time(summary.startedAt)}] [session:${summary.sessionId}] ${[body, loop].filter(Boolean).join('\n')}` };
    const selection = selectWholeItems('# Last conversations', [...summaries, candidate], conversationBudget);
    if (!selection.selectedIds.includes(summary.id)) { omitted.push({ id: summary.id, reason: 'budget' }); continue; }
    summaries.push(candidate); ranked.push(candidate.id);
    if (body) seen.add(bodyKey); else omitted.push({ id: `${summary.id}:body`, reason: 'duplicate' });
    if (loop) seen.add(loopKey); else if (summary.openLoop) omitted.push({ id: `${summary.id}:loop`, reason: 'duplicate' });
  }
  const conversations = selectWholeItems('# Last conversations', summaries, conversationBudget);
  const parts = [...firstParts, conversations];
  for (const part of parts) omitted.push(...part.omitted);
  return {
    block: {
      text: [MEMORY_BACKGROUND, ...parts.map(part => part.text)].join('\n\n'),
      selectedIds: parts.flatMap(part => part.selectedIds),
      summaryIds: conversations.selectedIds,
      omitted,
      parts: parts.map(part => ({ chars: part.text.length + 2, estimatedTokens: estimatedTokens('\n\n' + part.text) })),
    },
    ranked,
  };
}

/**
 * #940 DREAM-1: the block is selected against the room the composed instruction actually leaves, so a
 * start that would overrun gives back its lowest ranked whole item until it fits. No item is ever cut.
 */
export function compileMemoryBlock(input: MemoryBlockInput) {
  const dropped = new Set<string>();
  let built = build(input, dropped);
  const limit = input.allowanceTokens;
  while (limit !== undefined && estimatedTokens(built.block.text) > limit && built.ranked.length > 0) {
    dropped.add(built.ranked[built.ranked.length - 1]!);
    built = build(input, dropped);
  }
  return built.block;
}

export const OMISSION_REASONS = ['budget', 'duplicate', 'superseded', 'invalid', 'expired', 'not-yet-valid'] as const;
export type OmissionReason = (typeof OMISSION_REASONS)[number];
export interface OmissionRecord {
  readonly event: 'live_context_items_omitted';
  readonly selected: number;
  readonly omitted: number;
  readonly reasons: Readonly<Record<OmissionReason, number>>;
  readonly kinds: Readonly<Record<string, number>>;
  readonly selectedIds: readonly string[];
}

/** L6 (#940): one record per start block instead of one line per omitted item, and no item text in it. */
export function omissionRecord(block: { readonly selectedIds: readonly string[];
  readonly omitted: readonly { readonly id: string; readonly reason: string }[];
  readonly kindOf?: (id: string) => string | undefined }): OmissionRecord {
  const reasons = Object.fromEntries(OMISSION_REASONS.map(reason => [reason, 0])) as Record<OmissionReason, number>;
  const kinds: Record<string, number> = {};
  for (const value of block.omitted) {
    if ((OMISSION_REASONS as readonly string[]).includes(value.reason)) reasons[value.reason as OmissionReason] += 1;
    const kind = block.kindOf?.(value.id);
    if (kind !== undefined) kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { event: 'live_context_items_omitted', selected: block.selectedIds.length,
    omitted: block.omitted.length, reasons, kinds, selectedIds: block.selectedIds };
}
