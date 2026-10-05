import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'StormScope — live weather & flood map',
        short_name: 'StormScope',
        description:
          'Mobile-first live radar, rainfall forecast, flood-risk and river-gauge map with a 3D terrain view.',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell: everything Vite emits is precached so the shell opens offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        // Control the page from the very first visit so that session's API responses
        // are cached and available offline without a reload.
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // Basemap style + vector tiles: cache-first, they rarely change.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'basemap-tiles',
              expiration: { maxEntries: 400, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Terrain DEM tiles (AWS terrarium).
            urlPattern: /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'terrain-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // GOES tiles are immutable per (layer, time); the capabilities XML is refetched.
            urlPattern: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/(?!1\.0\.0).*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'satellite-tiles',
              expiration: { maxEntries: 400, maxAgeSeconds: 3 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Radar tiles are immutable per frame path.
            urlPattern: /^https:\/\/tilecache\.rainviewer\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'radar-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 2 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Live data APIs: network first, fall back to the last good copy when offline.
            urlPattern:
              /^https:\/\/(api\.rainviewer\.com|api\.open-meteo\.com|geocoding-api\.open-meteo\.com|api\.waterdata\.usgs\.gov|api\.water\.noaa\.gov|api\.weather\.gov|hydro\.nationalmap\.gov|nominatim\.openstreetmap\.org)\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'live-data',
              networkTimeoutSeconds: 12,
              expiration: { maxEntries: 200, maxAgeSeconds: 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Perf builds (PERF_SOURCEMAP=1) ship maps so CPU profiles resolve to source names; release builds don't.
    sourcemap: process.env.PERF_SOURCEMAP === '1',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // MapLibre is ~1 MB and changes rarely: keep it in its own long-cached chunk.
        // Rolldown (Vite 8): manualChunks is deprecated and, with two rules, merged MapLibre into the
        // on-demand chunk. advancedChunks groups are explicit: MapLibre in its own long-cached chunk,
        // the journey pipeline + its panel/layers in a chunk loaded only when a journey exists.
        advancedChunks: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl[\\/]/, priority: 10 },
            { name: 'journey', test: /[\\/]src[\\/](api[\\/](routing|hazards|rwis)|lib[\\/](journey|journeyBundle|roadIce|hazardEngine|polyline)|components[\\/]JourneyPanel|map[\\/](RouteLayer|HazardLayer))\.tsx?$/, priority: 5 },
          ],
        },
      },
    },
  },
})
