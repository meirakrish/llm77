import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Forward /api to the backend so the UI and API share an origin and no CORS setup is needed
const proxy = {
  '/api': process.env.API_URL ?? 'http://localhost:3000'
};

export default defineConfig({
  plugins: [svelte()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy }
});
