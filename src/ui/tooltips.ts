/**
 * Behaviour for the segmented-control hints (`.seg-hint`).
 *
 * Positioning is entirely CSS — the hint is anchored to the `.segmented`
 * container so it cannot overflow. This module owns only *when* a hint is
 * visible, and guarantees at most one is open at a time.
 *
 * Three ways in, deliberately separated:
 *  - **Hover**, on fine pointers only, handled in CSS. Touch is excluded there
 *    because `:hover` sticks after a tap and the hint never leaves.
 *  - **Long press**, for touch, since there is no hover to speak of. The press
 *    that opens a hint does not also change the selection: reading the help for
 *    an option should not pick it.
 *  - **Keyboard focus**, but only `:focus-visible`. Plain `:focus-within` was
 *    what pinned a hint open indefinitely after a mouse click.
 *
 * Delegated from the document, so hints inside DOM the wizard builds later work
 * without re-wiring.
 */

const LONG_PRESS_MS = 500;
/** Movement past this many pixels means the user is scrolling, not pressing. */
const MOVE_TOLERANCE_PX = 10;

let openItem: HTMLElement | null = null;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressStart: { x: number; y: number } | null = null;
/** Set when a long press opened a hint, so the click it produces is swallowed. */
let swallowNextClick = false;

function close(): void {
  openItem?.classList.remove('hint-open');
  openItem = null;
}

function openOn(item: HTMLElement): void {
  if (openItem === item) return;
  close();
  item.classList.add('hint-open');
  openItem = item;
}

function cancelPress(): void {
  clearTimeout(pressTimer);
  pressTimer = undefined;
  pressStart = null;
}

const itemOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>('.seg-item') : null;

/** Wire the hint behaviour once per page. Safe to call more than once. */
let wired = false;
export function wireTooltips(): void {
  if (wired) return;
  wired = true;

  document.addEventListener(
    'pointerdown',
    (e) => {
      // Any press anywhere dismisses the current hint, including a press on
      // another option — that is what keeps it to one at a time.
      close();
      if (e.pointerType === 'mouse') return; // mouse gets hover, in CSS
      const item = itemOf(e.target);
      if (!item) return;
      pressStart = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        openOn(item);
        swallowNextClick = true;
        pressStart = null;
      }, LONG_PRESS_MS);
    },
    true,
  );

  document.addEventListener(
    'pointermove',
    (e) => {
      if (!pressStart) return;
      const moved =
        Math.abs(e.clientX - pressStart.x) > MOVE_TOLERANCE_PX ||
        Math.abs(e.clientY - pressStart.y) > MOVE_TOLERANCE_PX;
      if (moved) cancelPress();
    },
    { capture: true, passive: true },
  );

  for (const type of ['pointerup', 'pointercancel'] as const) {
    document.addEventListener(type, cancelPress, true);
  }

  // A long press is for reading, not for choosing: swallow the click it leaves
  // behind so the option underneath is not selected.
  document.addEventListener(
    'click',
    (e) => {
      if (!swallowNextClick) return;
      swallowNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // Scrolling away from a hint should not leave it floating over the content.
  document.addEventListener('scroll', close, { capture: true, passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  document.addEventListener('focusin', (e) => {
    const item = itemOf(e.target);
    // `:focus-visible` is the keyboard-navigation signal; a focus that came from
    // a click does not match, which is exactly the case that used to pin hints.
    if (item && e.target instanceof Element && e.target.matches(':focus-visible')) {
      openOn(item);
    } else if (!item) {
      close();
    }
  });

  document.addEventListener('focusout', (e) => {
    if (itemOf(e.target) === openItem) close();
  });
}
