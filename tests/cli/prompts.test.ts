import * as prompts from '../../src/cli/prompts';

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
});
