import { defineConfig } from 'vitest/config';

// Tests use the `.unit.ts` suffix so the parent Crawlee monorepo's vitest run never picks them up
// while this project still lives inside that repository.
export default defineConfig({
    test: {
        include: ['test/**/*.unit.ts'],
        testTimeout: 60_000,
    },
});
