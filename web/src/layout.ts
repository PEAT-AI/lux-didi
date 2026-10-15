// The three-lane layout state machine (issue #255). Pure helpers: no DOM, no timers, so the collapse, narrow-switch
// and aria rules are testable headless and never drift from the rendered shell.
//
// Structure, left to right: icon rail (program menu) | Voice lane | Chat lane. The rail is never a content lane.
// At least one of Voice and Chat stays open. Below the narrow breakpoint the two lanes become a switcher.

export type RailState = 'collapsed' | 'expanded';
export type LaneId = 'voice' | 'chat';
export type LaneState = 'open' | 'collapsed';
export type RouteId = 'today' | 'memory' | 'settings' | 'diagnostics';

export interface LayoutState {
  /** The rail is always present; collapsed 80 px, expanded 220 px with labels. */
  rail: RailState;
  voice: LaneState;
  chat: LaneState;
  /** True below NARROW_BREAKPOINT, where Voice and Chat become a two-segment switcher. */
  narrow: boolean;
  /** The visible lane in the narrow switcher. */
  segment: LaneId;
  /** The open program-menu sheet, or null. Sheets sit below the header and never hide the live pill. */
  sheet: RouteId | null;
}

/** rail + two lane minimums + dividers; confirm by measurement. */
export const NARROW_BREAKPOINT = 880;
export const RAIL_COLLAPSED_PX = 80;
export const RAIL_EXPANDED_PX = 220;
export const LANE_STRIP_PX = 56;
export const VOICE_HEADER_PX = 96;
export const ORB_PX = 56;

export const LANE_IDS: readonly LaneId[] = ['voice', 'chat'];
export const ROUTES: readonly RouteId[] = ['today', 'memory', 'settings', 'diagnostics'];

/** Rob's default: rail collapsed, Voice and Chat open, no sheet. */
export function defaultLayout(narrow = false): LayoutState {
  return { rail: 'collapsed', voice: 'open', chat: 'open', narrow, segment: 'voice', sheet: null };
}

export function isNarrow(width: number): boolean {
  return width < NARROW_BREAKPOINT;
}

/** Fold a viewport width into the layout, keeping the segment on an open lane. */
export function withViewport(state: LayoutState, width: number): LayoutState {
  const narrow = isNarrow(width);
  if (narrow === state.narrow) return state;
  if (!narrow) return { ...state, narrow };
  const segment = state.segment;
  return { ...state, narrow, segment };
}

/** The other lane, the focus target when this one collapses. */
export function otherLane(lane: LaneId): LaneId {
  return lane === 'voice' ? 'chat' : 'voice';
}

export function laneOpen(state: LayoutState, lane: LaneId): boolean {
  return state[lane] === 'open';
}

/** Collapsing the last open lane is refused: it would leave no conversation open. */
export function canCollapseLane(state: LayoutState, lane: LaneId): boolean {
  if (!laneOpen(state, lane)) return false;
  return LANE_IDS.some((id) => id !== lane && laneOpen(state, id));
}

/** The last open lane's collapse control carries aria-disabled, not disabled, so focus is never dropped. */
export function collapseControl(state: LayoutState, lane: LaneId): {
  'aria-expanded': 'true' | 'false';
  'aria-controls': string;
  'aria-disabled'?: 'true';
  title: string;
} {
  const open = laneOpen(state, lane);
  const control: {
    'aria-expanded': 'true' | 'false';
    'aria-controls': string;
    'aria-disabled'?: 'true';
    title: string;
  } = {
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': `lane-${lane}`,
    title: open ? `Collapse ${lane}` : `Expand ${lane}`,
  };
  if (open && !canCollapseLane(state, lane)) {
    control['aria-disabled'] = 'true';
    control.title = 'At least one conversation stays open';
  }
  return control;
}

/** Toggle a lane. A refused collapse returns the same state object, so callers can detect the no-op. */
export function toggleLane(state: LayoutState, lane: LaneId): LayoutState {
  if (laneOpen(state, lane)) {
    if (!canCollapseLane(state, lane)) return state;
    return { ...state, [lane]: 'collapsed' };
  }
  return { ...state, [lane]: 'open' };
}

export function toggleRail(state: LayoutState): LayoutState {
  return { ...state, rail: state.rail === 'collapsed' ? 'expanded' : 'collapsed' };
}

/** Lanes visible in the current width: both when wide, the chosen segment when narrow. */
export function visibleLanes(state: LayoutState): LaneId[] {
  return state.narrow ? [state.segment] : [...LANE_IDS];
}

/** The lane the narrow switcher shows for the given segment. */
export function selectSegment(state: LayoutState, lane: LaneId): LayoutState {
  return { ...state, segment: lane };
}

export function openSheet(state: LayoutState, route: RouteId): LayoutState {
  return { ...state, sheet: route };
}

export function closeSheet(state: LayoutState): LayoutState {
  return state.sheet === null ? state : { ...state, sheet: null };
}

/** The focus target after collapsing `lane`: the other lane's primary control id. */
export function focusTargetAfterCollapse(lane: LaneId): string {
  return `lane-${otherLane(lane)}-primary`;
}
