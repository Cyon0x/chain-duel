"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { PulseDuelSession, type TargetSpec } from "@/lib/game/pulse";
import { usePreferences } from "@/components/providers";
import { sound } from "@/lib/sound/audio";
import type { MatchView, SubmitResponse } from "@/lib/api/views";

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

  const sessionRef = useRef(new PulseDuelSession(schedule, durationMs));

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
    const session = sessionRef.current;
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
  }, [addMark, durationMs, onFinished, play, self?.seat, view.game.id]);

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
          setTimeLeftMs(remaining);

          const session = sessionRef.current;
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
  }, [durationMs, ensureClock, matchMs, nowMs, play, submit]);

  /* ------------------------------------------------------- opponent + progress */
  useEffect(() => {
    if (phase !== "playing") return;
    const timer = window.setInterval(async () => {
      const session = sessionRef.current;
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
  }, [matchMs, phase, view.game.id]);

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
      const session = sessionRef.current;
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
    [addMark, matchMs, play],
  );

  const handleBackground = useCallback(() => {
    if (phaseRef.current !== "playing") return;
    const atMs = matchMs();
    const session = sessionRef.current;
    const isCombo = session.comboCount > 0;
    session.applyMiss(atMs);
    missesRef.current.push(atMs);
    setCombo(0);
    setMultiplier(1);
    if (isCombo) play("miss");
  }, [matchMs, play]);

  const selfScore = score;
  const progressSelf = Math.min(1, selfScore / Math.max(1, view.maxScore * 0.6));
  const progressOpponent = Math.min(1, opponentScore / Math.max(1, view.maxScore * 0.6));
  const timeFraction = Math.max(0, Math.min(1, timeLeftMs / durationMs));

  return (
    <div className="flex flex-col gap-4">
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
      />

      <div
        ref={arenaRef}
        className={clsx("arena-surface grid-lines h-[58vh] min-h-[340px] w-full sm:h-[62vh]", shake > 0 && "arena-shake")}
        onPointerDown={handleBackground}
        role="application"
        aria-label="Pulse Duel arena"
      >
        <div
          className="absolute inset-x-0 top-0 h-0.5 origin-left bg-accent transition-transform duration-100"
          style={{ transform: `scaleX(${timeFraction})`, opacity: 0.5 }}
        />

        {phase === "countdown" && countdown !== null ? (
          <div className="absolute inset-0 z-20 grid place-items-center bg-bg/45 backdrop-blur-[2px]">
            <div key={countdown} className="animate-rise text-center">
              <p className="text-display numeric text-[86px] text-accent sm:text-[120px]">{countdown}</p>
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
                  className={`target target--${target.kind} focus-ring animate-rise`}
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
                >
                  <span className="target__core" />
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
}) {
  const seconds = Math.ceil(timeLeftMs / 1000);
  const urgent = timeLeftMs <= 10_000;
  return (
    <div className="panel-flat overflow-hidden">
      <div className="flex items-stretch divide-x divide-line">
        <PlayerReadout name={self?.username ?? "You"} score={selfScore} accent="self" />
        <div className="flex w-[92px] shrink-0 flex-col items-center justify-center gap-1 px-3 py-3 sm:w-[132px]">
          <p className={clsx("numeric text-2xl font-bold sm:text-3xl", urgent ? "text-danger" : "text-ink")}>
            {String(Math.max(0, seconds)).padStart(2, "0")}
          </p>
          <p className="eyebrow hidden sm:block">Seconds</p>
        </div>
        <PlayerReadout
          name={isBot ? `${opponent?.username ?? "Computer"} · CPU` : opponent?.username ?? "Opponent"}
          score={opponentScore}
          accent="opponent"
          alignRight
        />
      </div>
      <div className="grid grid-cols-2 gap-px bg-line">
        <div className="bg-bg-elevated px-3 py-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-strong">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progressSelf * 100}%` }} />
          </div>
        </div>
        <div className="bg-bg-elevated px-3 py-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-strong">
            <div
              className="ml-auto h-full rounded-full bg-danger/70 transition-[width] duration-200"
              style={{ width: `${progressOpponent * 100}%` }}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
        <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-dim">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Combo {combo}
        </span>
        <span className={clsx("numeric text-sm font-semibold", multiplier > 1 ? "text-accent" : "text-muted")}>
          {multiplier.toFixed(1)}× multiplier
        </span>
        <span className="hidden text-[11px] uppercase tracking-[0.16em] text-dim sm:block">
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
}: {
  name: string;
  score: number;
  accent: "self" | "opponent";
  alignRight?: boolean;
}) {
  return (
    <div className={clsx("flex-1 px-3 py-3", alignRight && "text-right")}>
      <p className="truncate text-[11px] uppercase tracking-[0.16em] text-dim">{name}</p>
      <p className={clsx("numeric mt-1 text-2xl font-semibold sm:text-3xl", accent === "self" ? "text-accent" : "text-ink")}>
        {score.toLocaleString("en-US")}
      </p>
    </div>
  );
}
