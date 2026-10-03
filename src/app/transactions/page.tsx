import { redirect } from "next/navigation";
import { Badge, EmptyState, ButtonLink, Panel, SectionHeader } from "@/components/ui";
import { TransactionItem } from "@/components/lists";
import { getSessionUser } from "@/lib/auth/session";
import { transactionsFor } from "@/lib/services/profile";
import { txExplorerUrl } from "@/lib/explorer";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  const transactions = await transactionsFor(session.user.id, 100);

  const confirmed = transactions.filter((tx) => tx.status === "confirmed").length;
  const pending = transactions.filter((tx) => tx.status !== "confirmed" && tx.status !== "failed").length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pt-2">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Ledger</p>
          <h1 className="text-display mt-2 text-4xl">Transactions</h1>
          <p className="mt-2 text-sm text-muted">
            Every entry, payout, refund and fee, with its Stellar Testnet transaction.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone="success">{confirmed} confirmed</Badge>
          {pending > 0 ? <Badge tone="warning">{pending} pending</Badge> : null}
        </div>
      </header>

      {transactions.length ? (
        <div className="flex flex-col gap-2">
          {transactions.map((tx) => (
            <div key={tx.id} className="flex flex-col gap-2">
              <TransactionItem tx={tx} />
              {tx.tx_hash && tx.status === "confirmed" ? (
                <a
                  href={txExplorerUrl(tx.tx_hash) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring numeric -mt-1 truncate px-1 text-[11px] text-dim hover:text-accent"
                >
                  {tx.tx_hash}
                </a>
              ) : null}
              {tx.error ? <p className="px-1 text-[11px] text-danger">{tx.error}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="◇"
          title="No transactions yet"
          description="Play a duel and your escrow, payout and fees will appear here with explorer links."
          action={<ButtonLink href="/play">Find a duel</ButtonLink>}
        />
      )}

      <Panel className="px-5 py-4 text-xs text-muted">
        <SectionHeader title="How to read this" />
        <p>
          Chain Duel shows a transaction as confirmed only after Stellar has included it in a ledger. Pending or failed
          transactions never count toward your balance.
        </p>
      </Panel>
    </div>
  );
}
