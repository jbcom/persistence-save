import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    // SonarCloud reads coverage/lcov.info (sonar-project.properties); without
    // the lcov reporter it receives no coverage and fails new-code coverage.
    coverage: {
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
