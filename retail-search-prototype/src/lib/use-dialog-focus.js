import { useEffect, useRef } from "react";

// Keep overlays keyboard-contained and restore their opener after dismissal.
export function useDialogFocus(onClose) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const background = [...document.querySelectorAll(".app-shell > header, .app-shell > main")];
    const previousInert = background.map((element) => element.inert);
    background.forEach((element) => { element.inert = true; });
    document.body.style.overflow = "hidden";
    const focusable = () => [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], summary, [tabindex="0"]',
    )].filter((element) => element.getClientRects().length && !element.closest("[hidden]"));
    (focusable()[0] || dialog).focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0] || dialog;
        const last = elements.at(-1) || dialog;
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        // Moving from one overlay to another must not steal its initial focus.
        if (document.querySelector('[aria-modal="true"]')) return;
        const target = opener?.isConnected ? opener : document.querySelector(".brand-mark");
        target?.focus({ preventScroll: true });
      });
    };
  }, []);

  return dialogRef;
}
