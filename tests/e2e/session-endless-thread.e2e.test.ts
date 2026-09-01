// P2b D-5.2 E2E — the endless per-chat thread through the REAL composition root
// (Gateway.handleTestMessage → AgentLoop → SessionManager day-file archive + session_search index).
// Hermetic: telegram off, providers point at unreachable local endpoints (recall degrades, boot warns
// and continues). Registry-scoped under tmpDir so the perpetual thread lands in an isolated profile.
//
// Proves end-to-end: (1) turns persist + are retrievable verbatim via the session_search tool
// (chat-scoped, X-1); (2) prune is lossless through the root (a marked tool result is still returned by
// session_search); (3) compaction crosses a boundary (window becomes [summary, tail], the day file is
// byte-identical, and an early turn compacted OUT of the window stays searchable); (4) a restart resumes
// the compacted window and keeps appending to the SAME day file (endless thread).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { dateKey, countDayFileLines } from '../../src/gateway/session-window';
import { PRUNED_TOOL_MARKER } from '../../src/gateway/session';
import type { AppConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';

const COMPACT_MARKER = 'Summarize the conversation turns below';
const SUMMARY = '- Patient is allergic to penicillin\n- Blood pressure 150/95 logged\n- Following up next week';

// One provider drives both the agent loop (plain replies) and compaction (a real summary), branching on
// the compaction system prompt so the boundary is deterministic without a positional script.
function journeyProvider(): LLMProvider {
  return {
    modelName: 'journey-e2e',
    async chat(messages: Message[]): Promise<LLMResponse> {
      const isCompaction = messages.some(m => typeof m.content === 'string' && m.content.includes(COMPACT_MARKER));
      if (isCompaction) return { type: 'text', text: SUMMARY };
      return { type: 'text', text: 'Noted — thanks for the update.' };
    },
    async embed(): Promise<number[]> { return []; },
  };
}

function makeConfig(tmpDir: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    profiles: { baseDir: path.join(tmpDir, 'profiles-base'), defaultProfileId: 'default' },
    memory: {
      workspace: path.join(tmpDir, 'workspace'),
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      // memoryFlush off → compaction runs the summary step only (no flush tool call to script).
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 100, maxPerChatTriggersPerMinute: 100 },
      audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
      policy: {
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 0,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 15, disclaimerEnabled: true },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function startGateway(tmpDir: string): Promise<Gateway> {
  const gw = new Gateway(makeConfig(tmpDir));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await gw.start();
  warn.mockRestore(); log.mockRestore(); err.mockRestore();
  const provider = journeyProvider();
  (gw as any).handleOnboarding = async (): Promise<null> => null; // skip the deterministic onboarding machine
  (gw as any).agentLoop.provider = provider;   // agent turns
  (gw as any).sessions.llmProvider = provider;  // compaction summary
  return gw;
}

const CHAT = 'owner-chat';

describe('P2b E2E — endless per-chat thread (real Gateway.handleTestMessage)', () => {
  let tmpDir: string;
  let gateway: Gateway;
  let gateway2: Gateway | undefined;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-endless-e2e-')); });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    try { await gateway2?.stop(); } catch { /* ignore */ }
    gateway2 = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const searchTool = (gw: Gateway, query: string): Promise<any> =>
    (gw as any).agentLoop.registry.execute('session_search', { query }, { chatId: CHAT });

  it('persists turns, prunes losslessly, and crosses a compaction boundary — all through the root', async () => {
    gateway = await startGateway(tmpDir);

    await gateway.handleTestMessage(CHAT, "I'm allergic to penicillin — please remember that.");
    await gateway.handleTestMessage(CHAT, 'My blood pressure was 150/95 this morning.');
    await gateway.handleTestMessage(CHAT, 'I started metformin 500mg yesterday.');

    // (1) session_search retrieves an early turn verbatim, scoped to this chat (X-1).
    const found = await searchTool(gateway, 'allergic to penicillin');
    expect(found.isError).toBeFalsy();
    expect(found.content[0].text).toContain('allergic to penicillin');

    // (2) prune losslessness through the root: inject a tool-bearing turn on the real persistence path,
    // push it past the last-5-turns window, prune, and confirm session_search still returns it verbatim.
    for (let n = 1; n <= 6; n++) {
      await (gateway as any).sessions.recordTurn(CHAT, [
        { role: 'user', content: `reading turn ${n}` },
        { role: 'assistant', content: null, tool_calls: [{ id: `t${n}`, type: 'function', function: { name: 'x', arguments: '{}' } }] },
        { role: 'tool', content: `hba1c sample ${n} is 6.${n}%`, tool_call_id: `t${n}` },
      ]);
    }
    await (gateway as any).sessions.pruneWindow(CHAT);
    const firstTool = ((gateway as any).sessions.getHistory(CHAT) as Message[]).find(m => m.role === 'tool');
    expect(firstTool?.content).toBe(PRUNED_TOOL_MARKER);
    const prunedSearch = await searchTool(gateway, 'hba1c sample 1 is 6.1%');
    expect(prunedSearch.content[0].text).toContain('hba1c sample 1 is 6.1%');

    // (3) compaction boundary through /compact: window becomes [summary, tail], the day file is
    // byte-identical, and the early penicillin turn (now out of the window) stays searchable.
    const sessionsDir = (gateway as any).sessions.sessionsDir as string;
    const dayFile = path.join(sessionsDir, CHAT, `${dateKey(new Date())}.jsonl`);
    const dayBefore = fs.readFileSync(dayFile, 'utf8');

    const reply = await gateway.handleTestMessage(CHAT, '/compact');
    expect(reply.toLowerCase()).toContain('compacted');

    const history = (gateway as any).sessions.getHistory(CHAT) as Message[];
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('[Previous conversation summary]');
    expect(history[0].content).toContain('penicillin'); // summary carried the early fact into context
    expect(fs.readFileSync(dayFile, 'utf8')).toBe(dayBefore); // day file never rewritten (DD1)

    const afterCompact = await searchTool(gateway, 'allergic to penicillin');
    expect(afterCompact.content[0].text).toContain('allergic to penicillin');

    // RR-4/C-29: the compaction summary is copied through the real Gateway sink into a chat-scoped
    // state lane, not profile-wide narrative memory.
    const ws = (gateway as any).getEffectiveWorkspace() as string;
    const summaryPath = path.join(ws, '.state', 'session-summaries', CHAT, `${dateKey(new Date())}.md`);
    const summaryText = fs.readFileSync(summaryPath, 'utf8');
    expect(summaryText).toContain('## Session summary');
    expect(summaryText).toContain('penicillin');
    const dailyLog = path.join(ws, 'memory', `${dateKey(new Date())}.md`);
    expect(fs.readFileSync(dailyLog, 'utf8')).not.toContain('## Session summary');
  });

  it('a restart mid-journey resumes the compacted window and keeps appending to the same day file', async () => {
    gateway = await startGateway(tmpDir);
    for (let n = 1; n <= 4; n++) {
      await gateway.handleTestMessage(CHAT, `journey message ${n} about my knee`);
    }
    await gateway.handleTestMessage(CHAT, '/compact');
    const beforeRestart = ((gateway as any).sessions.getHistory(CHAT) as Message[]).map(m => `${m.role}:${m.content}`);
    const sessionsDir = (gateway as any).sessions.sessionsDir as string;
    const dayFile = path.join(sessionsDir, CHAT, `${dateKey(new Date())}.jsonl`);
    const linesBeforeRestart = countDayFileLines(dayFile);
    await gateway.stop();

    // Fresh process on the same profile dir — the thread resumes from the window + day-file archive.
    gateway2 = await startGateway(tmpDir);
    const afterRestart = ((gateway2 as any).sessions.getHistory(CHAT) as Message[]).map(m => `${m.role}:${m.content}`);
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart[0]).toContain('[Previous conversation summary]');

    // The thread keeps going — a new turn appends to the SAME day file (endless, contiguous).
    await gateway2.handleTestMessage(CHAT, 'one more update after the restart');
    // F-12: exactly the new turn's messages are appended (1 user + 1 assistant reply) — not a
    // duplicated tail or a partial write.
    expect(countDayFileLines(dayFile)).toBe(linesBeforeRestart + 2);
    const post = await (gateway2 as any).agentLoop.registry.execute('session_search', { query: 'one more update after the restart' }, { chatId: CHAT });
    expect(post.content[0].text).toContain('one more update after the restart');
  });
});
