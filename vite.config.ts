import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    // npm 便携包的构建产物里带有源码副本，不应被重复收集为测试。
    exclude: [...configDefaults.exclude, "**/.npm-packages/**"],
  },
  server: {
    // 保留浏览器原始 Host/Origin，服务端同源校验依赖两者一致
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/uploads": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["recharts"],
          motion: ["framer-motion"],
        },
      },
    },
  },
});
