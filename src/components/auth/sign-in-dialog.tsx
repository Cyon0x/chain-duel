"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SignInPanel } from "./sign-in-panel";
import type { AuthProviders } from "./types";

/**
 * Header sign-in trigger: opens the shared chooser as a modal so a player never
 * has to leave the page they are on to authenticate.
 */
export function SignInDialog({
  providers,
  label = "Sign in",
  size = "sm",
  variant = "primary",
}: {
  providers: AuthProviders;
  label?: string;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      trigger?.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <>
      <Button ref={triggerRef} size={size} variant={variant} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {label}
      </Button>
      {/*
        Portalled to <body>: the header uses backdrop-blur, which makes it a
        containing block for position:fixed descendants — without this the
        modal would be trapped inside the 64px header box.

        `open` can only become true from a client-side click, so `document` is
        always available here and no mount guard is needed.
      */}
      {open ? createPortal(<SignInOverlay headingId={headingId} providers={providers} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function SignInOverlay({ providers, onClose, headingId }: { providers: AuthProviders; onClose: () => void; headingId: string }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // preventScroll matters: without it the browser scrolls the panel into
    // view inside the overlay and the top of a tall modal goes off-screen.
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className="sign-in-overlay fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-bg/80 backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="sign-in-overlay__position flex min-h-full items-center justify-center p-3 sm:p-6"
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          className="sign-in-dialog panel relative my-auto w-full max-w-[420px] px-4 py-5 outline-none sm:px-6 sm:py-6"
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? []).filter((node) => node.getClientRects().length > 0);
            const first = items[0];
            const last = items.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring absolute right-2 top-2 z-10 grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <Icon name="close" size={18} />
          </button>
          <SignInPanel providers={providers} onDone={onClose} headingId={headingId} />
        </div>
      </div>
    </div>
  );
}
