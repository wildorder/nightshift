import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where the fixture preview listens; the screenshot script starts it here. */
export const PREVIEW_PORT = 5174;

/**
 * The fixture preview's dev server (P20, S-04): the real App over in-memory
 * stores seeded with a scenario, at `/preview.html`. It is a dev server only,
 * a separate config from `vite.config.ts`, so `npm run build` never sees
 * `preview.html` and `dist/` holds the Studio alone.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: PREVIEW_PORT, strictPort: true, host: "127.0.0.1" },
});
