import { defineConfig } from "vite";

// Vite is just our dev server / static asset handler.
// Tauri loads from this during dev, and from the built dist/ in production.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: {
      protocol: "ws",
      host: "127.0.0.1",
      port: 1421,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
