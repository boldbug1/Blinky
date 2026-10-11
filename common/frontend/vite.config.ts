import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;

export default defineConfig({
  root: 'common/frontend',
  envDir: '../../',
  plugins: [react()],
  clearScreen: false,
  server: {
    port,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

