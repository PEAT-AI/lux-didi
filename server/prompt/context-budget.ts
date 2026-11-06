/** Startup accounting is deliberately conservative. These are estimated tokens, not model tokens. */
export const ESTIMATED_CHARS_PER_TOKEN = 3.2;
export const estimatedTokens = (text: string): number => Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

/** Fixed is an accounting reservation, never permission to clip fixed prompt text. */
export const CONTEXT_BUDGET = {
  target: 9_000,
  hard: 14_000,
  sections: {
    fixed: { ceiling: 4_600, floor: 4_600 },
    lore: { ceiling: 1_000, floor: 1_000 },
    runtime: { ceiling: 150, floor: 150 },
    calendar: { ceiling: 300, floor: 150 },
    people: { ceiling: 500, floor: 200 },
    memory: { ceiling: 2_000, floor: 1_500 },
    pickup: { ceiling: 200, floor: 200 },
    openings: { ceiling: 250, floor: 100 },
  },
  memory: {
    now: { ceiling: 100, floor: 100 },
    identity: { ceiling: 600, floor: 400 },
    loops: { ceiling: 500, floor: 300 },
    conversations: { ceiling: 800, floor: 700 },
  },
} as const;

export interface BudgetItem { readonly id: string; readonly text: string; readonly capturedAt?: number; readonly salience?: number; readonly sourceSessionIds?: readonly string[] }
export interface BudgetSelection {
  readonly text: string;
  readonly selectedIds: readonly string[];
  readonly omitted: readonly { readonly id: string; readonly reason: 'budget' }[];
}

/** Caller supplies ranked whole items. Headings and separators consume the same budget as content. */
export function selectWholeItems(heading: string, items: readonly BudgetItem[], budget: number): BudgetSelection {
  const selected: BudgetItem[] = [];
  const omitted: { id: string; reason: 'budget' }[] = [];
  let text = heading;
  for (const item of items) {
    const candidate = [text, item.text].filter(Boolean).join('\n\n');
    if (estimatedTokens('\n\n' + candidate) > budget) omitted.push({ id: item.id, reason: 'budget' });
    else { text = candidate; selected.push(item); }
  }
  return { text, selectedIds: selected.map(item => item.id), omitted };
}
