import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'adapter',
          include: ['tests/adapter/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
