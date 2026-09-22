// scripts/probe-openrouter.ts
//
// Makeshift live probe for OpenRouter `stealth/ox-alpha` BEFORE wiring the provider in.
// Research context: 505/research/13-openrouter-integration.md.
//
// What it checks (all synthetic prompts, no PHI):
//   P1  plain text turn through OUR OpenAIProvider (the exact production class)
//   P2  tool-bearing turn (the acceptance test: tools + mandatory reasoning coexist?)
//   P3  full tool round-trip (assistant tool_calls -> tool result -> final text),
//       i.e. the OpenAI ordering invariant through OpenRouter
//   P4  reasoning_effort:'none' via raw fetch — EXPECTED to be rejected/ignored;
//       proves we must NOT port the #13 gpt-5 workaround here
//   P5  latency comparison: default effort (mandatory max) vs reasoning:{effort:'low'}
//
// Key resolution: env OPENROUTER_API_KEY, else ~/.redacted/openrouter.key (0600).
// The key is NEVER printed.
//
// Run: npx tsx scripts/probe-openrouter.ts

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProvider } from '../src/providers/factory';
import type { Message, ToolSchema } from '../src/providers/types';

const BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL = 'stealth/ox-alpha';
const PROBE_TIMEOUT_MS = 120_000;

function resolveKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const keyPath = path.join(os.homedir(), '.redacted', 'openrouter.key');
  try {
    const fromFile = fs.readFileSync(keyPath, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    /* fallthrough */
  }
  console.error('No API key found. Set OPENROUTER_API_KEY or write the key to ~/.redacted/openrouter.key (0600).');
  process.exit(1);
}

// End-to-end: goes through the REAL factory + key resolution + reasoning default.
function makeProvider(): ReturnType<typeof createProvider> {
  return createProvider({
    type: 'openrouter',
    model: MODEL,
    apiKey: resolveKey(),
  });
}

const ACK_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'probe_ack',
    description: 'Acknowledge that the model is online and able to call tools.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

const ADD_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'add_numbers',
    description: 'Add two integers and return the sum.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
};

let failures = 0;

async function timed<T>(label: string, work: () => Promise<T>): Promise<{ ms: number; value: T } | null> {
  const startedAt = Date.now();
  try {
    const value = await work();
    const ms = Date.now() - startedAt;
    console.log(`  [${label}] OK in ${ms}ms`);
    return { ms, value };
  } catch (error) {
    const ms = Date.now() - startedAt;
    failures += 1;
    const body = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`  [${label}] FAILED after ${ms}ms — ${body.slice(0, 500)}`);
    return null;
  }
}

async function rawChat(body: Record<string, unknown>, label: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolveKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: controller.signal,
    });
    const text = await response.text();
    console.log(`  [${label}] HTTP ${response.status} — ${text.slice(0, 300)}`);
    if (!response.ok) failures += 0; // informational probes: status alone is the result
  } catch (error) {
    failures += 1;
    console.error(`  [${label}] request error — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log(`Probing OpenRouter ${MODEL} (baseUrl ${BASE_URL})…\n`);
  const provider = makeProvider();

  // P1 — plain text turn through the real production class.
  console.log('P1: plain chat (no tools) via createProvider(openrouter)');
  const p1 = await timed('P1', () =>
    provider.chat([{ role: 'user', content: 'Reply with exactly: OK' }]),
  );
  if (p1) console.log(`  type=${p1.value.type} text=${JSON.stringify((p1.value as { text?: string }).text?.slice(0, 200))}\n`);

  // P2 — THE acceptance test: tool-bearing turn (probeChatCompletion equivalent).
  console.log('P2: tool-bearing chat via createProvider(openrouter) (tools + mandatory reasoning)');
  const p2 = await timed('P2', () =>
    provider.chat(
      [{ role: 'user', content: 'Health check: acknowledge by calling probe_ack.' }],
      [ACK_TOOL],
    ),
  );
  if (p2) {
    console.log(`  type=${p2.value.type}`);
    if (p2.value.type === 'tool_call') {
      console.log(`  toolCalls=${JSON.stringify(p2.value.toolCalls)}`);
    }
    console.log();
  }

  // P3 — full round trip: assistant tool_calls -> ONE tool message -> final text.
  // Validates OpenAI message-ordering survives OpenRouter's translation layer.
  console.log('P3: tool round-trip (assistant tool_calls -> tool result -> final answer)');
  const p3 = await timed('P3', async () => {
    const first = await provider.chat(
      [{ role: 'user', content: 'Use add_numbers to compute 17 + 25, then report the sum.' }],
      [ADD_TOOL],
    );
    if (first.type !== 'tool_call') throw new Error(`expected tool_call, got ${first.type}`);
    const call = first.toolCalls[0];
    const messages: Message[] = [
      { role: 'user', content: 'Use add_numbers to compute 17 + 25, then report the sum.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      },
      { role: 'tool', content: JSON.stringify({ sum: 42 }), tool_call_id: call.id },
    ];
    return provider.chat(messages, [ADD_TOOL]);
  });
  if (p3) console.log(`  final type=${p3.value.type} text=${JSON.stringify((p3.value as { text?: string }).text?.slice(0, 200))}\n`);

  // P4 — empirical check of the #13 caveat: reasoning_effort:'none' must NOT be sent.
  console.log("P4: raw fetch WITH reasoning_effort:'none' (expected: rejected or ignored)");
  await rawChat(
    { messages: [{ role: 'user', content: 'Reply with exactly: OK' }], reasoning_effort: 'none' },
    'P4',
  );
  console.log();

  // P5 — latency: default effort (mandatory max) vs explicit low.
  console.log('P5: latency — default effort vs reasoning:{effort:"low"} (raw fetch x1 each)');
  await rawChat({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }, 'P5-default');
  await rawChat(
    { messages: [{ role: 'user', content: 'Reply with exactly: OK' }], reasoning: { effort: 'low' } },
    'P5-low',
  );

  console.log(`\nDone. ${failures === 0 ? 'All hard probes passed.' : `${failures} probe(s) FAILED — see above.`}`);
}

main().catch((error) => {
  console.error('Probe crashed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
