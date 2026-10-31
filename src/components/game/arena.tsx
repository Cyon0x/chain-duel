"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { PulseDuelSession, type TargetSpec } from "@/lib/game/pulse";
import { usePreferences } from "@/components/providers";
import { sound } from "@/lib/sound/audio";
import type { MatchView, SubmitResponse } from "@/lib/api/views";
import { formatXlm } from "@/lib/config/game";
import { Icon } from "@/components/icons";
import { ArenaOrbits, TargetLegend } from "./target-legend";

interface HitRecordLocal {
  targetId: number;
  atMs: number;
}

type Phase = "countdown" | "playing" | "submitting" | "over";

interface FloatingMark {
  key: string;
  x: number;
  y: number;
  text: string;
  tone: "hit" | "gold" | "wrong" | "combo";
}

export interface ArenaProps {
  view: MatchView;
  selfUserId: string;
  onFinished: (response: SubmitResponse) => void;
}

export function PulseArena({ view, selfUserId, onFinished }: ArenaProps) {
  const { play } = usePreferences();
  const self = view.players.find((player) => player.user_id === selfUserId) ?? view.players[0];
  const opponent = view.players.find((player) => player.user_id !== selfUserId) ?? view.players[1];

  const durationMs = view.game.duration_ms;
  const schedule = useMemo(() => view.schedule as TargetSpec[], [view.schedule]);

  // Constructed lazily once per mount: `useRef(new X())` would rebuild the
  // target map on every render (60×/second during play) and only keep the first.
  const [session] = useState(() => new PulseDuelSession(schedule, durationMs));

  const [phase, setPhase] = useState<Phase>("countdown");
  const [visible, setVisible] = useState<TargetSpec[]>([]);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [timeLeftMs, setTimeLeftMs] = useState(durationMs);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [marks, setMarks] = useState<FloatingMark[]>([]);
  const [opponentScore, setOpponentScore] = useState(
    () => (view.botScore ?? view.liveScores[String(opponent?.seat ?? 2)] ?? 0),
  );
  const [shake, setShake] = useState(0);

  const hitsRef = useRef<HitRecordLocal[]>([]);
  const missesRef = useRef<number[]>([]);
  const phaseRef = useRef<Phase>("countdown");
  const submittedRef = useRef(false);
  const lastCountRef = useRef<number | null>(null);
  const clockRef = useRef<{ t0: number; offset: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const lastSecondRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    // Entering a duel is the strongest signal that the player wants the
    // soundtrack: start it here (subject to autoplay policy) and duck the bed
    // so hit feedback stays on top. The graph is never torn down on exit.
    sound.setMatchActive(true);
    sound.ensurePlaying();
    return () => sound.setMatchActive(false);
  }, []);

  /**
   * The match clock is anchored to the server: `t0` is when match time reaches
   * zero (after the countdown) and `offset` corrects for local clock drift.
   */
  const ensureClock = useCallback(() => {
    if (!clockRef.current) {
      const now = Date.now();
      clockRef.current = {
        offset: view.serverTimeMs - now,
        t0: (view.startAtMs ?? now) + view.countdownMs,
      };
    }
    return clockRef.current;
  }, [view.countdownMs, view.serverTimeMs, view.startAtMs]);

  const [size, setSize] = useState({ width: 640, height: 420 });
  const arenaRef = useRef<HTMLDivElement | null>(null);

  const nowMs = useCallback(() => Date.now() + ensureClock().offset, [ensureClock]);
  const matchMs = useCallback(() => nowMs() - ensureClock().t0, [ensureClock, nowMs]);

  useEffect(() => {
    const node = arenaRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const minDim = Math.min(size.width, size.height);
  const targetPx = (radius: number) => Math.max(44, radius * 2 * minDim);

  const addMark = useCallback((mark: Omit<FloatingMark, "key">) => {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setMarks((current) => [...current.slice(-14), { ...mark, key }]);
    window.setTimeout(() => {
      setMarks((current) => current.filter((entry) => entry.key !== key));
    }, 760);
  }, []);

  /* ------------------------------------------------------- authoritative submit */
  const submit = useCallback(async () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    phaseRef.current = "submitting";
    setPhase("submitting");
    const snapshot = session.snapshot();
    try {
      const response = await fetch(`/api/matches/${view.game.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seat: self?.seat ?? 1,
          hits: hitsRef.current,
          misses: missesRef.current.map((atMs) => ({ atMs })),
          clientScore: snapshot.score,
          clientDurationMs: durationMs,
        }),
      });
      const payload = (await response.json()) as SubmitResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "We could not verify that duel.");
      play("transaction");
      onFinished(payload);
    } catch (error) {
      phaseRef.current = "over";
      setPhase("over");
      addMark({
        x: 0.5,
        y: 0.5,
        text: error instanceof Error ? error.message : "Submission failed",
        tone: "wrong",
      });
      // Allow a single retry if the first submission failed.
      window.setTimeout(() => {
        submittedRef.current = false;
      }, 1_500);
    }
  }, [addMark, durationMs, onFinished, play, session, self?.seat, view.game.id]);

  /* ------------------------------------------------------------------ game loop */
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const now = nowMs();
      const matchMsValue = now - ensureClock().t0;
      const current = phaseRef.current;

      if (current === "countdown" || current === "playing") {
        if (matchMsValue < 0) {
          const secondsLeft = Math.ceil(-matchMsValue / 1000);
          if (lastCountRef.current !== secondsLeft) {
            lastCountRef.current = secondsLeft;
            setCountdown(secondsLeft);
            play("countdown");
          }
          if (phaseRef.current !== "countdown") {
            phaseRef.current = "countdown";
            setPhase("countdown");
          }
        } else {
          if (phaseRef.current === "countdown") {
            phaseRef.current = "playing";
            setPhase("playing");
            setCountdown(null);
            play("countdownGo");
          }
          const remaining = Math.max(0, durationMs - matchMsValue);
          // The clock bar is driven straight to the DOM every frame; React state
          // only changes when the displayed second does, so the HUD re-renders
          // once per second instead of sixty times.
          if (barRef.current) {
            const fraction = Math.max(0, Math.min(1, remaining / durationMs));
            barRef.current.style.transform = `scaleX(${fraction})`;
          }
          const seconds = Math.ceil(remaining / 1000);
          if (lastSecondRef.current !== seconds) {
            lastSecondRef.current = seconds;
            setTimeLeftMs(remaining);
          }

          const next = session.visibleAt(matchMsValue);
          setVisible((prev) => (sameTargets(prev, next) ? prev : next));

          const snapshot = session.snapshot();
          setScore(snapshot.score);
          setCombo(session.comboCount);
          setMultiplier(session.multiplier);

          if (matchMsValue >= durationMs) {
            setVisible([]);
            void submit();
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, ensureClock, matchMs, nowMs, play, session, submit]);

  /* ------------------------------------------------------- opponent + progress */
  useEffect(() => {
    if (phase !== "playing") return;
    const timer = window.setInterval(async () => {
      const snapshot = session.snapshot();
      try {
        await fetch(`/api/matches/${view.game.id}/progress`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            score: snapshot.score,
            combo: session.comboCount,
            hits: snapshot.hits,
            misses: snapshot.misses,
            atMs: Math.max(0, matchMs()),
          }),
        });
      } catch {
        // Provisional pings are best-effort only.
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [matchMs, phase, session, view.game.id]);

  useEffect(() => {
    if (phase !== "playing") return;
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/matches/${view.game.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as MatchView;
        const seat = opponent?.seat ?? 2;
        const live = payload.botScore ?? payload.liveScores[String(seat)] ?? 0;
        setOpponentScore(live);
      } catch {
        // ignore transient polling failures
      }
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [opponent?.seat, phase, view.game.id]);

  /* ------------------------------------------------------------------- input */
  const handleTarget = useCallback(
    (target: TargetSpec) => {
      if (phaseRef.current !== "playing") return;
      const atMs = matchMs();
      const result = session.applyHit(target.id, atMs);
      if (!result.accepted) {
        setShake((value) => value + 1);
        window.setTimeout(() => setShake(0), 320);
        return;
      }
      hitsRef.current.push({ targetId: target.id, atMs });
      const snapshot = session.snapshot();
      setScore(snapshot.score);
      setCombo(session.comboCount);
      setMultiplier(session.multiplier);

      if (target.points > 0) {
        play(target.kind === "gold" ? "gold" : "hit");
        addMark({
          x: target.x,
          y: target.y,
          text: `+${result.points}`,
          tone: target.kind === "gold" ? "gold" : "hit",
        });
        if (session.comboCount >= 3) {
          play("combo");
          addMark({ x: target.x, y: Math.max(0.08, target.y - 0.12), text: `${session.multiplier.toFixed(1)}×`, tone: "combo" });
        }
      } else {
        play("wrong");
        addMark({ x: target.x, y: target.y, text: `${result.points}`, tone: "wrong" });
      }
      setVisible((prev) => prev.filter((entry) => entry.id !== target.id));
    },
    [addMark, matchMs, play, session],
  );

  const handleBackground = useCallback(() => {
    if (phaseRef.current !== "playing") return;
    const atMs = matchMs();
    const isCombo = session.comboCount > 0;
    session.applyMiss(atMs);
    missesRef.current.push(atMs);
    setCombo(0);
    setMultiplier(1);
    if (isCombo) play("miss");
  }, [matchMs, play, session]);

  const selfScore = score;
  const progressSelf = Math.min(1, selfScore / Math.max(1, view.maxScore * 0.6));
  const progressOpponent = Math.min(1, opponentScore / Math.max(1, view.maxScore * 0.6));

  return (
    <div className="pulse-arena">
      <h1 className="sr-only">Pulse Duel</h1>
      <ArenaHud
        self={self}
        opponent={opponent}
        selfScore={selfScore}
        opponentScore={opponentScore}
        combo={combo}
        multiplier={multiplier}
        timeLeftMs={timeLeftMs}
        durationMs={durationMs}
        progressSelf={progressSelf}
        progressOpponent={progressOpponent}
        isBot={view.game.mode === "bot"}
        phase={phase}
      />

      <div className="pulse-meta">
        <span><Icon name="gamepad" size={15} />Pulse Duel{view.game.mode === "bot" ? " · vs computer" : " · 1v1"}</span>
        <span>{view.game.demo ? "Demo · no stake" : `${formatXlm(view.game.entry_stroops)} XLM entry · ${formatXlm(view.game.entry_stroops * 2)} XLM pool`}</span>
      </div>

      <div
        ref={arenaRef}
        className={clsx("arena-surface grid-lines pulse-field", shake > 0 && "arena-shake")}
        onPointerDown={handleBackground}
        role="application"
        aria-label="Pulse Duel arena"
      >
        <ArenaOrbits />
        <div
          ref={barRef}
          className="absolute inset-x-0 top-0 h-0.5 origin-left bg-accent"
          style={{ transform: "scaleX(1)", opacity: 0.5 }}
        />

        {phase === "countdown" && countdown !== null ? (
          <div className="absolute inset-0 z-20 grid place-items-center bg-bg/45 backdrop-blur-[2px]">
            <div key={countdown} className="animate-rise text-center">
              <p className="pulse-countdown numeric text-accent">{countdown}</p>
              <p className="eyebrow mt-2">Get ready</p>
            </div>
          </div>
        ) : null}

        {phase === "playing" && countdown === null && visible.length === 0 ? (
          <p className="absolute inset-0 grid place-items-center text-sm text-dim">Stay sharp…</p>
        ) : null}

        {phase !== "countdown"
          ? visible.map((target) => {
              const px = targetPx(target.radius);
              return (
                <button
                  key={target.id}
                  type="button"
                  aria-label={`${target.kind} target, ${target.points} points`}
                  className={`target target--${target.kind} focus-ring`}
                  style={{
                    left: `${target.x * 100}%`,
                    top: `${target.y * 100}%`,
                    width: px,
                    height: px,
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    handleTarget(target);
                  }}
                  onClick={(event) => { if (event.detail === 0) handleTarget(target); }}
                >
                  <span className="target__core" />
                  <span className="target__symbol"><Icon name={target.kind === "red" ? "close" : target.kind === "gold" ? "star" : "bolt"} size={17} /></span>
                </button>
              );
            })
          : null}

        {marks.map((mark) => (
          <span
            key={mark.key}
            className={clsx(
              "float-score text-lg",
              mark.tone === "wrong" ? "text-danger" : mark.tone === "gold" ? "text-gold" : "text-accent",
            )}
            style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
          >
            {mark.text}
          </span>
        ))}

        {phase === "submitting" ? (
          <div className="absolute inset-0 z-30 grid place-items-center bg-bg/70 backdrop-blur-sm">
            <div className="text-center">
              <p className="eyebrow">Verifying result</p>
              <p className="mt-2 text-sm text-muted">Replaying your event log on the server…</p>
            </div>
          </div>
        ) : null}
      </div>

      <TargetLegend className="pulse-legend" />

      <p aria-live="polite" className="sr-only">
        Score {selfScore}. Combo {combo}.
      </p>
    </div>
  );
}

function sameTargets(a: TargetSpec[], b: TargetSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].id !== b[index].id) return false;
  }
  return true;
}

function ArenaHud({
  self,
  opponent,
  selfScore,
  opponentScore,
  combo,
  multiplier,
  timeLeftMs,
  durationMs,
  progressSelf,
  progressOpponent,
  isBot,
  phase,
}: {
  self: MatchView["players"][number];
  opponent: MatchView["players"][number];
  selfScore: number;
  opponentScore: number;
  combo: number;
  multiplier: number;
  timeLeftMs: number;
  durationMs: number;
  progressSelf: number;
  progressOpponent: number;
  isBot: boolean;
  phase: Phase;
}) {
  const seconds = Math.ceil(timeLeftMs / 1000);
  const urgent = timeLeftMs <= 10_000;
  return (
    <div className="arena-hud">
      <div className="arena-hud__players">
        <PlayerReadout name={self?.username ?? "You"} score={selfScore} accent="self" progress={progressSelf} />
        <div className="arena-hud__clock">
          <span className="arena-hud__phase">{phase === "playing" ? "Live duel" : phase === "countdown" ? "Get ready" : phase === "submitting" ? "Verifying" : "Finished"}</span>
          <p className={clsx("numeric", urgent ? "text-danger" : "text-ink")} aria-label={`${Math.max(0, seconds)} seconds remaining`}>
            {String(Math.max(0, seconds)).padStart(2, "0")}
          </p>
          <span className="arena-hud__seconds">seconds</span>
        </div>
        <PlayerReadout
          name={isBot ? `${opponent?.username ?? "Computer"} · CPU` : opponent?.username ?? "Opponent"}
          score={opponentScore}
          accent="opponent"
          alignRight
          progress={progressOpponent}
        />
      </div>
      <div className="arena-hud__combo">
        <span className="inline-flex items-center gap-2">
          <Icon name="bolt" size={14} />
          Combo <strong className="numeric text-ink">{combo}</strong>
        </span>
        <span className={clsx("numeric", multiplier > 1 ? "text-accent" : "text-muted")}>
          {multiplier.toFixed(1)}× multiplier
        </span>
        <span className="arena-hud__duration">
          {Math.round(durationMs / 1000)}s duel
        </span>
      </div>
    </div>
  );
}

function PlayerReadout({
  name,
  score,
  accent,
  alignRight,
  progress,
}: {
  name: string;
  score: number;
  accent: "self" | "opponent";
  alignRight?: boolean;
  progress: number;
}) {
  return (
    <div className={clsx("player-readout", alignRight && "player-readout--opponent")}>
      <p className="player-readout__name" title={name}><span aria-hidden />{name}</p>
      <p className={clsx("player-readout__score numeric", accent === "self" ? "text-accent" : "text-gold")}>
        {score.toLocaleString("en-US")}
      </p>
      <div className="player-readout__track" aria-hidden><div style={{ width: `${progress * 100}%` }} /></div>
    </div>
  );
}
