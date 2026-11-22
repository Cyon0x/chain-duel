"use client";
import { useState, useEffect, useCallback } from "react";
import { Icon } from "../icons";
import { Panel, Button, ButtonLink } from "../ui";
import type { bridgeAvailability } from "@/lib/bridge/config";
import type { publicArcConfig } from "@/lib/arc/config";
import type { quoteBridge, bridgeView, prepareBridgeStep } from "@/lib/bridge/service";
import type { BridgeRow, BridgePhase } from "@/lib/bridge/types";
import { BRIDGE_LABELS } from "@/lib/bridge/status";
import { arcBody, arcFetch, executeCircle } from "../arc/client";
import { formatUnits } from "viem";
type Quote = Awaited<ReturnType<typeof quoteBridge>>;
type View = Awaited<ReturnType<typeof bridgeView>>;
type Prepared = Awaited<ReturnType<typeof prepareBridgeStep>>;
const PHASES: Record<BridgePhase, string> = {
  trustline: "Create Stellar USDC trustline",
  source_approval: "Approve USDC allowance",
  source_burn: "Burn source USDC",
  destination_mint: "Mint destination USDC",
};
export function BridgePanel({ availability }: { availability: ReturnType<typeof bridgeAvailability> }) {
  const [source, setSource] = useState<"stellar" | "arc">("stellar");
  const [amount, setAmount] = useState("");
  const [data, setData] = useState<{
    arc: ReturnType<typeof publicArcConfig>;
    signedIn: boolean;
    transfers: BridgeRow[];
  } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(
    async <T,>(extra: Record<string, unknown>) => {
      if (!data) throw new Error("Wait for the bridge connection to load.");
      return arcFetch<T>("/api/bridge", {
        method: "POST",
        body: arcBody(data.arc.networkId, extra),
      });
    },
    [data],
  );
  const reload = useCallback(async () => {
    setData(await arcFetch("/api/bridge"));
  }, []);
  useEffect(() => {
    void arcFetch<NonNullable<typeof data>>("/api/bridge")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (!availability.enabled || !view || ["completed", "failed"].includes(view.transfer.status)) return;
    const timer = setInterval(() => {
      void request<View>({ action: "refresh", id: view.transfer.id })
        .then(setView)
        .catch((e) => setError((e as Error).message));
    }, 8000);
    return () => clearInterval(timer);
  }, [availability.enabled, view, request]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review() {
    const result = await request<{ quote: Quote }>({
      action: "quote",
      source,
      amount,
    });
    setQuote(result.quote);
    setPrepared(null);
  }
  async function saveTransfer() {
    const result = await request<{ transfer: BridgeRow }>({
      action: "create",
      source,
      amount,
      idempotencyKey: crypto.randomUUID(),
    });
    setView(await request<View>({ action: "refresh", id: result.transfer.id }));
    setQuote(null);
    await reload();
  }
  async function prepare() {
    if (!view?.nextPhase) return;
    const result = await request<{ prepared: Prepared }>({
      action: "prepare",
      id: view.transfer.id,
      phase: view.nextPhase,
    });
    setPrepared(result.prepared);
  }
  async function approve() {
    if (!view || !prepared) return;
    const result = await request<Parameters<typeof executeCircle>[0]>({
      action: "approve",
      id: view.transfer.id,
      stepId: prepared.stepId,
    });
    await executeCircle(result);
    setPrepared(null);
    setView(await request<View>({ action: "refresh", id: view.transfer.id }));
    await reload();
  }
  function txUrl(network: string, hash: string) {
    return network.startsWith("arc-")
      ? `${data?.arc.explorer}/tx/${hash}`
      : `https://${network.endsWith("testnet") ? "stellar.expert/explorer/testnet" : "stellar.expert/explorer/public"}/tx/${hash.replace(/^0x/, "")}`;
  }
  const destination = source === "stellar" ? "arc" : "stellar";
  return (
    <div className="arc-section">
      <header className="arc-section__header">
        <div>
          <p className="eyebrow">Chain Duel · Cross-chain USDC</p>
          <h1 className="text-display">Connect your ecosystems</h1>
          <p>
            Move USDC between Stellar and Arc through Circle’s official burn-and-mint infrastructure when the
            complete route is available.
          </p>
        </div>
        <span className="arc-network-label">
          <Icon name="swap" size={18} />
          USDC ↔ USDC
        </span>
      </header>
      <p className="arc-notice" role="status">
        {availability.reason}
      </p>
      {error ? (
        <p className="arc-notice" role="alert">
          {error}
        </p>
      ) : null}
      <div className="arc-wallet-grid">
        <Panel className="arc-card">
          <h2>Stellar ↔ Arc</h2>
          <label className="arc-label" htmlFor="bridge-source">
            From
          </label>
          <select
            id="bridge-source"
            className="arc-input"
            value={source}
            onChange={(event) => {
              setSource(event.target.value as "stellar" | "arc");
              setQuote(null);
            }}
          >
            <option value="stellar">{availability.stellarNetwork} · USDC</option>
            <option value="arc">{availability.arcNetwork} · USDC</option>
          </select>
          <label className="arc-label" htmlFor="bridge-destination">
            To
          </label>
          <input
            id="bridge-destination"
            className="arc-input"
            readOnly
            value={`${destination === "stellar" ? availability.stellarNetwork : availability.arcNetwork} · USDC`}
          />
          <label className="arc-label" htmlFor="bridge-amount">
            Amount · USDC
          </label>
          <input
            id="bridge-amount"
            className="arc-input numeric"
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setQuote(null);
            }}
            placeholder="0.00"
          />
          <p>
            {availability.enabled
              ? "Review Circle’s current fee, then approve each transaction separately."
              : "Available balance and fee estimates will load when this transfer route is active."}
          </p>
          <Button
            disabled={!availability.enabled || !data?.signedIn || busy || !amount}
            onClick={() => void run(review)}
          >
            {availability.enabled ? (busy ? "Loading…" : "Review transfer") : "Review transfer · unavailable"}
          </Button>
          {availability.enabled && !data?.signedIn ? (
            <ButtonLink href="/arc/login">Sign in to transfer</ButtonLink>
          ) : null}
          {quote ? (
            <div className="arc-section">
              <h3>Review {quote.amount} USDC</h3>
              <p>
                Available: {quote.availableBalance ?? "unavailable"} USDC. Circle fee: up to {quote.maxFee}{" "}
                USDC. Receive at least {quote.minimumReceived} USDC.
              </p>
              <p>{quote.gasNotice}</p>
              <p>{quote.finality}</p>
              {!quote.stellar.accountExists ? (
                <p className="arc-notice">
                  Fund {quote.stellar.address} with XLM on {quote.stellar.networkName} to activate the account
                  before continuing.
                </p>
              ) : !quote.stellar.trustline ? (
                <p className="arc-notice">
                  A Stellar USDC trustline needs your approval before the source burn.
                </p>
              ) : null}
              <p className="arc-address">To: {quote.destinationAddress}</p>
              <Button disabled={busy} onClick={() => void run(saveTransfer)}>
                Continue to transaction approvals
              </Button>
            </div>
          ) : null}
        </Panel>
        <Panel className="arc-card">
          <h2>{availability.enabled ? "Your transfer" : "When transfers are available"}</h2>
          <p>
            Circle supports USDC transfers between Stellar and Arc. Chain Duel will activate this route after
            both directions are ready and verified.
          </p>
          <p>
            Current environments: {availability.stellarNetwork} and {availability.arcNetwork}.
          </p>
          {availability.stellarGamingNetwork !== availability.stellarNetwork ? (
            <p>
              Your XLM games continue on {availability.stellarGamingNetwork}. Stellar USDC transfers use{" "}
              {availability.stellarNetwork}.
            </p>
          ) : null}
          <p>
            Every transfer requires your approval. Switching networks never moves funds. A source confirmation
            alone never counts as a completed transfer.
          </p>
          <div className="arc-actions">
            <ButtonLink href="/arc/wallet" variant="secondary">
              Arc wallet
            </ButtonLink>
            <a
              className="focus-ring text-sm text-accent"
              href={availability.documentation}
              target="_blank"
              rel="noreferrer"
            >
              Circle transfer documentation
            </a>
          </div>
        </Panel>
      </div>
      {view ? (
        <Panel className="arc-card">
          <h2>{BRIDGE_LABELS[view.transfer.status]}</h2>
          <p>
            {formatUnits(BigInt(view.transfer.amount_units), 6)} USDC · {view.transfer.source_network} →{" "}
            {view.transfer.destination_network}
          </p>
          {view.transfer.error ? (
            <p className="arc-notice" role="status">
              {view.transfer.error}
            </p>
          ) : null}
          {view.steps.map((step) => (
            <p key={step.id}>
              {PHASES[step.phase]} · {step.status}
              {step.tx_hash ? (
                <>
                  {" "}
                  ·{" "}
                  <a
                    className="focus-ring text-accent"
                    href={txUrl(step.network_id, step.tx_hash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction
                  </a>
                </>
              ) : null}
            </p>
          ))}
          {view.transfer.destination_tx_hash ? (
            <p>
              <a
                className="focus-ring text-accent"
                href={txUrl(view.transfer.destination_network, view.transfer.destination_tx_hash)}
                target="_blank"
                rel="noreferrer"
              >
                Destination settlement
              </a>
            </p>
          ) : null}
          {prepared ? (
            <div className="arc-section">
              <h3>{PHASES[prepared.phase]}</h3>
              <p>
                Network: {prepared.networkId}. Estimated network fee:{" "}
                {prepared.gasFeeUnits && prepared.gasDecimals !== null
                  ? formatUnits(BigInt(prepared.gasFeeUnits), prepared.gasDecimals)
                  : "unavailable"}{" "}
                {prepared.gasSymbol}.
              </p>
              <p className="arc-address">Contract: {prepared.target}</p>
              {prepared.phase === "source_burn" ? (
                <p>
                  Burning removes source USDC. Continue with attestation and destination mint to finish this
                  transfer.
                </p>
              ) : null}
              <Button disabled={busy || !availability.enabled} onClick={() => void run(approve)}>
                Approve {PHASES[prepared.phase].toLowerCase()}
              </Button>
            </div>
          ) : view.nextPhase ? (
            <Button disabled={busy || !availability.enabled} onClick={() => void run(prepare)}>
              Review: {PHASES[view.nextPhase]}
            </Button>
          ) : null}
          <div className="arc-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setView(
                    await request<View>({
                      action: "refresh",
                      id: view.transfer.id,
                    }),
                  );
                })
              }
            >
              Refresh status
            </Button>
            {!view.transfer.source_tx_hash &&
            !view.steps.some((s) => s.phase === "source_burn") &&
            view.transfer.status !== "failed" ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setView(
                      await request<View>({
                        action: "cancel",
                        id: view.transfer.id,
                      }),
                    );
                    setPrepared(null);
                    await reload();
                  })
                }
              >
                Cancel before burn
              </Button>
            ) : null}
          </div>
          {view.transfer.message && view.transfer.status !== "completed" ? (
            <div className="arc-section">
              <label className="arc-label" htmlFor="bridge-recovery">
                Already minted externally? Destination transaction hash
              </label>
              <input
                id="bridge-recovery"
                className="arc-input"
                value={recoveryHash}
                onChange={(e) => setRecoveryHash(e.target.value)}
              />
              <Button
                variant="secondary"
                disabled={busy || !recoveryHash}
                onClick={() =>
                  void run(async () => {
                    setView(
                      await request<View>({
                        action: "recover",
                        id: view.transfer.id,
                        transactionHash: recoveryHash,
                      }),
                    );
                    await reload();
                  })
                }
              >
                Verify destination settlement
              </Button>
            </div>
          ) : null}
        </Panel>
      ) : null}
      {data?.transfers.length ? (
        <Panel className="arc-card">
          <h2>USDC transfer history</h2>
          {data.transfers.map((transfer) => (
            <div className="arc-actions" key={transfer.id}>
              <p>
                {formatUnits(BigInt(transfer.amount_units), 6)} USDC · {BRIDGE_LABELS[transfer.status]}
              </p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setPrepared(null);
                    setView(
                      await request<View>({
                        action: "refresh",
                        id: transfer.id,
                      }),
                    );
                  })
                }
              >
                View transfer
              </Button>
            </div>
          ))}
        </Panel>
      ) : null}
    </div>
  );
}
