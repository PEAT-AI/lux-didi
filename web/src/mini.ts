/** Compact orb-only view for the floating mini orb panel.
 *
 * Reuses the authorized Canvas renderer (orb.ts) and the live level feed
 * (window.didiOrbLevel), so there is one renderer and one voice surface. The
 * mini route is the same built page with `?view=mini`; main.ts renders this
 * markup instead of the full window shell.
 */
import type { VoiceState } from './orb.ts';
import type { LiveActivity } from './live-view.ts';

export type MiniState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'tool' | 'error';

/** The compact route is a query on the one built page, so the loopback static
 * handler and the same compiled assets serve it unchanged. */
export function isMiniRoute(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'mini';
}

/** The one glance state for the mini orb: listening, thinking, speaking, a
 * running tool, or error. Tool activity outranks the quieter voice states so a
 * long call stays visible under the orb. */
export function miniState(voice: VoiceState, activity: LiveActivity | undefined): MiniState {
  if (voice === 'ERROR' || voice === 'DISCONNECTED' || voice === 'INTERRUPTED') return 'error';
  if (activity?.kind === 'tools' || activity?.kind === 'failed') return 'tool';
  if (voice === 'SPEAKING') return 'speaking';
  if (voice === 'LISTENING') return 'listening';
  if (voice === 'CONNECTING' || voice === 'PROCESSING' || activity?.kind === 'thinking') return 'thinking';
  return 'idle';
}

/** Orb-only stage: no transcript, no tabs, no text field. The caption is the
 * shared voice-landing caption (state line plus one tool phrase) so both views
 * agree and a tool line is never a second renderer. */
export function miniMarkup(state: MiniState, caption: string): string {
  const glow = state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'tool';
  return `<section class="orb-stage mini-stage" data-mini-state="${state}" aria-label="Naya voice">`
    + `<div class="presence-glow${glow ? ' visible' : ''}" aria-hidden="true"></div>`
    + `<canvas id="didi-orb" width="440" height="440" aria-hidden="true"></canvas>`
    + `<div class="orb-caption">${caption}</div></section>`;
}

/** The FULL window's one mode control (#311): a visible button with an
 * accessible label that asks the native app for the mini orb. Only the native
 * app can move a surface, so a browser shell renders no button at all. */
export function miniModeButtonMarkup(native: boolean): string {
  return native
    ? '<button id="mini-mode" class="quiet mini-mode" aria-label="Show the mini orb" title="Mini orb (Control-Option-Space)">mini</button>'
    : '';
}
