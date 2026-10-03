import { Panel } from "@/components/ui";

export const metadata = { title: "Privacy — Chain Duel" };

export default function PrivacyPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-2">
      <header>
        <p className="eyebrow">Legal</p>
        <h1 className="text-display mt-2 text-4xl">Privacy</h1>
      </header>
      <Panel className="flex flex-col gap-5 px-6 py-6 text-sm leading-relaxed text-muted">
        <section>
          <h2 className="text-base font-semibold text-ink">What we store</h2>
          <p className="mt-2">
            Your profile (username, avatar, theme), your linked public wallet addresses, your duel history, ratings,
            reputation, achievements and transaction records. If you sign in with Google or X we store the provider
            account identifier and, when the provider supplies it, your email.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">What we never store or expose</h2>
          <p className="mt-2">
            We never store a secret key for an external wallet. Managed wallet secrets are encrypted with AES-256-GCM
            and are never returned through an API, logged, or sent to the browser.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Blockchain data</h2>
          <p className="mt-2">
            Duel escrow and settlement happen on a public blockchain. Wallet addresses, amounts and transaction hashes
            are public by nature and linkable to your account.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Local storage</h2>
          <p className="mt-2">
            We keep your theme, sound preference and notification setting in your browser. We do not use third-party
            advertising trackers.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Deletion</h2>
          <p className="mt-2">
            You can disconnect at any time from Settings. On-chain records cannot be deleted, but your account and
            profile can be removed from the Chain Duel database on request.
          </p>
        </section>
      </Panel>
    </div>
  );
}
