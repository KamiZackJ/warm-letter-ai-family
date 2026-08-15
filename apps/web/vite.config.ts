import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolveWebRuntimeConfig } from "./src/runtime-config";

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, process.cwd(), "");
  const runtimeConfig = resolveWebRuntimeConfig({
    appEnv: process.env.VITE_APP_ENV || loaded.VITE_APP_ENV,
    apiBaseUrl: process.env.VITE_API_BASE_URL || loaded.VITE_API_BASE_URL,
    demoEnabled: process.env.VITE_DEMO_ENABLED || loaded.VITE_DEMO_ENABLED,
    expectedMode: mode,
  });

  return {
    define: {
      __WARM_LETTER_DEMO_BUILD__: JSON.stringify(runtimeConfig.demoEnabled),
    },
    plugins: [react()],
    publicDir: runtimeConfig.demoEnabled ? "../miniprogram/src/assets/demo" : false,
    server: {
      port: 4173,
    },
  };
});
