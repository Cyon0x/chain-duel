import { Panel, ButtonLink } from "@/components/ui";
import { arcGoogleConfigured } from "@/lib/arc/google";
import { arcXConfigured } from "@/lib/arc/x";
import { publicArcConfig } from "@/lib/arc/config";
export const dynamic = "force-dynamic";
export default async function ArcLogin({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const arc = publicArcConfig();
  return (
    <div className="arc-section">
      <header className="arc-section__header">
        <div>
          <p className="eyebrow">Chain Duel · {arc.name}</p>
          <h1 className="text-display">One account. Two ecosystems.</h1>
          <p>Sign in or sign up with Google or X. Circle will help you finish your Arc wallet setup.</p>
        </div>
      </header>
      <Panel className="arc-card">
        <h2>Enter Chain Duel</h2>
        {error ? (
          <p className="arc-notice" role="alert">
            {error}
          </p>
        ) : null}
        <div className="arc-actions">
          {arcGoogleConfigured() ? (
            <ButtonLink href="/api/arc/auth/google">Continue with Google</ButtonLink>
          ) : (
            <p>Google sign-in is currently unavailable.</p>
          )}
          {arcXConfigured() ? (
            <ButtonLink href="/api/arc/auth/x" variant="secondary">
              Continue with X
            </ButtonLink>
          ) : (
            <p>X sign-in is currently unavailable.</p>
          )}
        </div>
        <p>
          You authorize your wallet setup and transactions through Circle’s secure PIN flow. Your PIN and
          recovery answers stay with Circle.
        </p>
        <p>Your Chain Duel profile connects your Stellar and Arc histories.</p>
        <ButtonLink href="/arc/dashboard" variant="ghost">
          Explore Arc
        </ButtonLink>
      </Panel>
    </div>
  );
}
