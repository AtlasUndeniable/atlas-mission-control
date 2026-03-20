import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bind to localhost only — never expose externally
  serverExternalPackages: [],
};

export default nextConfig;
