import "server-only";
import type { SessionUser } from "../auth/session";

export function accountWallet(session: SessionUser) {
  const wallet = session.primaryWallet;
  if (!wallet) return null;
  // The custody mode is safe to expose. Key material never is.
  return {
    address: wallet.address,
    provider: wallet.provider,
    custody: wallet.custody,
    network: wallet.network,
    label: wallet.label,
  };
}
