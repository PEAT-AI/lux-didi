// The side-panel layout state machine (issue #282). Two side panels around an always-open voice view:
// the left panel is the program menu, the right panel is the chat lane. Pure helpers: no DOM, no timers,
// so the two-state collapse, the drag clamp and the storage fallback are testable headless.
//
// A panel has exactly two states: open (at least its minimum readable width) or collapsed (zero width,
// nothing rendered). It is never left between the two: a drag below the minimum collapses instead.

export type PanelId = 'left' | 'right';
export type PanelState = 'open' | 'collapsed';
export type RouteId = 'today' | 'memory' | 'settings' | 'diagnostics';

/** Below this width the header compacts; the panels keep the same two states at any width. */
export const NARROW_BREAKPOINT = 880;

/** The minimum readable width of each panel while open. A drag below this collapses the panel. */
export const LEFT_MIN_PX = 200;
export const RIGHT_MIN_PX = 320;
/** The width a panel opens at when no previous width is known. */
export const LEFT_DEFAULT_PX = 240;
export const RIGHT_DEFAULT_PX = 360;
/** A drag can never widen a panel past this. */
export const PANEL_MAX_PX = 640;

export const PANEL_IDS: readonly PanelId[] = ['left', 'right'];
export const ROUTES: readonly RouteId[] = ['today', 'memory', 'settings', 'diagnostics'];

export interface LayoutState {
  left: PanelState;
  right: PanelState;
  /** The width an open panel returns to; preserved across a collapse. */
  leftWidth: number;
  rightWidth: number;
  narrow: boolean;
  sheet: RouteId | null;
}

export interface PanelControl {
  'aria-expanded': 'true' | 'false';
  'aria-controls': string;
  title: string;
  label: string;
}

const LABELS: Record<PanelId, string> = { left: 'program menu', right: 'chat' };
const KEYS: Record<PanelId, 'leftWidth' | 'rightWidth'> = { left: 'leftWidth', right: 'rightWidth' };

export function panelLabel(id: PanelId): string { return LABELS[id]; }
export function panelMin(id: PanelId): number { return id === 'left' ? LEFT_MIN_PX : RIGHT_MIN_PX; }
export function panelDefaultWidth(id: PanelId): number { return id === 'left' ? LEFT_DEFAULT_PX : RIGHT_DEFAULT_PX; }

/** Both side panels collapsed around a centred voice view: the launch state (#282). */
export function defaultLayout(narrow = false): LayoutState {
  return { left: 'collapsed', right: 'collapsed', leftWidth: LEFT_DEFAULT_PX, rightWidth: RIGHT_DEFAULT_PX, narrow, sheet: null };
}

export function isNarrow(width: number): boolean { return width < NARROW_BREAKPOINT; }

/** Fold a viewport width into the layout: only the narrow flag moves. */
export function withViewport(state: LayoutState, width: number): LayoutState {
  const narrow = isNarrow(width);
  return narrow === state.narrow ? state : { ...state, narrow };
}

export function panelOpen(state: LayoutState, id: PanelId): boolean { return state[id] === 'open'; }
export function panelWidth(state: LayoutState, id: PanelId): number { return state[KEYS[id]]; }

/** Clamp an open width into the readable band; an unusable number falls back to the default width. */
export function clampWidth(id: PanelId, width: number): number {
  const rounded = Math.round(width);
  if (!Number.isFinite(rounded)) return panelDefaultWidth(id);
  return Math.min(PANEL_MAX_PX, Math.max(panelMin(id), rounded));
}

export function setPanel(state: LayoutState, id: PanelId, next: PanelState): LayoutState {
  return state[id] === next ? state : { ...state, [id]: next };
}

export function togglePanel(state: LayoutState, id: PanelId): LayoutState {
  return setPanel(state, id, panelOpen(state, id) ? 'collapsed' : 'open');
}

/**
 * A divider drag. Below the minimum the panel collapses and keeps its previous width, so dragging back
 * out or clicking the control restores the previous width. At or above the minimum it opens at the
 * clamped width. Either way the panel never rests between the minimum and collapsed.
 */
export function dragPanel(state: LayoutState, id: PanelId, width: number): LayoutState {
  if (!Number.isFinite(width) || width < panelMin(id)) return setPanel(state, id, 'collapsed');
  return { ...state, [id]: 'open', [KEYS[id]]: clampWidth(id, width) };
}

/** The always-visible control for a panel: one slot per panel, in the same place in every state. */
export function panelControl(state: LayoutState, id: PanelId): PanelControl {
  const open = panelOpen(state, id);
  const label = panelLabel(id);
  const verb = open ? 'Hide' : 'Show';
  return {
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': `panel-${id}`,
    title: `${verb} ${label}`,
    label: `${verb} ${label}`,
  };
}

/** Cmd/Ctrl+1 toggles the left panel, Cmd/Ctrl+2 the right one. A bare digit does nothing. */
export function shortcutPanel(key: string, modifier: boolean): PanelId | null {
  if (!modifier) return null;
  if (key === '1') return 'left';
  if (key === '2') return 'right';
  return null;
}

export function openSheet(state: LayoutState, route: RouteId): LayoutState { return { ...state, sheet: route }; }
export function closeSheet(state: LayoutState): LayoutState { return state.sheet === null ? state : { ...state, sheet: null }; }

// --- Persistence. The same try/catch shape as theme.ts: any storage failure or unusable payload falls
// back to the default layout, never to a broken one. ---

export const LAYOUT_KEY = 'didi-layout';

/** The minimal storage surface this module needs (satisfied by window.localStorage). */
export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function serializeLayout(state: LayoutState): string {
  return JSON.stringify({ left: state.left, right: state.right, leftWidth: state.leftWidth, rightWidth: state.rightWidth });
}

function validWidth(id: PanelId, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < panelMin(id) || rounded > PANEL_MAX_PX ? null : rounded;
}

/** Parse a stored payload; anything unrecognised returns the default layout. */
export function parseLayout(raw: unknown, narrow = false): LayoutState {
  if (typeof raw !== 'string') return defaultLayout(narrow);
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return defaultLayout(narrow); }
  if (typeof data !== 'object' || data === null) return defaultLayout(narrow);
  const record = data as Record<string, unknown>;
  if (record.left !== 'open' && record.left !== 'collapsed') return defaultLayout(narrow);
  if (record.right !== 'open' && record.right !== 'collapsed') return defaultLayout(narrow);
  const leftWidth = validWidth('left', record.leftWidth);
  const rightWidth = validWidth('right', record.rightWidth);
  if (leftWidth === null || rightWidth === null) return defaultLayout(narrow);
  return { left: record.left, right: record.right, leftWidth, rightWidth, narrow, sheet: null };
}

export function loadLayout(storage: PanelStorage | undefined, narrow = false): LayoutState {
  try {
    return parseLayout(storage?.getItem(LAYOUT_KEY), narrow);
  } catch {
    return defaultLayout(narrow);
  }
}

/** Persist the layout; a storage failure must not break the running page. */
export function saveLayout(storage: PanelStorage | undefined, state: LayoutState): void {
  try {
    storage?.setItem(LAYOUT_KEY, serializeLayout(state));
  } catch {
    // Storage unavailable: the session keeps the applied layout and the default stands on reload.
  }
}
