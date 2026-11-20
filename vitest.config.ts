import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    // Unit tests only — they must never touch the network or a live database.
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
