/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// dcap-qvl verifies Intel quotes in the browser and needs Node's crypto,
// buffer and stream shims there.
export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['crypto', 'stream', 'buffer', 'util'] })],
  // Live tests reach NEAR, OutLayer and Intel; they run only with LIVE=1.
  test: { environment: 'node', exclude: process.env.LIVE === '1' ? ['node_modules/**'] : ['node_modules/**', 'src/**/*.live.test.ts'] },
});
