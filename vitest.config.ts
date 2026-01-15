import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run unit tests from tests/unit and tests/api directories
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts'],
    // Exclude Playwright E2E tests
    exclude: ['tests/*.spec.ts', 'tests/concurrency/**'],
    // Enable globals (describe, it, expect)
    globals: true,
    // Environment for testing
    environment: 'node',
    // Test timeout
    testTimeout: 10000,
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['server/**/*.js'],
      exclude: ['node_modules', 'client', 'tests'],
    },
  },
});
