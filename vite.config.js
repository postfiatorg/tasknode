import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const apiOrigin = process.env.TASKNODE_API_ORIGIN || "http://127.0.0.1:8080";

export default defineConfig({
  // Shared Context helpers use the native browser parser. Node uses parse5.
  resolve: {
    alias: { "./html-tree.js": fileURLToPath(new URL("./shared/html-tree.browser.js", import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-runtime",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "icon-runtime",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 20,
            },
            {
              name: "wallet-encoding",
              test: /node_modules[\\/](?:xrpl|ripple-[^\\/]+|@xrplf[\\/]|bignumber\.js[\\/]|fast-json-stable-stringify[\\/]|eventemitter3[\\/])/,
              priority: 10,
            },
            {
              name: "key-cryptography",
              test: /node_modules[\\/](?:@scure|@noble)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
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
