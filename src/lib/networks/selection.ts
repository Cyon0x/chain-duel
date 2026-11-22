import "server-only";
import { cookies } from "next/headers";
export const NETWORK_COOKIE = "cd_ecosystem";
export async function selectedEcosystem(): Promise<"stellar" | "arc"> {
  return (await cookies()).get(NETWORK_COOKIE)?.value === "arc" ? "arc" : "stellar";
}
