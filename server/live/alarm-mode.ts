import type { AlarmSessionSetup } from './types.js';

export const ALARM_MODE_MARKER = '[alarm mode]';

/** A series occurrence also carries the rule its host note must state. */
export type SeriesAlarmSetup = AlarmSessionSetup & { readonly series?: string };
