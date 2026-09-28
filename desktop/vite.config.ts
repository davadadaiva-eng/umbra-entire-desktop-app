import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        // Browser dev: /smartthings/* -> https://api.smartthings.com/* (no CORS)
        // Token is forwarded from the main-process env (never bundled):
        // UMBRA_SMARTTHINGS_TOKEN / SMARTTHINGS_TOKEN take precedence over VITE_*.
        '/smartthings': {
          target: process.env.UMBRA_SMARTTHINGS_URL || env.UMBRA_SMARTTHINGS_URL || env.VITE_SMARTTHINGS_URL || 'https://api.smartthings.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/smartthings/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const token = process.env.UMBRA_SMARTTHINGS_TOKEN || process.env.SMARTTHINGS_TOKEN || env.UMBRA_SMARTTHINGS_TOKEN || env.SMARTTHINGS_TOKEN || env.VITE_SMARTTHINGS_TOKEN;
              if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
            });
          },
        },
      },
    },
  };
})
