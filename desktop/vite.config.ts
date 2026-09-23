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
        '/smartthings': {
          target: env.VITE_SMARTTHINGS_URL || 'https://api.smartthings.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/smartthings/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const token = env.VITE_SMARTTHINGS_TOKEN;
              if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
            });
          },
        },
      },
    },
  };
})
