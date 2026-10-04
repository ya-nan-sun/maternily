import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: { port: webPort, proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
  build: { outDir: "dist", emptyOutDir: true },
});
