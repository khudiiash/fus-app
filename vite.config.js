import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const labymcRoot = fileURLToPath(new URL('./third-party/js-minecraft', import.meta.url))

/** Self-signed TLS for `npm run dev:https` / `preview:https` (WebGPU needs a secure context on LAN). */
const useDevHttps =
  process.env.DEV_HTTPS === '1' || process.env.DEV_HTTPS === 'true'

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
  // Listen on all interfaces so phones / other PCs on the same Wi‑Fi can open the dev app.
  // With `npm run dev:https`, Vite prints `https://192.168.x.x:5173` — trust the cert once in the
  // browser; add that origin to Firebase Auth “Authorized domains” if you use login on the phone.
  server: {
    host: true,
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Resolve `node_modules` first so Laby’s `libraries/three.module.js` shim does not pull
          // npm `three` into `vendor-labyminecraft`.
          if (id.includes('node_modules')) {
            if (id.includes('three') || id.includes('skinview-utils')) return 'vendor-three'
            if (id.includes('firebase') || id.includes('@firebase')) return 'vendor-firebase'
            if (
              id.includes('/vue/') ||
              id.includes('/@vue/') ||
              id.includes('vue-router') ||
              id.includes('pinia')
            ) {
              return 'vendor-vue'
            }
            return
          }
          if (id.includes('third-party/js-minecraft') || id.includes('third-party\\js-minecraft')) {
            return 'vendor-labyminecraft'
          }
        },
      },
    },
  },
  plugins: [
    ...(useDevHttps ? [basicSsl()] : []),
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
        /** Allow landscape in installed PWA (portrait-only kept browser + game unusable sideways). */
        orientation: 'any',
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
          // Large Laby chunk: CacheFirst so repeat visits on mobile reuse SW disk cache
          // (precache also lists hashed assets, but this helps first post-install loads).
          {
            urlPattern: ({ url }) =>
              url.origin === self.location.origin &&
              /\/assets\/vendor-labyminecraft-[^/]+\.js$/i.test(url.pathname),
            // CacheFirst made “nothing changed” after deploy: SW kept an old hashed chunk forever.
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'fus-labyminecraft-swr-v1',
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
          // Firestore uses long‑lived Write/Listen "channel" fetches — never cache or
          // NetworkFirst them; that breaks streams and spams "No route found" / flaky sync.
          {
            urlPattern: ({ url }) => url.hostname === 'firestore.googleapis.com',
            handler: 'NetworkOnly',
          },
          // Firebase Storage: NetworkFirst avoids first-hit flakiness with StaleWhileRevalidate when the
          // cache is cold (skins use fetch→blob in app code; GLB still benefits from cache after first OK).
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
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /** FUS fork: git submodule `third-party/js-minecraft` → github.com/khudiiash/js-minecraft */
      '@labymc': labymcRoot,
    },
    // Force a single three.js instance so post-processing and the skin host scene
    // share the same class constructors.
    dedupe: ['three'],
  },
}))
