"use client";

import { useEffect, useRef } from "react";

type CursorState = "normal" | "hover" | "press" | "disabled";

/**
 * Desktop-only reticle cursor. Touch devices keep their native behaviour, and
 * the whole effect is disabled when the user prefers reduced motion.
 */
export function GameCursor() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!fine.matches || reduced.matches) return;

    const root = rootRef.current;
    if (!root) return;
    document.body.classList.add("cd-cursor-active");
    root.style.opacity = "0";

    let frame = 0;
    let running = false;
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let currentX = targetX;
    let currentY = targetY;
    let state: CursorState = "normal";

    const setState = (next: CursorState) => {
      if (state === next) return;
      state = next;
      root.dataset.state = next;
    };

    const render = () => {
      currentX += (targetX - currentX) * 0.28;
      currentY += (targetY - currentY) * 0.28;
      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${currentX}px, ${currentY}px, 0) translate(-50%, -50%)`;
      }
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${targetX}px, ${targetY}px, 0) translate(-50%, -50%)`;
      }
      // Park the loop once the ring has caught up: an idle page should not burn
      // a rAF slot forever on every desktop session.
      if (Math.abs(targetX - currentX) < 0.2 && Math.abs(targetY - currentY) < 0.2) {
        running = false;
        return;
      }
      frame = window.requestAnimationFrame(render);
    };

    const start = () => {
      if (running) return;
      running = true;
      frame = window.requestAnimationFrame(render);
    };

    const onMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      root.style.opacity = "1";
      start();
    };

    const resolveState = (element: Element | null): CursorState => {
      if (!element) return "normal";
      const interactive = element.closest(
        'a, button, [role="button"], input, select, textarea, [data-cursor="hover"]',
      );
      if (!interactive) return "normal";
      if (
        interactive.hasAttribute("disabled") ||
        interactive.getAttribute("aria-disabled") === "true" ||
        interactive.hasAttribute("data-cursor-disabled")
      ) {
        return "disabled";
      }
      return "hover";
    };

    const onOver = (event: Event) => setState(resolveState(event.target as Element));
    const onDown = () => setState("press");
    const onUp = (event: Event) => setState(resolveState(event.target as Element));
    const onLeave = () => {
      root.style.opacity = "0";
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointerleave", onLeave);
    frame = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointerleave", onLeave);
      document.body.classList.remove("cd-cursor-active");
    };
  }, []);

  return (
    <div ref={rootRef} className="cd-cursor" data-state="normal" aria-hidden>
      <div ref={ringRef} className="cd-cursor__ring" />
      <div ref={dotRef} className="cd-cursor__dot" />
    </div>
  );
}
