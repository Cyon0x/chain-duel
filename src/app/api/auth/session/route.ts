import { fail, ok } from "@/lib/api/respond";
import { destroySession, getSessionUser } from "@/lib/auth/session";
import { accountWallet } from "@/lib/services/account-view";
import { persistenceMode } from "@/lib/db";
import { integrationStatus } from "@/lib/config/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionUser();
    if (!session) {
      return ok({
        authenticated: false,
        providers: integrationStatus(),
        persistence: await persistenceMode(),
      });
    }
    return ok({
      authenticated: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        provider: session.user.auth_provider,
        isAdmin: session.user.is_admin === 1,
      },
      profile: session.profile
        ? {
            username: session.profile.username,
            avatar: session.profile.avatar,
            theme: session.profile.theme,
            rating: session.profile.rating,
            reputation: session.profile.reputation,
            wins: session.profile.wins,
            losses: session.profile.losses,
            gamesPlayed: session.profile.games_played,
            onboardingComplete: session.profile.onboarding_complete === 1,
            currentStreak: session.profile.current_streak,
          }
        : null,
      wallet: accountWallet(session),
      providers: integrationStatus(),
      persistence: await persistenceMode(),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE() {
  try {
    await destroySession();
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
