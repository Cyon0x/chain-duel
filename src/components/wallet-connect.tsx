"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./ui";
import {
  connectWallet,
  disconnectWallet,
  signAuthMessage,
  walletError,
  WalletSignInError,
} from "@/lib/wallet/client";

type Status = "idle" | "connecting" | "signing" | "verifying" | "error";

export function WalletConnect({
  size = "md",
  label = "Connect wallet",
  onConnected,
}: {
  size?: "sm" | "md" | "lg";
  label?: string;
  onConnected?: () => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const busy = status === "connecting" || status === "signing" || status === "verifying";

  const statusLabel = {
    idle: label,
    connecting: "Opening wallet…",
    signing: "Waiting for signature…",
    verifying: "Verifying…",
    error: "Try again",
  }[status];

  async function handleConnect() {
    setError(null);
    setStatus("connecting");
    try {
      const { address } = await connectWallet();
      setStatus("signing");
      const challengeResponse = await fetch("/api/auth/stellar/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = (await challengeResponse.json()) as { message?: string; error?: string };
      if (!challengeResponse.ok || !challenge.message) {
        throw new Error(challenge.error ?? "Could not start the sign-in challenge.");
      }

      const { signature, signerAddress } = await signAuthMessage(challenge.message, address);
      setStatus("verifying");
      const verifyResponse = await fetch("/api/auth/stellar/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, message: challenge.message, signature, signerAddress }),
      });
      const verified = (await verifyResponse.json()) as { error?: string; code?: string };
      if (!verifyResponse.ok) {
        throw new WalletSignInError(
          verified.error ?? "We could not verify that signature. Please try again.",
          verified.code ?? "signature_invalid",
        );
      }

      setStatus("idle");
      onConnected?.();
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setError(walletError(caught));
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-2">
      <Button onClick={handleConnect} loading={busy} size={size} variant="primary">
        {statusLabel}
      </Button>
      {error ? (
        <p role="alert" className="max-w-xs text-xs leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DisconnectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await disconnectWallet();
        await fetch("/api/auth/session", { method: "DELETE" });
        setBusy(false);
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
