"use client";

import clsx from "clsx";
import { Badge } from "@/components/ui";
import { formatXlm } from "@/lib/config/game";

export interface StakeOption {
  xlm: number;
  label: string;
}

export function StakePicker({
  options,
  value,
  onChange,
  demo,
  onDemoChange,
  demoAllowed,
  max,
}: {
  options: StakeOption[];
  value: number;
  onChange: (xlm: number) => void;
  demo: boolean;
  onDemoChange: (demo: boolean) => void;
  demoAllowed: boolean;
  max?: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Entry</p>
        {demoAllowed ? (
          <button
            type="button"
            onClick={() => onDemoChange(!demo)}
            aria-pressed={demo}
            className={clsx(
              "focus-ring rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors",
              demo ? "border-accent bg-accent-soft text-accent" : "border-line text-dim hover:border-line-strong",
            )}
          >
            {demo ? "Demo on" : "Demo off"}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((option) => {
          const disabled = !demo && max !== undefined && option.xlm > max;
          return (
            <button
              key={option.xlm}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.xlm)}
              className={clsx(
                "focus-ring rounded-2xl border px-3 py-3 text-center transition-colors",
                value === option.xlm && !demo
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:border-line-strong",
                disabled && "cursor-not-allowed opacity-40",
              )}
            >
              <span className="numeric block text-lg font-semibold">{option.xlm}</span>
              <span className="block text-[11px] uppercase tracking-[0.14em] text-dim">XLM</span>
            </button>
          );
        })}
      </div>
      <div className="panel-flat flex items-center justify-between px-3.5 py-2.5 text-sm">
        <span className="text-muted">{demo ? "Demo duel" : "Prize pool"}</span>
        <span className="flex items-center gap-2">
          {demo ? <Badge tone="neutral">No stake</Badge> : null}
          <span className="numeric font-semibold">{demo ? "—" : `${formatXlm(value * 2)} XLM`}</span>
        </span>
      </div>
      {!demo ? (
        <p className="text-xs text-dim">
          Winner receives {formatXlm(Math.floor((value * 2 * 9_000) / 10_000))} XLM · protocol fee{" "}
          {formatXlm(Math.floor((value * 2 * 1_000) / 10_000))} XLM (10%).
        </p>
      ) : null}
    </div>
  );
}
