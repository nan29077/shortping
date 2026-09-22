import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // Cloudflare Tunnel(trycloudflare.com) 외부 미리보기 허용
    allowedHosts: ['.trycloudflare.com'],
    watch: {
      ignored: [
        '**/data/**',
        '**/uploads/**',
        '**/public/**',
        '**/assets/**',
        '**/docs/**',
        '**/tests/**',
      ],
    },
  },
  build: { outDir: 'dist' },
});
