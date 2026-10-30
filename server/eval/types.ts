/** The eval harness's own vocabulary. Cases come from the synthetic catalogue and carry no private content. */

export interface Contact { id: string; name: string; email?: string; language?: string }
export interface Meeting { id: string; title: string; start: string; end: string; attendees?: readonly string[]; body?: string; note?: string }
export interface MailThread { id: string; from: string; subject: string; body: string; unread?: boolean; received?: string }
export interface ChatPost { id: string; channel_id?: string; channel_name?: string; author?: string; text: string; needs_attention?: boolean }
export interface DriveFile { id: string; title: string; attendee_ids?: readonly string[]; body?: string }
export interface MeetingStub { id: string; expand_to: string }
export interface Transcript { id: string; title: string; attendee_ids?: readonly string[]; date?: string; body: string }
export interface Company { domain: string; name: string; fact?: string }
export interface SeededState {
  owner?: string;
  network?: string;
  contacts?: readonly Contact[];
  calendar?: readonly Meeting[];
  mail?: readonly MailThread[];
  chat?: readonly ChatPost[];
  drafts?: readonly unknown[];
  chat_drafts?: readonly unknown[];
  posts?: readonly unknown[];
  alarms?: readonly unknown[];
  memory?: readonly unknown[];
  tasks?: readonly unknown[];
  drive_files?: readonly DriveFile[];
  transcripts?: readonly Transcript[];
  lux_stubs?: readonly MeetingStub[];
  companies?: readonly Company[];
  mongoose?: Record<string, unknown>;
  trello?: readonly unknown[];
  [key: string]: unknown;
}

export interface ToolExpectation { tool: string; args?: Record<string, unknown>; count?: number }
export interface CaseSetup {
  clock_T0: string;
  timezone: string;
  seeded_state: SeededState;
  fixture_mode?: string;
  shape?: string;
  turn_protocol?: string;
}
export interface EvalCase {
  id: string;
  category: string;
  priority?: string;
  source?: string;
  public_ok: boolean;
  finals: readonly string[];
  setup: CaseSetup;
  expected_tools: readonly ToolExpectation[];
  expected_state: Record<string, unknown>;
  spoken_must: readonly string[];
  spoken_must_not: readonly string[];
  score?: Record<string, unknown>;
  red_today: boolean;
  red_reason?: string;
  cost_class?: string;
}

export interface RecordedCall { tool: string; didi: string; args: Record<string, unknown>; at: number; seq: number }

export type Outcome = 'PASS' | 'FAIL' | 'EXPECTED_RED';

export interface CaseOutcome {
  id: string;
  category: string;
  outcome: Outcome;
  reasons: readonly string[];
  redReason?: string;
  toolCalls: readonly string[];
  spoken: string;
  /** Where each spoken frame was routed. A scripted run must never name anything but `recording-only`. */
  spokenSinks: readonly string[];
}

export interface SuiteSummary {
  total: number;
  pass: number;
  fail: number;
  expectedRed: number;
  byCategory: Record<string, { PASS: number; FAIL: number; EXPECTED_RED: number }>;
  failures: readonly CaseOutcome[];
  /** Every spoken frame's sink across the run, so an audio leak would show up as a non-recording value. */
  spokenSinks: readonly string[];
}
