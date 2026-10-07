"use client";

import { QRCodeSVG } from "qrcode.react";

/**
 * Renders the arena invite URL as a scannable QR code, generated entirely
 * client-side (no external QR service). The payload is always the exact public
 * arena URL — never any token, session or secret — so scanning it opens the
 * same invite the Copy/Share buttons hand out.
 */
export function ArenaQrCode({ url, size = 208 }: { url: string; size?: number }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-3xl border border-line-strong bg-accent-soft p-3 shadow-[0_20px_45px_-30px_var(--accent-glow)]">
        <div className="rounded-2xl bg-[#f5f9ff] p-3">
          <QRCodeSVG
            value={url}
            size={size}
            level="M"
            marginSize={0}
            bgColor="#f5f9ff"
            fgColor="#0a1120"
            title="Chain Duel arena invite link"
            aria-label={`QR code to join arena: ${url}`}
            style={{ width: "100%", height: "auto", display: "block" }}
            className="h-auto w-full max-w-[208px]"
          />
        </div>
      </div>
      <p className="text-center text-xs text-muted">Scan to join this arena</p>
    </div>
  );
}
