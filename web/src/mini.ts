/** MINI2: the pill, the MINI surface at 64x26 pt.
 *
 * Reuses the authorized Canvas renderer (orb.ts) at 18 pt, so there is one
 * renderer and one voice surface. The mini route is the same built page with
 * `?view=mini`; main.ts renders this markup instead of the full window shell.
 * The pill carries no text at all: an orb and a 5-bar level meter.
 */
import type { VoiceState } from './orb.ts';
import type { LiveActivity } from './live-view.ts';

export type MiniState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'connecting' | 'tool' | 'error';

/** The compact route is a query on the one built page, so the loopback static
 * handler and the same compiled assets serve it unchanged. */
export function isMiniRoute(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'mini';
}

/** The one glance state for the pill: listening, thinking, speaking, muted,
 * connecting, a running tool, or error. Muted and connecting are their own
 * states so the pill can dim or spin instead of borrowing the thinking shimmer,
 * and tool activity outranks the quieter voice states so a long call stays
 * visible under the orb. */
export function miniState(voice: VoiceState, activity: LiveActivity | undefined, muted = false): MiniState {
  if (voice === 'ERROR' || voice === 'DISCONNECTED' || voice === 'INTERRUPTED') return 'error';
  if (activity?.kind === 'tools' || activity?.kind === 'failed') return 'tool';
  // The live projection carries mute beside the voice state, not inside it.
  if (muted) return 'muted';
  if (voice === 'CONNECTING') return 'connecting';
  if (voice === 'SPEAKING') return 'speaking';
  if (voice === 'LISTENING') return 'listening';
  if (voice === 'PROCESSING' || activity?.kind === 'thinking') return 'thinking';
  return 'idle';
}

/** The pill's markup: the orb canvas and five level bars, and no text. The
 * caption parameter is kept so the caller needs no change; the pill ignores it,
 * because the decision file says no text in the pill. */
export function miniMarkup(state: MiniState, _caption = ''): string {
  const bars = Array.from({ length: 5 }, (_, index) => `<i data-bar="${index + 1}"></i>`).join('');
  return `<section class="mini-stage mini-pill" data-mini-state="${state}" aria-label="Naya">`
    + `<div class="presence-glow" aria-hidden="true"></div>`
    + `<canvas id="didi-orb" width="72" height="72" aria-hidden="true"></canvas>`
    + `<div class="mini-level" aria-hidden="true">${bars}</div></section>`;
}

/** The FULL window's one mode control (#311): a visible button with an
 * accessible label that asks the native app for the mini orb. Only the native
 * app can move a surface, so a browser shell renders no button at all. */
export function miniModeButtonMarkup(native: boolean): string {
  return native
    ? '<button id="mini-mode" class="quiet mini-mode" aria-label="Show the mini orb" title="Mini orb (Control-Option-Space)">mini</button>'
    : '';
}
