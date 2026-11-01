/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverageFrom: ['src/**/*.ts'],
  globalTeardown: '<rootDir>/tests/helpers/global-teardown.js',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
