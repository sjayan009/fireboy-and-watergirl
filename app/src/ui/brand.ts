/** Original paired glyph: an ember and a pool around a shared doorway. */
export function emblem(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "element-emblem";
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = '<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M23 4C24 15 9 17 9 29a14 14 0 0 0 14 14V30c-6-1-6-7-3-10 1 4 3 5 3 5V4Z" fill="var(--fire)"/><path d="M29 6c0 9 12 14 12 23a14 14 0 0 1-14 14V29c7-2 8-7 2-13V6Z" fill="var(--water)"/></svg>';
  return mark;
}
