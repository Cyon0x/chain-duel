"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui";
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {/*
        Portalled to <body>: the header uses backdrop-blur, which makes it a
        containing block for position:fixed descendants — without this the
        modal would be trapped inside the 64px header box.

        `open` can only become true from a client-side click, so `document` is
        always available here and no mount guard is needed.
      */}
      {open ? createPortal(<SignInOverlay providers={providers} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function SignInOverlay({ providers, onClose }: { providers: AuthProviders; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // preventScroll matters: without it the browser scrolls the panel into
    // view inside the overlay and the top of a tall modal goes off-screen.
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-bg/80 backdrop-blur-md"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex min-h-full items-center justify-center p-4 sm:p-6"
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sign-in-heading"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          className="animate-rise panel relative my-auto w-full max-w-[420px] px-5 py-6 outline-none sm:px-7 sm:py-8"
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <span aria-hidden>×</span>
          </button>
          <SignInPanel providers={providers} onDone={onClose} />
        </div>
      </div>
    </div>
  );
}
