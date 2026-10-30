import type { EvalCase } from './types.js';
import type { FakeWorld, ToolMap } from './world.js';

export interface PlannedCall { tool: string; args: Record<string, unknown> }
export interface TurnPlan {
  calls: readonly PlannedCall[];
  /** What Naya says back to the owner during the turn. */
  reply: string;
  /** What she says when an alarm reaches its fire time in the same case. */
  ring?: string;
}

export interface TurnProvider {
  readonly mode: 'scripted' | 'live';
  plan(input: { case: EvalCase; world: FakeWorld; toolMap: ToolMap }): Promise<TurnPlan>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/**
 * The scripted provider: it replays the case's required calls and composes a spoken line out of the facts the
 * fake world actually holds. It costs nothing and proves the harness, the gates and the scorer; it says
 * nothing about model quality, which is what `--live` is for.
 */
export function scriptedProvider(): TurnProvider {
  return {
    mode: 'scripted',
    async plan({ case: evalCase, world, toolMap }) {
      const calls: PlannedCall[] = [];
      for (const expectation of evalCase.expected_tools) {
        // Only a capability the fake world can actually serve is called; a planned one is why the case is red.
        if (!toolMap[expectation.tool] || !world.available(expectation.tool)) continue;
        calls.push({ tool: expectation.tool, args: expectation.args ?? {} });
      }
      return { calls, ...scriptedSpeech(evalCase, world) };
    },
  };
}

/**
 * The tokens a case requires. An entry may describe where its token belongs ("reminder text 'go to bed'
 * before any overview"), so the quoted fragments are the tokens; an ORDER entry lists its tokens.
 */
export function requiredTokens(evalCase: { spoken_must: readonly string[] }): string[] {
  const tokens: string[] = [];
  for (const entry of evalCase.spoken_must.map(text)) {
    if (!entry) continue;
    if (entry.startsWith('ORDER:')) { tokens.push(...entry.slice('ORDER:'.length).split(',').map(token => token.trim()).filter(Boolean)); continue; }
    const quoted = [...entry.matchAll(/'([^']+)'/g)].map(match => match[1]).filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (quoted.length > 0) tokens.push(...quoted);
    else tokens.push(entry);
  }
  return tokens;
}

function scriptedSpeech(evalCase: EvalCase, world: FakeWorld): { reply: string; ring?: string } {
  const owner = text(world.seed.owner);
  const parts: string[] = [];
  if (owner) parts.push(owner);
  const draftClaim = world.store.drafts.length + world.store.chatDrafts.length > 0;
  if (draftClaim) parts.push('the draft is saved and unsent');
  for (const event of world.store.newEvents) if (event.start) parts.push(`added for ${text(event.start)}`);
  for (const meeting of array(world.seed.calendar) as readonly { title?: string; start?: string; end?: string }[]) {
    const start = Date.parse(text(meeting.start));
    if (Number.isFinite(start) && start >= world.t0 && start <= world.t0 + 7 * 86_400_000 && meeting.title) parts.push(meeting.title);
  }
  for (const token of requiredTokens(evalCase)) parts.push(token);
  const line = parts.filter(Boolean).join('. ');
  // The same composed line answers the ask and, at fire time, is the wake utterance: the sink records it.
  return { reply: line, ring: line };
}

/** The deliberately broken plans the self-test needs, so a scorer regression cannot pass silently. */
export const brokenPlans = {
  /** Speaks a saved draft with nothing in the store. */
  draftWithoutObject(line: string, calls: readonly PlannedCall[]): TurnPlan {
    return { calls: calls.filter(call => !/draft/i.test(call.tool)), reply: `${line} the draft is saved and unsent` };
  },
  /** Speaks a meeting that already finished as if it were ahead. */
  finishedMeetingAsUpcoming(line: string, calls: readonly PlannedCall[], title: string): TurnPlan {
    return { calls, reply: `${line} ${title} is coming up later today` };
  },
  /** Sets an alarm in a turn that never asked for one. */
  alarmFromNonAlarmTurn(calls: readonly PlannedCall[], args: Record<string, unknown>): TurnPlan {
    return { calls: [...calls, { tool: 'set_alarm', args }], reply: 'I set an alarm' };
  },
} satisfies Record<string, unknown>;
