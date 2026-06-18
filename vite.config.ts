import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4317"
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/client/testSetup.ts"]
  }
});
