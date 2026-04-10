import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env["PORT"] ?? 5173),
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: {
      clientPort: 443,
    },
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
    proxy: {
      "/api": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:8082",
        changeOrigin: true,
      },
      "/v1": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:8082",
        changeOrigin: true,
      },
    },
  },
});
