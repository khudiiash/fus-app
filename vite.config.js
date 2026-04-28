import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  createReadStream,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const labymcRoot = fileURLToPath(new URL('./src/js-minecraft', import.meta.url))

/** Only real JS/TS/Vue modules — never HTML/assets: `path?fusdev=` is invalid on Windows for non-modules. */
function isLabymcDevModuleCacheBustPath(fsPath) {
  const clean = fsPath.split('?')[0]
  return /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|vue)$/i.test(clean)
}

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
/**
 * Dev only: every resolved module under `src/js-minecraft` (including relative imports from
 * `Start.js`) gets a stable `?fusdev=` query for this dev-server boot. Otherwise Vite keeps serving the
 * first-transformed subgraph and edits under the engine tree never show up on localhost.
 */
function createLabymcDevModuleQueryPlugin() {
  const boot = String(Date.now())
  return {
    name: 'labymc-dev-module-query',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id.includes('?fusdev=')) {
        return id
      }
      if (id.startsWith('\0')) {
        return null
      }
      if (id.startsWith('@labymc/')) {
        const clean = id.split('?')[0]
        const rel = clean.slice('@labymc/'.length)
        const abs = join(labymcRoot, rel)
        if (!existsSync(abs) || !isLabymcDevModuleCacheBustPath(abs)) {
          return null
        }
        return `${abs.replace(/\\/g, '/')}?fusdev=${boot}`
      }
      // Relative imports FROM inside the engine tree must collapse onto the same `?fusdev=` URL as
      // `@labymc/...` imports, otherwise we end up with two module instances for e.g. `libraries/long.js`
      // (one from `@labymc/libraries/long.js`, one from the engine's `../../../libraries/long.js`),
      // which breaks `instanceof` across the two graphs.
      if (id.startsWith('.') && importer) {
        const importerAbs = importer.split('?')[0].replace(/\\/g, '/')
        if (importerAbs.includes('src/js-minecraft/')) {
          const abs = resolve(dirname(importerAbs), id)
          if (existsSync(abs) && isLabymcDevModuleCacheBustPath(abs)) {
            return `${abs.replace(/\\/g, '/')}?fusdev=${boot}`
          }
        }
      }
      const base = id.split('?')[0]
      const norm = base.replace(/\\/g, '/')
      if (/\.html?$/i.test(norm)) {
        return null
      }
      if (!norm.includes('src/js-minecraft/')) {
        return null
      }
      if (!existsSync(base) || !isLabymcDevModuleCacheBustPath(base)) {
        return null
      }
      return `${base.replace(/\\/g, '/')}?fusdev=${boot}`
    },
  }
}

/** Dev: submodule edits are outside the Vue graph — force a full reload so the browser always re-fetches @labymc. */
/**
 * Engine assets (see `window.__LABY_MC_ASSET_BASE__`):
 * - Mob GLBs: `src/resources/models/*.glb`
 * - Laby skybox: `src/resources/sky/{px,nx,py,ny,pz,nz}.png`
 * Served from the live engine tree in dev; copied into `dist/labyminecraft/...` on build.
 */
