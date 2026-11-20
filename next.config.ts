import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Demo mode (no Supabase configured) reads the policy corpus + mock orders
  // from disk at runtime. Make sure the serverless bundles include them.
  outputFileTracingIncludes: {
    "/api/*": ["./data/policies/**/*", "./data/mock-orders.json"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
