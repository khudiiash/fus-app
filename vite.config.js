import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const FCM_FB_CDN = '12.11.0'

/** Генерує `dist/fcm-sw-compat.js` (Firebase compat + onBackgroundMessage у SW). */
function fcmBackgroundWorkerPlugin(mode) {
  return {
    name: 'fcm-background-worker',
    generateBundle() {
      const env = loadEnv(mode, process.cwd(), '')
      if (!env.VITE_FIREBASE_API_KEY) {
        this.emitFile({
          type: 'asset',
          fileName: 'fcm-sw-compat.js',
          source: '/* FCM: set VITE_FIREBASE_* in .env and rebuild */\n',
        })
        return
      }
      const firebaseConfig = {
        apiKey: env.VITE_FIREBASE_API_KEY,
        authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: env.VITE_FIREBASE_PROJECT_ID,
        storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: env.VITE_FIREBASE_APP_ID,
      }
      const cfgJson = JSON.stringify(firebaseConfig)
      const source = `importScripts('https://www.gstatic.com/firebasejs/${FCM_FB_CDN}/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/${FCM_FB_CDN}/firebase-messaging-compat.js');
firebase.initializeApp(${cfgJson});
var messaging = firebase.messaging();
messaging.onBackgroundMessage(function (payload) {
  var n = payload.notification || {};
  var d = payload.data || {};
  var title = n.title || d.title || 'FUSAPP';
  var body = n.body || d.body || '';
  var tag = (d.tag && String(d.tag)) || ('fusapp-' + (d.type || 'msg'));
  var options = {
    body: body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    tag: tag,
    renotify: true,
    silent: false,
    requireInteraction: false,
  };
  return self.registration.showNotification(title, options);
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    }),
  );
});
`
      this.emitFile({ type: 'asset', fileName: 'fcm-sw-compat.js', source })
    },
  }
}

/**
 * vite-plugin-pwa пише `dist/sw.js` у своєму `closeBundle`. Цей хук — `order: 'post'`,
 * щоб виконуватись після PWA.
 */
function prependFcmImportToSwJs() {
  return {
    name: 'prepend-fcm-import-to-sw-js',
    apply: 'build',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const swPath = resolve(__dirname, 'dist/sw.js')
        if (!existsSync(swPath)) return
        const code = readFileSync(swPath, 'utf8')
        if (/^importScripts\(['"]fcm-sw-compat\.js['"]\)/.test(code)) return
        writeFileSync(swPath, "importScripts('fcm-sw-compat.js');\n" + code)
      },
    },
  }
}

export default defineConfig(({ mode }) => ({
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
    fcmBackgroundWorkerPlugin(mode),
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
        // Не використовувати `importScripts: ['fcm-sw-compat.js']` тут: workbox-build
        // вшиває їх у середину AMD-обгортки, FCM у фоні працює нестабільно.
        // Підключення — перший рядок dist/sw.js (плагін prependFcmImportToSwJs).
        skipWaiting: true,
        clientsClaim: true,
        // Precache omits hashed *.svg in /assets (SubjectIcon uses only pl/ua/gb — a few small files).
        globPatterns: ['**/*.{js,css,html,png,woff2,ico}', '**/manifest.webmanifest', 'icons/*.png', 'icons/*.svg'],
        globIgnores: ['**/*.map'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'firestore-cache' },
          },
          // GLB / images from Firebase Storage — not in precache; without this every cold open re-downloads models.
          // NetworkFirst avoids first-load flakes with cross-origin <img> + SW; only cache real 200 (not opaque 0).
          {
            urlPattern: ({ url }) =>
              url.hostname === 'firebasestorage.googleapis.com' ||
              url.hostname === 'storage.googleapis.com',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fus-storage-models',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
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
    prependFcmImportToSwJs(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Force all packages (including skinview3d) to share a single three.js
    // instance so our post-processing passes and skinview3d's scene use the
    // same class constructors.
    dedupe: ['three'],
  },
}))
