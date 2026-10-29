import { defineConfig } from "vite";

/**
 * The frontend is a static bundle with no server-side rendering and no runtime framework.
 * It is built into `dist/web`, which the Express app serves as static assets.
 *
 * In development the Vite dev server proxies `/api` to the backend so the browser sees a
 * single origin and no CORS configuration is needed.
 */
const BACKEND_ORIGIN = process.env.HOMELABMD_DEV_BACKEND ?? "http://127.0.0.1:3000";

export default defineConfig({
  root: "src/web",
  publicDir: false,
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: BACKEND_ORIGIN,
        changeOrigin: false,
      },
    },
  },
});
