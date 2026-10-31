import Image from "next/image";
import Link from "next/link";
import { ButtonLink } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { LandingPreview } from "@/components/landing/preview";
import { LandingActivity, LandingDuels } from "@/components/landing/activity";
import { DuelModeLinks } from "@/components/play/mode-links";
import { getSessionUser } from "@/lib/auth/session";
import { publicStellarConfig } from "@/lib/config/stellar";
import { ECONOMY, PULSE_DUEL, formatXlm, splitPool } from "@/lib/config/game";
import brandLockup from "@/assets/brand/chain-duel-horizontal.png";
import styles from "./home.module.css";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getSessionUser();
  const network = publicStellarConfig();
  const pool = ECONOMY.defaultEntryStroops * 2;
  const { payout } = splitPool(pool, ECONOMY.feeBps);
  const stats: { label: string; value: string; unit?: string; icon: IconName }[] = [
    { label: "Duel length", value: `${PULSE_DUEL.durationMs / 1000}s`, icon: "clock" },
    { label: "Default entry", value: formatXlm(ECONOMY.defaultEntryStroops), unit: "XLM", icon: "layers" },
    { label: "Prize pool", value: formatXlm(pool), unit: "XLM", icon: "trophy" },
  ];

  return (
    <div className={styles.home}>
      <section className={styles.world} aria-labelledby="home-title">
        <Image src="/art/arena-world.webp" alt="" aria-hidden fill preload sizes="(max-width: 767px) 100vw, 1320px" className={styles.art} />
        <div className={styles.scrim} aria-hidden />
        <div className={styles.hero}>
          <div className={styles.copy}>
            <p className={styles.season}><span className={styles.seasonDot} aria-hidden />{network.label} · Season 0</p>
            <Image src={brandLockup} alt="Chain Duel" preload quality={92} sizes="(max-width: 767px) 250px, 420px" className={styles.brand} />
            <h1 id="home-title" className={styles.headline}>Compete. React. Duel.</h1>
            <p className={styles.description}>A 60-second 1v1 arcade game. Same targets. Highest verified score wins. Entries escrowed on Stellar.</p>
            <div className={styles.actions}>
              <ButtonLink href={session ? "/play" : "/login"} size="lg"><Icon name="play" size={17} />Enter the arena</ButtonLink>
              <ButtonLink href="/how-to-play" size="lg" variant="secondary"><Icon name="book" size={17} />How it works</ButtonLink>
            </div>
          </div>
          <div className={styles.preview}><LandingPreview /></div>
          <dl className={styles.stats}>
            {stats.map(({ label, value, unit, icon }) => (
              <div key={label} className={styles.stat}><dt className={styles.statLabel}><Icon name={icon} size={15} />{label}</dt><dd className={styles.statValue}>{value}{unit ? <small> {unit}</small> : null}</dd></div>
            ))}
          </dl>
        </div>
        <div className={styles.economy}>
          <span><Icon name="shield" size={14} />Default winner reward {formatXlm(payout)} XLM · {ECONOMY.feeBps / 100}% protocol fee</span>
          <Link href="/transactions" className="focus-ring">Settled on {network.label}<Icon name="external" size={13} /></Link>
        </div>
      </section>

      <section aria-labelledby="modes-heading">
        <div className={styles.sectionHeading}><h2 id="modes-heading">Choose your duel</h2><p>One game. Your kind of opponent.</p></div>
        <DuelModeLinks />
      </section>

      <LandingDuels />
      <LandingActivity />

      <section className={styles.flow} aria-labelledby="flow-heading">
        <div className={styles.sectionHeading}><h2 id="flow-heading">From entry to victory</h2><Link className="focus-ring inline-flex min-h-10 items-center gap-2 text-sm text-accent" href="/how-to-play">How to play<Icon name="arrow" size={15} /></Link></div>
        <ol className={styles.flowSteps}>
          {[
            { title: "Pick your opponent", body: "Join the online queue, invite a friend, or face VEX-7. Choose your entry before you play." },
            { title: "Lock your entry", body: "Entries are held in the Soroban escrow contract. Demo duels let you practise without a stake." },
            { title: "React. Then settle.", body: "Hit blue and gold. Avoid red. Your event log is verified before the winner is paid on Stellar." },
          ].map((step, index) => <li key={step.title} className={styles.flowStep}><span className={styles.stepNumber}>{index + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>)}
        </ol>
      </section>
    </div>
  );
}
