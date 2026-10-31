"use client";

import clsx from "clsx";
import { useId, useState } from "react";
import { Badge } from "@/components/ui";
import { ECONOMY, formatXlm, parseStakeXlm, splitPool, xlmToStroops } from "@/lib/config/game";

export interface StakeOption {
  xlm: number;
  label: string;
}

/**
 * Shared stake selector for every duel mode: preset buttons plus a validated
 * custom amount. The value handed back through `onChange` is the exact XLM
 * amount the duel/escrow will use — presets and custom amounts flow through the
 * same `parseStakeXlm` rules the API enforces.
 */
export function StakePicker({
  options,
  value,
  onChange,
  demo,
  onDemoChange,
  demoAllowed,
  max,
  min,
}: {
  options: StakeOption[];
  value: number;
  onChange: (xlm: number, valid: boolean) => void;
  demo: boolean;
  onDemoChange: (demo: boolean) => void;
  demoAllowed: boolean;
  max?: number;
  min?: number;
}) {
  const presetAmounts = options.map((option) => option.xlm);
  const [customText, setCustomText] = useState("");
  const [customMode, setCustomMode] = useState(!presetAmounts.includes(value));
  const customId = useId();
  const errorId = `${customId}-error`;

  const minXlm = min ?? ECONOMY.minEntryStroops / 10_000_000;
  const maxXlm = max ?? ECONOMY.maxEntryStroops / 10_000_000;
  const maxStroops = xlmToStroops(maxXlm);
  const minStroops = xlmToStroops(minXlm);
  const tabAmount = !customMode && presetAmounts.includes(value) && (demo || value <= maxXlm)
    ? value : options.find((option) => demo || option.xlm <= maxXlm)?.xlm;

  const customParse = customMode ? parseStakeXlm(customText, { maxStroops, minStroops }) : null;
  const customError = customParse && !customParse.ok ? customParse.error : null;
  const effectiveXlm = customMode ? (customParse?.ok ? customParse.xlm : null) : value;

  function selectPreset(amount: number) {
    setCustomMode(false);
    setCustomText("");
    onChange(amount, true);
  }

  function updateCustom(text: string) {
    setCustomText(text);
    setCustomMode(true);
    const parsed = parseStakeXlm(text, { maxStroops, minStroops });
    onChange(parsed.ok ? parsed.xlm : Number.NaN, parsed.ok);
  }

  const poolStroops = effectiveXlm === null ? null : xlmToStroops(effectiveXlm) * 2;
  const split = poolStroops === null ? null : splitPool(poolStroops, ECONOMY.feeBps);

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
              "focus-ring min-h-11 rounded-xl border px-3 py-1 text-xs font-semibold transition-colors",
              demo ? "border-accent bg-accent-soft text-accent" : "border-line text-dim hover:border-line-strong",
            )}
          >
            {demo ? "Demo on" : "Demo off"}
          </button>
        ) : null}
      </div>

      <div
        className="grid grid-cols-4 gap-2"
        role="radiogroup"
        aria-label="Stake preset"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          buttons[next]?.click();
        }}
      >
        {options.map((option) => {
          const disabled = !demo && option.xlm > maxXlm;
          const selected = !demo && !customMode && value === option.xlm;
          return (
            <button
              key={option.xlm}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={tabAmount === option.xlm ? 0 : -1}
              disabled={disabled}
              onClick={() => selectPreset(option.xlm)}
              title={disabled ? `Maximum stake is ${formatXlm(maxStroops)} XLM` : undefined}
              className={clsx(
                "focus-ring min-h-16 rounded-xl border px-2 py-2 text-center transition-colors",
                selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
                disabled && "cursor-not-allowed opacity-40",
              )}
            >
              <span className="numeric block text-lg font-semibold">{option.xlm}</span>
              <span className="block text-xs text-dim">XLM</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={customId} className="text-xs text-muted">
          Custom amount
        </label>
        <div
          className={clsx(
            "focus-within:border-accent flex h-11 items-center gap-2 rounded-xl border bg-surface px-3.5 transition-colors",
            customError ? "border-danger/60" : "border-line",
          )}
        >
          <input
            id={customId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Enter XLM amount"
            aria-invalid={Boolean(customError)}
            aria-describedby={customError ? errorId : undefined}
            className="numeric h-full w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-dim"
            value={customText}
            onChange={(event) => updateCustom(event.target.value)}
            onFocus={() => updateCustom(customText)}
          />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-dim">XLM</span>
        </div>
        {customError ? (
          <p id={errorId} role="alert" className="text-xs text-danger">
            {customError}
          </p>
        ) : (
          <p className="text-xs text-dim">
            Between {formatXlm(minStroops)} and {formatXlm(maxStroops)} XLM · up to 7 decimal places.
          </p>
        )}
      </div>

      <div className="panel-flat flex items-center justify-between px-3.5 py-2.5 text-sm">
        <span className="text-muted">{demo ? "Demo duel" : "Prize pool"}</span>
        <span className="flex items-center gap-2">
          {demo ? <Badge tone="neutral">No stake</Badge> : null}
          <span className="numeric font-semibold">
            {demo || split === null ? "—" : `${formatXlm(split.payout + split.fee)} XLM`}
          </span>
        </span>
      </div>
      {!demo ? (
        <p className="text-xs text-dim">
          {split === null ? (
            "Enter a valid amount to see the payout split."
          ) : (
            <>
              Winner receives {formatXlm(split.payout)} XLM · protocol fee {formatXlm(split.fee)} XLM (
              {ECONOMY.feeBps / 100}%).
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
