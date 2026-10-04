/** Makes a click-only element (nav row, card, list row, collapsible heading) reachable and
 *  operable from the keyboard: focusable, announced as a button, and activated by Enter/Space.
 *  Keys pressed on a nested control (toggle, icon button) are left to that control. */
export function makeActivatable(el: HTMLElement, label?: string) {
  el.tabIndex = 0;
  el.setAttr("role", "button");
  if (label) el.setAttr("aria-label", label);
  el.addEventListener("keydown", (evt) => {
    if (evt.target !== el) return;
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      el.click();
    }
  });
}

/** Obsidian's own toggle (`.checkbox-container`), exposed as a switch. Clicking only calls
 *  onClick: callers confirm first and re-render, so the visual state never runs ahead of disk. */
export function createSwitch(
  parent: HTMLElement,
  opts: { on: boolean; label: string; small?: boolean; onClick: (evt: MouseEvent) => void }
): HTMLElement {
  const el = parent.createDiv({
    cls: `checkbox-container skillmanager-switch${opts.small ? " skillmanager-switch-sm" : ""}${opts.on ? " is-enabled" : ""}`,
    attr: { role: "switch", "aria-checked": String(opts.on), "aria-label": opts.label, tabindex: "0" },
  });
  el.addEventListener("click", (evt) => {
    evt.stopPropagation();
    opts.onClick(evt);
  });
  el.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      evt.stopPropagation();
      el.click();
    }
  });
  return el;
}
