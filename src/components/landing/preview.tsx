"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { usePreferences } from "@/components/providers";
import { PULSE_DUEL } from "@/lib/config/game";

type Kind = "blue" | "gold" | "red";

interface PreviewTarget {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  bornAt: number;
  lifetime: number;
}

const KIND_POINTS: Record<Kind, number> = { blue: 10, gold: 25, red: -15 };
/** Lifetimes come from the live game config so the preview always feels the same. */
const lifetimeFor = (kind: Kind) =>
  PULSE_DUEL.targets.find((target) => target.kind === kind)?.lifetimeMs ?? 1_500;
const LIFETIME: Record<Kind, number> = {
  blue: lifetimeFor("blue"),
  gold: lifetimeFor("gold"),
  red: lifetimeFor("red"),
};

/**
 * A genuinely interactive slice of Pulse Duel shown on the landing page so
 * visitors can feel the game before they connect a wallet. It is explicitly
 * a practice preview: nothing here touches escrow or the leaderboard.
 */
export function LandingPreview() {
  const { play } = usePreferences();
  const [targets, setTargets] = useState<PreviewTarget[]>([]);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [flash, setFlash] = useState<{ key: string; text: string; tone: string } | null>(null);
  const counter = useRef(0);
  const comboRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTargets((current) => {
        const now = Date.now();
        const alive = current.filter((target) => target.bornAt + target.lifetime > now);
        if (alive.length >= 4) return alive;
        const roll = Math.random();
        const kind: Kind = roll < 0.6 ? "blue" : roll < 0.8 ? "gold" : "red";
        counter.current += 1;
        const margin = 0.12;
        return [
          ...alive,
          {
            id: counter.current,
            kind,
            x: margin + Math.random() * (1 - margin * 2),
            y: margin + Math.random() * (1 - margin * 2),
            bornAt: now,
            lifetime: LIFETIME[kind],
          },
        ];
      });
    }, 560);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTargets((current) => current.filter((target) => target.bornAt + target.lifetime > now));
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const hit = useCallback(
    (target: PreviewTarget) => {
      const points = KIND_POINTS[target.kind];
      setTargets((current) => current.filter((entry) => entry.id !== target.id));
      if (points > 0) {
        comboRef.current += 1;
        const multiplier = comboRef.current >= 8 ? 2 : comboRef.current >= 5 ? 1.5 : comboRef.current >= 3 ? 1.2 : 1;
        setCombo(comboRef.current);
        setScore((value) => Math.max(0, value + Math.round(points * multiplier)));
        play(target.kind === "gold" ? "gold" : "hit");
        setFlash({ key: `${Date.now()}`, text: `+${Math.round(points * multiplier)}`, tone: "text-accent" });
      } else {
        comboRef.current = 0;
        setCombo(0);
        setScore((value) => Math.max(0, value + points));
        play("wrong");
        setFlash({ key: `${Date.now()}`, text: `${points}`, tone: "text-danger" });
      }
    },
    [play],
  );

  return (
    <div className="w-full">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="eyebrow">Practice preview · no stake</span>
        <span className="flex items-center gap-3 text-xs text-muted">
          <span className="numeric">
            Combo <span className="text-accent">{combo}</span>
          </span>
          <span className="numeric">
            Score <span className="text-ink">{score.toLocaleString("en-US")}</span>
          </span>
        </span>
      </div>
      <div className="arena-surface grid-lines relative h-[320px] w-full sm:h-[380px]">
        {targets.map((target) => {
          const size = Math.max(42, target.kind === "gold" ? 46 : target.kind === "red" ? 56 : 52);
          return (
            <button
              key={target.id}
              type="button"
              aria-label={`${target.kind} target`}
              className={`target target--${target.kind} animate-rise`}
              style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%`, width: size, height: size }}
              onPointerDown={(event) => {
                event.preventDefault();
                hit(target);
              }}
            >
              <span className="target__core" />
            </button>
          );
        })}
        {flash ? (
          <span key={flash.key} className={clsx("float-score left-1/2 top-1/2 text-2xl", flash.tone)}>
            {flash.text}
          </span>
        ) : null}
        <div className="pointer-events-none absolute bottom-3 left-3 flex gap-3 text-[10px] uppercase tracking-[0.14em] text-dim">
          <span>● Blue +10</span>
          <span>● Gold +25</span>
          <span>● Red −15</span>
        </div>
      </div>
    </div>
  );
}
