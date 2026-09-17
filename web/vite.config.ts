import { defaultClientConditions, loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { sites } from "@openai/sites-vite-plugin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const rawBase = env.VITE_BASE_PATH || "/";
  const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

  return {
    base,
    plugins: [react(), sites()],
    // WASMはgeneratedに一元化 / WASM统一从generated目录加载，避免重复打包。
    resolve: { conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions] },
    optimizeDeps: {
      include: ["@mediapipe/tasks-vision", "onnxruntime-web/webgpu"],
    },
    build: {
      outDir: "dist/client",
      sourcemap: false,
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(moduleId) {
            return /node_modules\/(?:react|react-dom)\//.test(moduleId)
              ? "react"
              : undefined;
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
      },
    },
  };
});
