/**
 * 0075: an element's top edge within a scroll container's content
 * space. Rect deltas are independent of the offsetParent, and
 * + scrollTop makes the value invariant to where the container itself
 * is scrolled or sits on the page — the position a load-earlier
 * prepend must hold constant. Shared by the chat and harness views.
 */
export function topInScroller(scroll: HTMLElement, el: Element): number {
  return el.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
}
