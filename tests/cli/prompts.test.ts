import * as prompts from '../../src/cli/prompts';

// The raw CJS module object — spyable, unlike the ts-jest __importStar clone
// produced by `import * as fs`, whose getter-only properties reject spyOn.
const fs = jest.requireActual<typeof import('fs')>('fs');

describe('cli prompts', () => {
  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };

  const originalIsTTY = process.stdin.isTTY;
  const originalIsRaw = stdin.isRaw;
  const originalSetRawMode = stdin.setRawMode;

  afterEach(() => {
    jest.restoreAllMocks();
    prompts.setCliReadlineFactoryForTests();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    stdin.isRaw = originalIsRaw;
    stdin.setRawMode = originalSetRawMode;
  });

  it('fails instead of echoing secret input on TTYs without raw mode', async () => {
    const promptOutput: string[] = [];
    const firstInterface = {
      question: jest.fn(async () => ''),
      close: jest.fn(),
    };
    const readlineFactory = jest.fn().mockImplementationOnce(() => firstInterface as never);

    prompts.setCliReadlineFactoryForTests(readlineFactory);

    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    stdin.isRaw = false;
    stdin.setRawMode = jest.fn(() => {
      throw new Error('raw mode unavailable');
    });

    await prompts.askText({}, 'Warmup prompt', 'default-value');
    await expect(prompts.askHiddenText(
      {
        stdout: (text: string) => promptOutput.push(text),
      },
      'Telegram bot token',
    )).rejects.toThrow('Secure hidden input is not available');

    expect(firstInterface.close).toHaveBeenCalledTimes(1);
    expect(readlineFactory).toHaveBeenCalledTimes(1);
    expect(promptOutput.join('')).toBe('• Telegram bot token\n  › ');
  });

  it('allows injected secret input without requiring TTY raw mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    stdin.isRaw = false;
    stdin.setRawMode = jest.fn(() => {
      throw new Error('raw mode unavailable');
    });

    const secret = await prompts.askHiddenText(
      {
        secretInput: async () => '123456:test-token',
      },
      'Telegram bot token',
    );

    expect(secret).toBe('123456:test-token');
  });

  it('re-prompts invalid yes/no answers instead of silently coercing them', async () => {
    const stderr: string[] = [];
    const answers = ['maybe', 'y'];

    const value = await prompts.askYesNo(
      {
        input: async () => answers.shift() ?? '',
        stderr: (text: string) => stderr.push(text),
      },
      'Enable Telegram?',
      false,
    );

    expect(value).toBe(true);
    expect(stderr.join('')).toContain('Please answer yes or no.');
  });

  describe('piped (non-TTY) stdin', () => {
    afterEach(() => {
      prompts.setPipedAnswersForTests(undefined);
    });

    function goNonTty(): void {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });
    }

    it('askText consumes seeded piped answers in order', async () => {
      goNonTty();
      prompts.setPipedAnswersForTests(['first', 'second']);
      const out: string[] = [];
      const io = { stdout: (t: string) => out.push(t) };

      await expect(prompts.askText(io, 'Q1')).resolves.toBe('first');
      await expect(prompts.askText(io, 'Q2')).resolves.toBe('second');
    });

    it('askText throws a clear error when piped answers are exhausted (never loops)', async () => {
      goNonTty();
      prompts.setPipedAnswersForTests(['only-one']);
      const io = { stdout: () => undefined };

      await expect(prompts.askText(io, 'Q1')).resolves.toBe('only-one');
      await expect(prompts.askText(io, 'Workspace path')).rejects.toThrow(
        /Piped input exhausted.*Workspace path/,
      );
    });

    it('askHiddenText throws the same exhaustion error on piped stdin', async () => {
      goNonTty();
      prompts.setPipedAnswersForTests([]);

      await expect(
        prompts.askHiddenText({ stdout: () => undefined }, 'Telegram bot token'),
      ).rejects.toThrow(/Piped input exhausted.*Telegram bot token/);
    });

    it('readAllStdinSync retries transient EAGAIN and returns the full input', () => {
      const payload = Buffer.from('line1\nline2');
      let calls = 0;
      jest.spyOn(fs, 'readSync').mockImplementation(((
        _fd: number,
        buffer: Buffer,
      ): number => {
        calls += 1;
        if (calls <= 2) {
          const err = new Error('EAGAIN') as NodeJS.ErrnoException;
          err.code = 'EAGAIN';
          throw err;
        }
        if (calls === 3) {
          payload.copy(buffer);
          return payload.length;
        }
        return 0; // EOF
      }) as never);

      expect(prompts.readAllStdinSync()).toBe('line1\nline2');
      expect(calls).toBe(4);
    });

    it('readAllStdinSync returns empty string on immediate EOF', () => {
      jest.spyOn(fs, 'readSync').mockImplementation((() => 0) as never);
      expect(prompts.readAllStdinSync()).toBe('');
    });
  });
});
