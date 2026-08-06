import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Static build. No framework plugins — this is four screens (CLAUDE.md §2).
 *
 * `npm run build` is gated by `prebuild`, which runs the cross-validation in
 * tools/validate_ingress.mjs, so a table Astronomy Engine disagrees with cannot
 * reach a deploy (§6).
 */
export default defineConfig({
  build: {
    target: 'es2022',
    // §11 budgets 400 KB gzipped on first load. The ingress tables are fetched
    // from /public/data rather than bundled, so this covers app code only.
    chunkSizeWarningLimit: 150,
    reportCompressedSize: true,
    rollupOptions: {
      // Two static pages, per §10: the app itself, and the privacy page it
      // links to. privacy.html carries no app logic — see src/privacy.ts.
      input: {
        index: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
      },
    },
  },
  server: { port: 5173 },
});
