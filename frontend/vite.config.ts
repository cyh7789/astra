import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 開發時 API 走 Fastify（npm run server，port 8787）
    proxy: { "/api": "http://localhost:8787" },
  },
});
