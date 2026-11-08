"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";
import { Icon } from "./icons";

/** Announcement only. A native modal keeps focus and the previous game screen intact. */
export function SwapAnnouncement({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-modal="true"
      className="swap-announcement panel fixed inset-0 m-auto w-[calc(100%-24px)] max-w-lg px-5 py-7 text-ink sm:px-8 sm:py-9"
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose();
      }}
    >
      <button type="button" aria-label="Close Swap announcement" onClick={onClose} className="focus-ring absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-xl border border-transparent text-muted transition-colors hover:bg-surface hover:text-ink">
        <Icon name="close" size={18} />
      </button>
      <span aria-hidden className="mb-6 grid h-16 w-16 place-items-center rounded-2xl border border-accent/40 bg-accent-soft text-accent">
        <Icon name="swap" size={30} />
      </span>
      <p className="eyebrow text-accent">On the horizon</p>
      <h2 id={headingId} className="text-display mt-3 max-w-sm text-3xl sm:text-4xl">Swap Feature Coming Soon</h2>
      <p id={descriptionId} className="mt-4 text-sm leading-relaxed text-muted sm:text-base">
        When live, Chain Duel users will be able to swap and bridge assets across different chains and currencies supported within the Stellar ecosystem, all from one place.
      </p>
      <div className="hairline my-6" />
      <Button onClick={onClose} className="w-full sm:w-auto">Back to game</Button>
    </dialog>,
    document.body,
  );
}
