/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves the app from /folderpilot/; locally and on Vercel it lives at /.
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  // In development the API runs on :3000; proxying keeps cookies same-origin.
  server: {
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3000", changeOrigin: false } },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "FolderPilot",
        short_name: "FolderPilot",
        description: "Organize, find and clean the files on your own computer.",
        theme_color: "#0F766E",
        background_color: "#FAFAF7",
        display: "standalone",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
  },
});
