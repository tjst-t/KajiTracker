import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // banto の公開機能で付く URL から開けるようにする
    allowedHosts: true,
  },
});
