import { Panel } from "@/components/ui";

export const metadata = { title: "Terms — Chain Duel" };

export default function TermsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-2">
      <header>
        <p className="eyebrow">Legal</p>
        <h1 className="text-display mt-2 text-4xl">Terms of use</h1>
        <p className="mt-3 text-sm text-dim">Last updated · Chain Duel Season 0</p>
      </header>
      <Panel className="flex flex-col gap-5 px-6 py-6 text-sm leading-relaxed text-muted">
        <p>
          Chain Duel is an experimental skill-based arcade game running on Stellar Testnet. By using it you agree to the
          terms below.
        </p>
        <section>
          <h2 className="text-base font-semibold text-ink">Experimental software</h2>
          <p className="mt-2">
            The game, smart contract and backend are provided as-is, without warranty. Testnet assets carry no
            real-world value and may be reset by the network at any time.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Your account</h2>
          <p className="mt-2">
            You are responsible for the wallet you connect. Chain Duel never asks for and never stores your secret key
            for an external wallet. Managed wallets created for social sign-in are encrypted at rest and used only to
            sign escrow transactions on your behalf.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Fair play</h2>
          <p className="mt-2">
            Automated play, exploiting the client, or attempting to forge results is prohibited. Submissions that fail
            server verification are rejected and repeated abuse may lead to account suspension.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Fees</h2>
          <p className="mt-2">
            The protocol retains a fee, by default 10% (1000 basis points) of the prize pool, on settled human duels.
            The fee is configurable in the contract and always disclosed before you enter a duel.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Changes</h2>
          <p className="mt-2">
            Features, configuration and these terms may change as the project evolves. Continued use constitutes
            acceptance of the updated terms.
          </p>
        </section>
      </Panel>
    </div>
  );
}
