import { notFound, redirect } from "next/navigation";
import { ArcSection } from "@/components/arc/section";
import { getSessionUser } from "@/lib/auth/session";
export const dynamic = "force-dynamic";
export default async function ArcPage({ params }: { params: Promise<{ path?: string[] }> }) {
  const path = (await params).path ?? ["dashboard"];
  const section = path[0];
  if (
    !["dashboard", "wallet", "play", "transactions", "profile", "leaderboard", "match"].includes(section) ||
    path.length > (section === "match" ? 2 : 1)
  )
    notFound();
  if (section === "match" && !path[1]) notFound();
  const session = await getSessionUser();
  if (section === "match" && !session) redirect("/arc/login");
  return <ArcSection section={section} id={path[1]} />;
}
