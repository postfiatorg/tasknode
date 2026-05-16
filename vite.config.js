import { defineConfig } from "vite";

const apiOrigin = process.env.TASKNODE_API_ORIGIN || "http://127.0.0.1:8080";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: Number(process.env.VITE_DEV_PORT || 5174),
    strictPort: true,
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: false,
      },
      "/health": {
        target: apiOrigin,
        changeOrigin: false,
      },
      "/runtime-config.js": {
        target: apiOrigin,
        changeOrigin: false,
      },
      "/runtime-config.json": {
        target: apiOrigin,
        changeOrigin: false,
      },
    },
  },
});
