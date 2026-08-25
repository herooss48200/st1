import logger from '../../src/services/logger.js';

describe('Logger System', () => {
  test('should initialize logger', () => {
    expect(logger).toBeDefined();
  });

  test('should log info messages', () => {
    expect(() => {
      logger.info('Test message', { data: 'test' });
    }).not.toThrow();
  });

  test('should log warning messages', () => {
    expect(() => {
      logger.warning('Test warning');
    }).not.toThrow();
  });

  test('should log error messages', () => {
    expect(() => {
      logger.error('Test error', new Error('Test'));
    }).not.toThrow();
  });

  test('should redact sensitive data', () => {
    const sensitiveData = {
      apiKey: '123456',
      secret: 'secret123',
      nested: {
        authorization: 'Bearer abc',
        value: 'visible'
      }
    };

    expect(logger.sanitizeSecurityData(sensitiveData)).toEqual({
      apiKey: '***REDACTED***',
      secret: '***REDACTED***',
      nested: {
        authorization: '***REDACTED***',
        value: 'visible'
      }
    });
    expect(() => {
      logger.info('Sensitive data', sensitiveData);
    }).not.toThrow();
  });
});
