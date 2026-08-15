import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  server: {
    // Listen on 0.0.0.0 so phones on the same Wi-Fi can open http://192.168.x.x:3000
    // (Vite prints the Network URL). Override with `server.host` / HOST if needed.
    host: true,
    port: 3000,
    // Never silently move the frontend to another port and leave the browser
    // pointed at a stale instance after a restart.
    strictPort: true,
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
})

export default config
