import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Remove 'output: "export"' — it disables the dev server and API routes.
  // For static export (Vercel/Cloudflare Pages), add it back for production builds.
  devIndicators: false,
  allowedDevOrigins: [
    process.env.REPLIT_DEV_DOMAIN,
    "127.0.0.1",
    "localhost",
  ].filter((origin): origin is string => Boolean(origin)),
};

export default nextConfig;
