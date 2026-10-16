// The composer's two pure rules: which keys send, and how far the draft grows. No DOM, no storage, so
// the chat lane's Enter/Shift+Enter contract and its 40 percent growth cap are testable headless.

/** Enter sends the draft; Shift+Enter and an unfinished IME commit insert text instead (V3 item 5). */
export function composerIntent(event: { key: string; shiftKey?: boolean; isComposing?: boolean }): 'send' | undefined {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing ? 'send' : undefined;
}

/** The composer grows with the draft up to 40 percent of the lane height, then scrolls inside (V3 item 5). */
export function draftHeightPx(contentHeight: number, laneHeight: number, min = 56): number {
  return Math.max(min, Math.min(contentHeight, laneHeight > 0 ? Math.round(laneHeight * 0.4) : contentHeight));
}
