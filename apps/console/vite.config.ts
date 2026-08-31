import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:8787", changeOrigin: true },
      "/health": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
