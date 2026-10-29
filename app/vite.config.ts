/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { execSync } from 'node:child_process';

// The commit this build came from, so a deployed page can be matched to source:
// Railway and GitHub Actions provide it; a local build asks git.
function commit(): string {
  const env = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (env) return env;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}
const COMMIT = commit();

// dcap-qvl verifies Intel quotes in the browser and needs Node's crypto,
// buffer and stream shims there.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ['crypto', 'stream', 'buffer', 'util'] }),
    {
      name: 'jurat-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ commit: COMMIT }) + '\n' });
      },
    },
  ],
  define: { __COMMIT__: JSON.stringify(COMMIT) },
  // Live tests reach NEAR, OutLayer and Intel; they run only with LIVE=1.
  test: { environment: 'node', exclude: process.env.LIVE === '1' ? ['node_modules/**'] : ['node_modules/**', 'src/**/*.live.test.ts'] },
});
