"use client";

import clsx from "clsx";
import Link from "next/link";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink hover:brightness-110 shadow-[0_14px_40px_-18px_var(--accent-glow)] border border-transparent",
  secondary:
    "bg-surface-strong text-ink border border-line-strong hover:border-accent hover:bg-surface",
  ghost: "bg-transparent text-muted border border-transparent hover:text-ink hover:bg-surface",
  danger: "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-[13px] rounded-xl",
  md: "h-11 px-5 text-sm rounded-2xl",
  lg: "h-14 px-7 text-base rounded-2xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        "focus-ring inline-flex select-none items-center justify-center gap-2 font-semibold tracking-tight transition-all duration-150",
        "active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "focus-ring inline-flex select-none items-center justify-center gap-2 font-semibold tracking-tight transition-all duration-150 active:translate-y-[1px]",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {children}
    </Link>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          "focus-ring h-11 w-full rounded-2xl border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-dim",
          "transition-colors focus:border-accent",
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function Panel({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "aside";
}) {
  return <Tag className={clsx("panel p-5", className)}>{children}</Tag>;
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "danger" | "warning" | "gold";
  className?: string;
}) {
  const tones = {
    neutral: "border-line-strong text-muted",
    accent: "border-accent/45 text-accent bg-accent-soft",
    success: "border-success/40 text-success",
    danger: "border-danger/40 text-danger",
    warning: "border-warning/40 text-warning",
    gold: "border-gold/40 text-gold",
  } as const;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "accent" | "success" | "danger";
}) {
  const tones = {
    default: "text-ink",
    accent: "text-accent",
    success: "text-success",
    danger: "text-danger",
  } as const;
  return (
    <div className="panel-flat px-4 py-3.5">
      <p className="eyebrow">{label}</p>
      <p className={clsx("numeric mt-2 text-2xl font-semibold", tones[tone])}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-dim">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = "◇",
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="panel-flat flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span aria-hidden className="text-2xl text-accent/70">
        {icon}
      </span>
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      {action}
    </div>
  );
}

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 px-1 py-6 text-sm text-muted" role="status">
      <Spinner className="text-accent" />
      <span>{label}…</span>
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-14 animate-pulse rounded-2xl border border-line bg-surface"
          style={{ animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = "accent",
  className,
}: {
  value: number;
  tone?: "accent" | "danger";
  className?: string;
}) {
  const clamped = Math.min(Math.max(value, 0), 1);
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-surface-strong", className)}>
      <div
        className={clsx("h-full rounded-full transition-[width] duration-200", tone === "accent" ? "bg-accent" : "bg-danger")}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

export function Avatar({
  name,
  src,
  size = 40,
  theme,
}: {
  name: string;
  src?: string | null;
  size?: number;
  theme?: string | null;
}) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-line-strong bg-surface-strong font-semibold tracking-tight"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      data-theme={theme ?? undefined}
      aria-hidden
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-muted">{initials}</span>
      )}
    </span>
  );
}

export function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
