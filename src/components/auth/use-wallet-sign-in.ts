"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import {
  connectWallet,
  signAuthMessage,
  walletError,
  WalletSignInError,
} from "@/lib/wallet/client";

export type WalletSignInStatus = "idle" | "connecting" | "signing" | "verifying" | "error";

/**
 * The wallet half of sign-in: connect → sign the server challenge → verify.
 * Shared by the header modal and the standalone auth panel so there is exactly
 * one implementation of the flow.
 */
export function useWalletSignIn(onConnected?: () => void) {
  const router = useRouter();
  const [status, setStatus] = useState<WalletSignInStatus>("idle");
  const [pendingWallet, setPendingWallet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(
    async (walletId?: string) => {
      setError(null);
      setPendingWallet(walletId ?? null);
      setStatus("connecting");
      try {
        const { address } = await connectWallet(walletId);

        setStatus("signing");
        const challengeResponse = await fetch("/api/auth/stellar/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        });
        const challenge = (await challengeResponse.json()) as { message?: string; error?: string };
        if (!challengeResponse.ok || !challenge.message) {
          throw new WalletSignInError(
            challenge.error ?? "Could not start the sign-in challenge.",
            "challenge_failed",
          );
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
        // /dashboard forwards to /onboarding when the profile is incomplete.
        router.push("/dashboard");
        router.refresh();
      } catch (caught) {
        setError(walletError(caught));
        setStatus("error");
      } finally {
        setPendingWallet(null);
      }
    },
    [onConnected, router],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPendingWallet(null);
  }, []);

  return {
    status,
    error,
    pendingWallet,
    busy: status === "connecting" || status === "signing" || status === "verifying",
    signIn,
    reset,
  };
}

export const WALLET_STATUS_LABEL: Record<WalletSignInStatus, string> = {
  idle: "",
  connecting: "Opening wallet…",
  signing: "Waiting for signature…",
  verifying: "Verifying…",
  error: "",
};
