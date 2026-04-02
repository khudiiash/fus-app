import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // Listen on all interfaces so phones / other PCs on the same Wi‑Fi can open the dev app
  // (use the “Network” URL Vite prints, e.g. http://192.168.x.x:5173).
  server: {
    host: true,
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('three') || id.includes('skinview3d')) return 'vendor-three'
          if (id.includes('firebase') || id.includes('@firebase')) return 'vendor-firebase'
          if (
            id.includes('/vue/') ||
            id.includes('/@vue/') ||
            id.includes('vue-router') ||
            id.includes('pinia')
          ) {
            return 'vendor-vue'
          }
        },
      },
    },
  },
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'FUSAPP',
        short_name: 'FUSAPP',
        description: 'Gamified school rewards platform',
        theme_color: '#6d28d9',
        background_color: '#0f0f1a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // Omit *.svg in assets (hundreds of flag-icons) — they bloat install/activate (~5MB+).
        // They still load from network/cache on demand when SubjectIcon is used.
        globPatterns: ['**/*.{js,css,html,png,woff2,ico}', '**/manifest.webmanifest', 'icons/*.png', 'icons/*.svg'],
        globIgnores: ['**/*.map'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'firestore-cache' },
          },
          {
            urlPattern: ({ url }) =>
              url.origin === self.location.origin && /\/assets\/[^/]+\.svg$/i.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'local-svg',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Force all packages (including skinview3d) to share a single three.js
    // instance so our post-processing passes and skinview3d's scene use the
    // same class constructors.
    dedupe: ['three'],
  },
})
