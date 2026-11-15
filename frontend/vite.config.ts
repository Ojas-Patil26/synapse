import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js (via its buffer dependency) expects a Node-style `global`.
  define: { global: "globalThis" },
  server: { port: 5173, strictPort: true },
});
