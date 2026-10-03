"use client";

import { Panel } from "@/components/ui";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import type { AuthProviders } from "@/components/auth/types";

/**
 * `/login` renders the same chooser as the header modal, so there is exactly
 * one sign-in implementation to keep correct.
 */
export function AuthPanel({
  providers,
  error,
}: {
  providers: AuthProviders;
  error?: string;
}) {
  return (
    <Panel className="px-6 py-7">
      <SignInPanel providers={providers} initialError={error} heading="Enter Chain Duel" />
    </Panel>
  );
}
