let clearPrevious: (() => void) | null = null;

/** Limit print layout to the chosen document without copying student HTML to
 * another window or unmounting the surrounding workflow and its drafts. */
export function printRegion(target: Element | null) {
  if (!(target instanceof HTMLElement)) return;
  clearPrevious?.();
  const ancestors: HTMLElement[] = [];
  for (
    let node = target.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    node.setAttribute("data-print-ancestor", "");
    ancestors.push(node);
  }
  target.setAttribute("data-print-target", "");
  document.body.setAttribute("data-print-active", "");
  const cleanup = () => {
    target.removeAttribute("data-print-target");
    ancestors.forEach((node) => node.removeAttribute("data-print-ancestor"));
    document.body.removeAttribute("data-print-active");
    window.removeEventListener("afterprint", cleanup);
    if (clearPrevious === cleanup) clearPrevious = null;
  };
  clearPrevious = cleanup;
  window.addEventListener("afterprint", cleanup, { once: true });
  try {
    window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}