function labymcEngineRuntimeAssetsPlugin() {
  const modelsDir = join(labymcRoot, 'src', 'resources', 'models')
  const skyDir = join(labymcRoot, 'src', 'resources', 'sky')
  return {
    name: 'labymc-engine-runtime-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0]
        const mGlb = pathname.match(/\/labyminecraft\/src\/resources\/models\/([^/]+\.glb)$/i)
        if (mGlb) {
          const name = mGlb[1]
          if (!name || /[\\/]/.test(name) || name.includes('..')) {
            return next()
          }
          if (!existsSync(modelsDir)) {
            return next()
          }
          const fp = join(modelsDir, name)
          if (!existsSync(fp)) {
            return next()
          }
          res.setHeader('Content-Type', 'model/gltf-binary')
          res.setHeader('Cache-Control', 'no-store')
          const stream = createReadStream(fp)
          stream.on('error', () => next())
          stream.pipe(res)
          return
        }
        const mPng = pathname.match(/\/labyminecraft\/src\/resources\/sky\/([^/]+\.png)$/i)
        if (mPng) {
          const name = mPng[1]
          if (!name || /[\\/]/.test(name) || name.includes('..')) {
            return next()
          }
          if (!existsSync(skyDir)) {
            return next()
          }
          const fp = join(skyDir, name)
          if (!existsSync(fp)) {
            return next()
          }
          res.setHeader('Content-Type', 'image/png')
          res.setHeader('Cache-Control', 'no-store')
          const stream = createReadStream(fp)
          stream.on('error', () => next())
          stream.pipe(res)
          return
        }
        return next()
      })
    },
    closeBundle: {
      order: 'post',
      handler() {
        if (existsSync(modelsDir)) {
          let files
          try {
            files = readdirSync(modelsDir).filter((f) => f.toLowerCase().endsWith('.glb'))
          } catch {
            files = []
          }
          if (files.length > 0) {
            const outDir = resolve(__dirname, 'dist/labyminecraft/src/resources/models')
            mkdirSync(outDir, { recursive: true })
            for (const f of files) {
              copyFileSync(join(modelsDir, f), join(outDir, f))
            }
          }
        }
        if (existsSync(skyDir)) {
          let files
          try {
            files = readdirSync(skyDir).filter((f) => f.toLowerCase().endsWith('.png'))
          } catch {
            files = []
          }
          if (files.length > 0) {
            const outDir = resolve(__dirname, 'dist/labyminecraft/src/resources/sky')
            mkdirSync(outDir, { recursive: true })
            for (const f of files) {
              copyFileSync(join(skyDir, f), join(outDir, f))
            }
          }
        }
      },
    },
  }
}

function labymcWatchFullReload() {
  return {
    name: 'labymc-watch-full-reload',
    configureServer(server) {
      const enginePath = join(
        labymcRoot,
        'src/js/net/minecraft/client/render/WorldRenderer.js',
      )
      if (!existsSync(enginePath)) {
        server.config.logger.warn(`[FUS] Missing ${enginePath} — third-party/js-minecraft not present?`)
      }
      try {
        server.watcher.add(labymcRoot)
      } catch {
        /* ignore */
      }
      server.watcher.on('change', (file) => {
        const f = file.replace(/\\/g, '/')
        if (f.includes('js-minecraft')) {
          server.config.logger.info('[vite] src/js-minecraft changed — full reload')
          server.ws.send({ type: 'full-reload', path: '*' })
        }
      })
    },
  }
}

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

export default defineConfig(({ mode, command }) => ({
  // Listen on all interfaces so phones / other PCs on the same Wi‑Fi can open the dev app.
  // With `npm run dev:https`, Vite prints `https://192.168.x.x:5173` — trust the cert once in the
  // browser; add that origin to Firebase Auth “Authorized domains” if you use login on the phone.
  server: {
    host: true,
    ...(command === 'serve'
      ? {
          headers: {
            'Cache-Control': 'no-store',
          },
        }
      : {}),
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
          if (id.includes('src/js-minecraft') || id.includes('src\\js-minecraft')) {
            return 'vendor-labyminecraft'
          }
        },
      },
    },
  },
  plugins: [
    labymcEngineRuntimeAssetsPlugin(),
    ...(command === 'serve' ? [createLabymcDevModuleQueryPlugin(), labymcWatchFullReload()] : []),
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
          {
            urlPattern: ({ url }) =>
              url.origin === self.location.origin &&
              /\/labyminecraft\/src\/resources\/(models|sky)\//i.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'laby-runtime-assets',
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      // Never register the SW during `vite dev`: Workbox runtime caches (e.g. labyminecraft chunk)
      // survive reloads and make local edits to `third-party/js-minecraft` look like they “don’t apply”.
      // Test PWA with `vite build && vite preview` (or `npm run preview`).
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
    prependFcmImportToSwJs(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /** FUS game engine lives in `src/js-minecraft` (fork of github.com/khudiiash/js-minecraft). */
      '@labymc': labymcRoot,
    },
    // Force a single three.js instance so post-processing and the skin host scene
    // share the same class constructors.
    dedupe: ['three'],
  },
}))
