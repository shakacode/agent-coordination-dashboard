import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { DEFAULT_PORT } from "./src/server/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${DEFAULT_PORT}`
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/client/testSetup.ts"]
  }
});
