export default {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/config/**',
    '!src/**/*index.js'
  ]
};
