import "server-only";
import { publicStellarConfig, stellarNetwork, tokenContractId } from "../config/stellar";
import { financialNetwork, financialSymbol, type StellarFinancialContext } from "../stellar/shared";
import { ChainDuelError } from "../services/errors";

export interface StellarRequestContext { networkId?: unknown; currency?: unknown; tokenContractId?: unknown; }

/** The server chooses the asset and chain; the browser acknowledges both before
 * financial preparation. Historical games keep their original financial context. */
export function assertStellarRequest(body: StellarRequestContext, options: { game?: StellarFinancialContext; demo?: boolean } = {}) {
  const network = options.game ? financialNetwork(options.game) : stellarNetwork().id;
  const currency = options.game ? financialSymbol(options.game) : publicStellarConfig().asset.symbol;
  const token = options.game?.token_contract_id ?? tokenContractId(network);
  if ((body.networkId !== undefined && body.networkId !== `stellar-${network}`) || (body.currency !== undefined && body.currency !== currency) || (body.tokenContractId !== undefined && body.tokenContractId !== token)) throw new ChainDuelError("This request belongs to a different Stellar network or asset. Refresh before signing.", "wrong_financial_context", 409);
  if (network === "mainnet" && !options.demo && (body.networkId !== "stellar-mainnet" || body.currency !== "USDC")) throw new ChainDuelError("Refresh Chain Duel before preparing a Mainnet USDC stake.", "financial_context_required", 409);
}
