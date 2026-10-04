import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Content-Security-Policy for the production build (a static app on any host, so a <meta> tag;
 * hosts that can send headers may add frame-ancestors on top). The app loads nothing from other
 * origins except files the user links to (connect-src https:), plays camera streams (mediastream:)
 * and object URLs (blob:), and runs its GIF encoder in a same-origin module worker. The dev
 * server is left alone: Vite's HMR client needs inline scripts and a websocket.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' https: blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'ascii-renderer:csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' }],
  };
}

// Static, client-only build: deployable to GitHub Pages / Vercel as plain files.
export default defineConfig({
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Font subsets stay files: inlined as base64 they would bloat the render-blocking CSS, and the
    // browser fetches a subset only when a page uses its characters (PERF-8).
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
