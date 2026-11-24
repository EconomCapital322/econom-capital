import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { proxy: { '/api': { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000', changeOrigin: true } } },
  ...(mode === 'spectrum' ? {
    build: {
      outDir: process.env.SPECTRUM_CURVE_BUILD_DIR || 'dist-spectrum',
      ...(process.env.SPECTRUM_CURVE_BUILD_DIR ? { emptyOutDir: false } : {}),
      lib: { entry: 'src/embedded.tsx', formats: ['es'], fileName: () => 'curves.js', cssFileName: 'curves' },
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  } : {}),
}))
