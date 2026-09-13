import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // ws: the page's live socket (/api/ws/page/…) rides the same proxy
      "/api": { target: "http://127.0.0.1:9001", ws: true },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    allowedHosts: ["annotation.amogadgetlab.com"]
  }
});
