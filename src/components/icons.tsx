import type { SVGProps } from "react";

const PATHS = {
  play: "M9 5.5 18 12l-9 6.5V5.5Z",
  pause: "M8 5v14M16 5v14",
  gamepad: "M7 7h10c2 0 3.1 1.6 3.5 3.6l1 5.1c.4 2.2-1.8 3.4-3.4 2l-2.3-2H8.2l-2.3 2c-1.6 1.4-3.8.2-3.4-2l1-5.1C3.9 8.6 5 7 7 7ZM6 11h4m-2-2v4m8-2h.01m2 2h.01",
  users: "M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7v-1.5A3.5 3.5 0 0 1 6.5 14h5a3.5 3.5 0 0 1 3.5 3.5V19m1-13.8a3.5 3.5 0 0 1 0 6.6M18 14a3.5 3.5 0 0 1 3 3.5V19",
  trophy: "M8 3h8v5a4 4 0 0 1-8 0V3Zm0 2H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 1v6m-4 3h8m-6-3h4v3h-4v-3Z",
  user: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2H5Z",
  book: "M12 5C9.3 3.5 6.3 3.3 3 4v15c3.3-.7 6.3-.5 9 1 2.7-1.5 5.7-1.7 9-1V4c-3.3-.7-6.3-.5-9 1Zm0 0v15",
  transactions: "M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4",
  wallet: "M19 7H5a2 2 0 0 1 0-4h12v4m2 0a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5m18 6h-6v6h6m-3-3h.01",
  menu: "M5 6h14M5 12h14M5 18h14",
  close: "m6 6 12 12M18 6 6 18",
  chevron: "m8 10 4 4 4-4",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  clock: "M12 8v5l3 2m-3 7a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-20h6",
  layers: "m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5",
  shield: "m12 3 8 3v6c0 4-3.6 7.2-8 9-4.4-1.8-8-5-8-9V6l8-3Zm-4 9 3 3 5-6",
  cpu: "M7 7h10v10H7V7Zm3-5v5m4-5v5m-4 10v5m4-5v5M2 10h5m-5 4h5m10-4h5m-5 4h5M10 10h4v4h-4v-4Z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-5v2m-1-1h2",
  bolt: "m13 2-9 12h7l-1 8 10-13h-7l0-7Z",
  external: "M14 3h7v7m0-7L10 14m1-10H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6",
  check: "m5 12 4 4L19 6",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z",
  alert: "m12 3 10 17H2L12 3Zm0 6v5m0 3h.01",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-2-13h4l.6 2.5 2.1 1.2 2.5-.7 2 3.5-1.9 1.8v2.4l1.9 1.8-2 3.5-2.5-.7-2.1 1.2-.6 2.5h-4L9.4 19l-2.1-1.2-2.5.7-2-3.5 1.9-1.8v-2.4L2.8 9l2-3.5 2.5.7L9.4 5l.6-2.5Z",
} as const;

export type IconName = keyof typeof PATHS;

/** One lightweight icon family; no extra runtime or icon dependency. */
export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      <path d={PATHS[name]} />
    </svg>
  );
}
