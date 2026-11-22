import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')
          const localeMatch = normalizedId.match(/\/src\/locales\/([^/]+)\//)
          if (localeMatch) {
            return `locale-${localeMatch[1].toLowerCase()}`
          }
          if (!normalizedId.includes('/node_modules/')) return
          if (
            normalizedId.includes('/react/') ||
            normalizedId.includes('/react-dom/') ||
            normalizedId.includes('/scheduler/')
          ) {
            return 'react-vendor'
          }
          if (normalizedId.includes('/@tanstack/react-query/')) {
            return 'query-vendor'
          }
          if (
            normalizedId.includes('/recharts/') ||
            normalizedId.includes('/d3-') ||
            normalizedId.includes('/victory-vendor/')
          ) {
            return 'charts-vendor'
          }
          if (normalizedId.includes('/framer-motion/')) {
            return 'motion-vendor'
          }
          // Icons grow with every page. Keeping them out of the shared vendor
          // chunk stops a new icon from consuming the vendor budget.
          if (normalizedId.includes('/lucide-react/')) {
            return 'icons-vendor'
          }
          if (
            normalizedId.includes('/i18next/') ||
            normalizedId.includes('/react-i18next/') ||
            normalizedId.includes('/i18next-browser-languagedetector/')
          ) {
            return 'i18n-vendor'
          }
          return 'vendor'
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/': {
        target: 'http://localhost:2099',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:2099',
        changeOrigin: true,
      },
    },
  },
})
