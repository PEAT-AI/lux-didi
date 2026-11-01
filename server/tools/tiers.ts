/**
 * C-PERMTIER (10.7.2): one closed table decides how a live write is admitted, so no tool carries its
 * own phrase grammar. Free tools are low-harm and reversible: they run on the model's call while the
 * owner's live call is open. Everything else is guarded, which means a future send tool is guarded
 * without any code change here.
 */
import { OPEN_TOOL_NAMES } from './open.js';

export type RiskTier = 'free' | 'guarded';

/** Low-harm reversible writes, and the reads they are paired with. Nothing here sends to a person. */
const FREE_NAMES: ReadonlySet<string> = new Set<string>([
  'set_alarm', 'cancel_alarm', 'snooze_alarm', 'list_alarms',
  'create_event', 'draft_email', 'draft_chat',
  'remember_note', 'stage_lux_note', 'save_to_vault', 'trello_write',
]);

/** A guard stays only for sending to other humans and irreversible deletion. */
export const tierOf = (name: string): RiskTier =>
  FREE_NAMES.has(name) || OPEN_TOOL_NAMES.has(name) ? 'free' : 'guarded';

/**
 * The sources whose text is third-party rather than the owner's own: mail bodies, chat messages and
 * web pages. Reading his own calendar, alarms, notes, vault and Trello is not an exposure.
 */
const EXTERNAL_TEXT_SOURCES: ReadonlySet<string> = new Set<string>(['mail', 'chat', 'web', 'research']);

export const advancesExposure = (source: string | undefined): boolean =>
  source !== undefined && EXTERNAL_TEXT_SOURCES.has(source);
