// The terminal-style pin rule shared by the voice transcript and the chat list (V3 items 3 and 6).
// The maths is pure so the rule is testable headless; the binder at the end reads metrics and writes
// scrollTop only, so both lists follow exactly the same rule, including the "Jump to latest" pill.

export const PIN_SLACK_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How far the list is scrolled from its newest line; 0 means the bottom edge is exactly in view. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** The view is pinned while it sits within the slack of the bottom. */
export function isPinned(metrics: ScrollMetrics, slack = PIN_SLACK_PX): boolean {
  return distanceFromBottom(metrics) <= slack;
}

/** A pinned view keeps following new and growing lines; a reader who scrolled up keeps their place. */
export function nextPinned(pinned: boolean, metrics: ScrollMetrics, slack = PIN_SLACK_PX): boolean {
  return pinned || isPinned(metrics, slack);
}

/** The "Jump to latest" pill is offered exactly while the list is not following the bottom. */
export function jumpVisible(pinned: boolean, metrics: ScrollMetrics, slack = PIN_SLACK_PX): boolean {
  return !nextPinned(pinned, metrics, slack);
}

/**
 * Bind one list and its jump pill. Every content change re-settles the pin: a pinned list stays at the
 * bottom (scrolling up still stops the follow), the pill reports the state, and clicking it, like a new
 * Live session, re-pins. Returns a `repin` handle for that explicit re-pin.
 */
export function attachPin(
  list: HTMLElement,
  pill: HTMLElement | null,
  onPinnedChange?: (pinned: boolean) => void,
  initiallyPinned = true,
): { repin(): void; pinned(): boolean; stop(): void } {
  let pinned = initiallyPinned ?? true, frame: number | undefined, following = false;
  const metrics = (): ScrollMetrics => ({ scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight });
  const report = () => { if (pill) pill.hidden = !jumpVisible(pinned, metrics()); onPinnedChange?.(pinned); };
  const settle = () => { pinned = nextPinned(pinned, metrics()); if (pinned) list.scrollTop = list.scrollHeight; report(); };
  // Content grows in a mutation callback, before layout: follow on the next frame so the new height is real.
  const follow = () => { if (frame !== undefined) return; following = true; frame = requestAnimationFrame(() => { frame = undefined; following = false; settle(); }); };
  // A scroll that leaves the bottom is the reader taking over; a scroll back to it re-pins (V3 item 3).
  // While content is still settling (a growing line, a late font), the browser's own scroll moves are
  // not the reader, so they never unpin a view that was following the bottom.
  list.addEventListener('scroll', () => { if (following) return; pinned = isPinned(metrics()); report(); }, { passive: true });
  const observer = new MutationObserver(follow);
  observer.observe(list, { childList: true, subtree: true, characterData: true });
  // A viewport change resizes the list without a mutation: a pinned view follows that too.
  const resizer = new ResizeObserver(follow);
  resizer.observe(list);
  pill?.addEventListener('click', () => { pinned = true; settle(); });
  follow();
  return { repin() { pinned = true; settle(); }, pinned: () => pinned, stop() { if (frame !== undefined) cancelAnimationFrame(frame); observer.disconnect(); resizer.disconnect(); } };
}
