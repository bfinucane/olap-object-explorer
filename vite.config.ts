import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The engine's CORS is OFF by default (see the handoff, §2), so the browser
 * must never talk to port 8080 directly. Instead the dev/preview server
 * proxies `/v1` to the engine, which makes the browser see a single origin:
 * no CORS, and no need to restart the engine with -Cors.
 *
 * Override the target with OLAP_ENGINE_URL if the engine runs elsewhere.
 */
const ENGINE = (process.env.OLAP_ENGINE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

const proxy = {
  '/v1': { target: ENGINE, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  define: {
    __ENGINE_TARGET__: JSON.stringify(ENGINE),
  },
  // Bind IPv4 explicitly: Vite's default `localhost` can end up on ::1 only on
  // Windows, which makes http://127.0.0.1:5182 unreachable for the browser.
  server: { host: '127.0.0.1', port: 5182, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 5182, strictPort: true, proxy },
  build: { outDir: 'dist' },
});
