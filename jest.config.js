/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // The S1 owner-spine acceptance suite boots REAL `ProfileRuntime`s three times. Something it
  // builds keeps the Node event loop alive after the suite is green, so including it here makes the
  // whole default run never exit (S1 residual R-15, recorded in the implementation report).
  //
  // R-15 IS FIXED. This suite used to be excluded here because booting a real ProfileRuntime leaked an
  // event-loop handle, so the run never exited. The leak was this suite booting every Gateway TWICE
  // concurrently (`void gateway.start()` in the createGateway hook, while `startDaemon()` already awaits
  // it): two managers, two runtime sets, and the orphaned one was never drained. With the double start
  // removed the suite exits cleanly, so it now runs in the DEFAULT gate like every other suite. Nothing
  // is contained any more.
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverageFrom: ['src/**/*.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
