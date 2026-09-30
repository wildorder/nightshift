import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEV_PORT } from "./src/hostnames.js";

/**
 * The Studio's build (P11, D-P11-09): a static directory, served by CloudFront
 * when deployed and by Vite from this repository while developing it
 * (D-P11-01). The dev port is fixed because the `dev` stage's Studio client
 * registers `http://localhost:<port>/callback` exactly (T2).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/` is `src/`, as shadcn/ui's components import it (D-P13-08).
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: DEV_PORT },
  preview: { port: DEV_PORT },
  build: { outDir: "dist", emptyOutDir: true },
});
