/** Swipe-to-change-tab rules, kept free of React Native so they can be unit tested. */

/** How far (px) or how fast (px/ms) a release must be to count as a swipe. */
export const SWIPE_DISTANCE = 60;
export const SWIPE_VELOCITY = 0.5;
/** Movement (px) before a drag is considered at all, so taps still reach buttons and cards. */
export const SWIPE_SLOP = 20;

/** Claim the gesture only for clearly horizontal drags; anything else stays a vertical scroll or a tap. */
export function isHorizontalSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > SWIPE_SLOP && Math.abs(dx) > Math.abs(dy) * 2;
}

/** Where the content should sit while dragging: follows the finger, but resists past the first/last tab. */
export function dragOffset(count: number, index: number, dx: number): number {
  const atEdge = (dx > 0 && index <= 0) || (dx < 0 && index >= count - 1);
  return atEdge ? dx / 4 : dx;
}

/**
 * Direction to move on release: 1 = next tab (finger moved left), -1 = previous tab, 0 = stay.
 * Never points past the first or last tab.
 */
export function swipeDirection(count: number, index: number, dx: number, vx: number): -1 | 0 | 1 {
  const dir = dx < -SWIPE_DISTANCE || vx < -SWIPE_VELOCITY ? 1 : dx > SWIPE_DISTANCE || vx > SWIPE_VELOCITY ? -1 : 0;
  const next = index + dir;
  return dir !== 0 && next >= 0 && next < count ? dir : 0;
}
