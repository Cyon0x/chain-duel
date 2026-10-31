import { PULSE_DUEL } from "@/lib/config/game";

export function TargetLegend({ className = "" }: { className?: string }) {
  return (
    <ul className={`target-legend ${className}`} aria-label="Target points">
      {PULSE_DUEL.targets.map(({ kind, points }) => (
        <li key={kind}>
          <span className={`target-legend__dot target-legend__dot--${kind}`} aria-hidden />
          <span className="capitalize">{kind}</span>
          <strong className="numeric">{points > 0 ? "+" : "−"}{Math.abs(points)}</strong>
        </li>
      ))}
    </ul>
  );
}

export function ArenaOrbits() {
  return (
    <svg className="arena-orbits" viewBox="0 0 720 400" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="orbit-light" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#8deaff" stopOpacity=".06" />
          <stop offset=".45" stopColor="#8deaff" stopOpacity=".42" />
          <stop offset="1" stopColor="#8deaff" stopOpacity=".08" />
        </linearGradient>
      </defs>
      <g className="arena-orbits__rings" fill="none" stroke="url(#orbit-light)">
        <ellipse cx="360" cy="218" rx="297" ry="105" />
        <ellipse cx="360" cy="218" rx="239" ry="83" />
        <ellipse cx="360" cy="218" rx="159" ry="54" />
        <path d="M57 218h70m466 0h70M360 106v31m0 162v31" strokeOpacity=".5" />
      </g>
    </svg>
  );
}
