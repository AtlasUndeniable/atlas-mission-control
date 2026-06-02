import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bind to localhost only — never expose externally
  serverExternalPackages: [],
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
};

export default nextConfig;
