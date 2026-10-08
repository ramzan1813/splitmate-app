import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragOffset, isHorizontalSwipe, swipeDirection } from '../src/lib/swipeTabs';

const TABS = 4; // Expenses, Balances, Settle up, Chart

test('swipe tabs: only clearly horizontal drags are claimed, so scrolling and taps keep working', () => {
  assert.equal(isHorizontalSwipe(5, 0), false, 'tiny movement is still a tap');
  assert.equal(isHorizontalSwipe(-30, 2), true);
  assert.equal(isHorizontalSwipe(30, 2), true);
  assert.equal(isHorizontalSwipe(30, 20), false, 'diagonal drag stays a vertical scroll');
  assert.equal(isHorizontalSwipe(3, 200), false, 'vertical scroll');
});

test('swipe tabs: release past the distance or with enough speed moves one tab', () => {
  assert.equal(swipeDirection(TABS, 0, -120, 0), 1, 'drag left → next tab');
  assert.equal(swipeDirection(TABS, 2, 120, 0), -1, 'drag right → previous tab');
  assert.equal(swipeDirection(TABS, 1, -30, -0.8), 1, 'short fast flick counts');
  assert.equal(swipeDirection(TABS, 1, -30, -0.1), 0, 'short slow drag springs back');
  assert.equal(swipeDirection(TABS, 1, 0, 0), 0);
});

test('swipe tabs: never moves past the first or last tab', () => {
  assert.equal(swipeDirection(TABS, 0, 200, 2), 0, 'right on Expenses');
  assert.equal(swipeDirection(TABS, TABS - 1, -200, -2), 0, 'left on Chart');
  assert.equal(swipeDirection(TABS, TABS - 1, 200, 0), -1, 'Chart can still go back');
});

test('swipe tabs: content follows the finger, with resistance at the edges', () => {
  assert.equal(dragOffset(TABS, 1, -80), -80);
  assert.equal(dragOffset(TABS, 1, 80), 80);
  assert.equal(dragOffset(TABS, 0, 80), 20, 'pulling right on the first tab resists');
  assert.equal(dragOffset(TABS, TABS - 1, -80), -20, 'pulling left on the last tab resists');
});
