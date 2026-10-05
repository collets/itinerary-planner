import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import vercel from './vercel.json';

const securityHeaders = Object.fromEntries(
  vercel.headers[0].headers.map(({ key, value }) => [key, value]),
);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      manifest: {
        name: 'Passo — i tuoi viaggi',
        short_name: 'Passo',
        lang: 'it',
        description: 'Il tuo itinerario, i percorsi e i biglietti. Anche offline.',
        theme_color: '#f6f2e9',
        background_color: '#f6f2e9',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,wasm,bcmap,ttf,pfb}'],
        maximumFileSizeToCacheInBytes: 12000000,
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  preview: { headers: securityHeaders },
  build: { target: 'es2022' },
});
