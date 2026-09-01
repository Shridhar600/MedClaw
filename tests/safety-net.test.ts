import { EventEmitter } from 'events';
import { installGlobalSafetyNet, reportFatalStartupError } from '../src/index';

describe('Global safety net (RES-P1-3)', () => {
  it('logs sanitized unhandledRejection and continues (does not throw nor exit)', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called');
    }) as never);

    const target = new EventEmitter();
    const teardown = installGlobalSafetyNet(target as unknown as Parameters<typeof installGlobalSafetyNet>[0]);

    try {
      // A provider/agent error message can echo PHI (here: "glucose 300").
      expect(() =>
        target.emit('unhandledRejection', new Error('private glucose 300 spike')),
      ).not.toThrow();

      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('Unhandled rejection');
      expect(logged).toContain('continuing');
      // summarizeErrorForLog excludes the message body — PHI never leaks.
      expect(logged).not.toContain('glucose');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      teardown();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('logs sanitized uncaughtException and continues (does not exit)', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called');
    }) as never);

    const target = new EventEmitter();
    const teardown = installGlobalSafetyNet(target as unknown as Parameters<typeof installGlobalSafetyNet>[0]);

    try {
      expect(() =>
        target.emit('uncaughtException', new Error('chest pain sodium 140 private')),
      ).not.toThrow();

      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('Uncaught exception');
      expect(logged).toContain('continuing');
      expect(logged).not.toContain('chest pain');
      expect(logged).not.toContain('sodium');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      teardown();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('teardown removes the listeners from the target', () => {
    const target = new EventEmitter();
    const before = target.listenerCount('unhandledRejection') + target.listenerCount('uncaughtException');
    const teardown = installGlobalSafetyNet(target as unknown as Parameters<typeof installGlobalSafetyNet>[0]);
    const during = target.listenerCount('unhandledRejection') + target.listenerCount('uncaughtException');
    expect(during).toBeGreaterThan(before);
    teardown();
    const after = target.listenerCount('unhandledRejection') + target.listenerCount('uncaughtException');
    expect(after).toBe(before);
  });

  it('logs a sanitized fatal startup error before exiting', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      reportFatalStartupError(new Error('startup failed with MEDICALSECRET12345'));
      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('Fatal error');
      expect(logged).toContain('Error');
      expect(logged).not.toContain('MEDICALSECRET12345');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
