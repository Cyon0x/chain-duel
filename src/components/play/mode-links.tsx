import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";

const MODES: { href: string; title: string; body: string; tag: string; icon: IconName }[] = [
  { href: "/play/online", title: "Play online", body: "Find an opponent at your entry. Same targets, same clock.", tag: "Matchmaking", icon: "gamepad" },
  { href: "/play/friend", title: "Duel a friend", body: "Create a private duel and share your invitation link.", tag: "Private duel", icon: "users" },
  { href: "/play/computer", title: "Face VEX-7", body: "Take on the computer. A real opponent, on the same engine.", tag: "Vs computer", icon: "cpu" },
];

export function DuelModeLinks() {
  return (
    <div className="duel-mode-links">
      {MODES.map(({ href, title, body, tag, icon }) => (
        <Link key={href} href={href} className="duel-mode-link focus-ring">
          <span className="duel-mode-link__icon"><Icon name={icon} size={24} /></span>
          <span className="duel-mode-link__copy"><span className="duel-mode-link__tag">{tag}</span><strong>{title}</strong><span className="duel-mode-link__description">{body}</span></span>
          <Icon name="arrow" className="duel-mode-link__arrow" size={18} />
        </Link>
      ))}
    </div>
  );
}
