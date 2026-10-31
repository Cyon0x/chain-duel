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
    <Panel className="px-4 py-5 sm:px-6 sm:py-6">
      <SignInPanel providers={providers} initialError={error} heading="Enter Chain Duel" headingAs="h1" />
    </Panel>
  );
}
