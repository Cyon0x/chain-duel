"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { usePreferences } from "@/components/providers";
import { PULSE_DUEL, comboMultiplier } from "@/lib/config/game";
import { Icon } from "@/components/icons";
import { ArenaOrbits, TargetLegend } from "@/components/game/target-legend";
import styles from "./preview.module.css";

type Kind = "blue" | "gold" | "red";

interface PreviewTarget {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  bornAt: number;
  lifetime: number;
}

const KIND_POINTS = Object.fromEntries(PULSE_DUEL.targets.map(({ kind, points }) => [kind, points])) as Record<Kind, number>;
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
  const [active, setActive] = useState(true);
  const [paused, setPaused] = useState(false);
  const [flash, setFlash] = useState<{ key: string; text: string; tone: string; x: number; y: number } | null>(null);
  const counter = useRef(0);
  const comboRef = useRef(0);
  const fieldRef = useRef<HTMLDivElement>(null);
  const fieldSize = useRef({ width: 640, height: 320 });

  useEffect(() => {
    const node = fieldRef.current;
    if (!node) return;
    let inView = true;
    const update = () => setActive(inView && !document.hidden);
    const resize = new ResizeObserver(([entry]) => { fieldSize.current = { width: entry.contentRect.width, height: entry.contentRect.height }; });
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); });
    resize.observe(node);
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => { resize.disconnect(); observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  useEffect(() => {
    if (!active || paused) return;
    // Restore a playable field immediately after a cold load or visibility return.
    const initial = window.setTimeout(() => {
      const now = Date.now();
      setTargets((current) => {
        const alive = current.filter((target) => target.bornAt + target.lifetime > now);
        if (alive.length) return alive;
        return (["blue", "gold", "red"] as Kind[]).map((kind, index) => ({
          id: ++counter.current, kind, x: .22 + index * .28, y: index === 1 ? .35 : .65,
          bornAt: now, lifetime: LIFETIME[kind],
        }));
      });
    }, 0);
    const timer = window.setInterval(() => {
      setTargets((current) => {
        const now = Date.now();
        const alive = current.filter((target) => target.bornAt + target.lifetime > now);
        if (alive.length >= 4) return alive;
        const roll = Math.random();
        const kind: Kind = roll < 0.6 ? "blue" : roll < 0.8 ? "gold" : "red";
        counter.current += 1;
        const marginX = Math.max(0.12, 32 / Math.max(1, fieldSize.current.width));
        const marginY = Math.max(0.12, 32 / Math.max(1, fieldSize.current.height));
        return [
          ...alive,
          {
            id: counter.current,
            kind,
            x: marginX + Math.random() * (1 - marginX * 2),
            y: marginY + Math.random() * (1 - marginY * 2),
            bornAt: now,
            lifetime: LIFETIME[kind],
          },
        ];
      });
    }, 560);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [active, paused]);

  useEffect(() => {
    if (!active || paused) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTargets((current) => current.filter((target) => target.bornAt + target.lifetime > now));
    }, 200);
    return () => window.clearInterval(timer);
  }, [active, paused]);

  const hit = useCallback(
    (target: PreviewTarget) => {
      const points = KIND_POINTS[target.kind];
      setTargets((current) => current.filter((entry) => entry.id !== target.id));
      if (points > 0) {
        comboRef.current += 1;
        const multiplier = comboMultiplier(comboRef.current);
        setCombo(comboRef.current);
        setScore((value) => Math.max(0, value + Math.round(points * multiplier)));
        play(target.kind === "gold" ? "gold" : "hit");
        setFlash({ key: `${Date.now()}`, text: `+${Math.round(points * multiplier)}`, tone: "text-accent", x: target.x, y: target.y });
      } else {
        comboRef.current = 0;
        setCombo(0);
        setScore((value) => Math.max(0, value + points));
        play("wrong");
        setFlash({ key: `${Date.now()}`, text: `${points}`, tone: "text-danger", x: target.x, y: target.y });
      }
    },
    [play],
  );

  return (
    <section className={styles.practice} aria-label="Interactive practice preview" data-active={active && !paused}>
      <div className={styles.header}>
        <p className={styles.caption}>Practice preview<span>No stake</span></p>
        <dl className={styles.readouts}>
          <div className={styles.readout}><dt>Combo</dt><dd><strong className="numeric">{combo}</strong></dd></div>
          <div className={styles.readout}><dt>Score</dt><dd><strong className="numeric">{score.toLocaleString("en-US")}</strong></dd></div>
        </dl>
      </div>
      <div className={styles.instructions}><p>Tap blue and gold. Avoid red.</p><button type="button" className="focus-ring" aria-pressed={paused} aria-label={paused ? "Resume practice preview" : "Pause practice preview"} onClick={() => setPaused((value) => !value)}><Icon name={paused ? "play" : "pause"} size={14} />{paused ? "Resume" : "Pause"}</button></div>
      <div ref={fieldRef} className={clsx("arena-surface", styles.field)}>
        <ArenaOrbits />
        <span className={styles.watermark} aria-hidden>PULSE DUEL</span>
        {!paused ? targets.map((target) => {
          const size = Math.max(42, target.kind === "gold" ? 46 : target.kind === "red" ? 56 : 52);
          return (
            <button
              key={target.id}
              type="button"
              aria-label={`${target.kind} target, ${KIND_POINTS[target.kind]} points`}
              className={clsx(`target target--${target.kind} focus-ring`, styles.target)}
              style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%`, width: size, height: size }}
              onPointerDown={(event) => {
                event.preventDefault();
                hit(target);
              }}
              onClick={(event) => { if (event.detail === 0) hit(target); }}
            >
              <span className="target__core" />
              <span className="target__symbol"><Icon name={target.kind === "red" ? "close" : target.kind === "gold" ? "star" : "bolt"} size={17} /></span>
            </button>
          );
        }) : <p className={styles.paused}>Practice paused</p>}
        {flash ? (
          <span key={flash.key} className={clsx("float-score text-xl", flash.tone, styles.flash)} style={{ left: `${flash.x * 100}%`, top: `${flash.y * 100}%` }}>
            {flash.text}
          </span>
        ) : null}
      </div>
      <TargetLegend className={styles.footer} />
      <p className="sr-only" aria-live="polite">Practice score {score}. Combo {combo}. No stake.</p>
    </section>
  );
}
