import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,       // like Jest’s global test functions
    environment: 'node',
    include: ['src/__tests__/*.test.ts'],
  },
})
