import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg", "node:sqlite"],
  images: {
    // The brand art is served at 92 so gradients and the emblem's metallic edges
    // stay crisp; 75 is Next's default and is noticeably soft on this artwork.
    qualities: [75, 92],
  },
  experimental: {
    optimizePackageImports: ["framer-motion", "@stellar/stellar-sdk"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
