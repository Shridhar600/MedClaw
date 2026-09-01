import * as fs from 'fs';
import * as path from 'path';
import express, { Request, Response } from 'express';
import { loadConfig } from './config/config';
import { AgentLoop } from './agent/agent-loop';
import { ContextAssembler } from './agent/context';
import { MemoryEngine } from './memory/memory-engine';
import { ToolRegistry } from './tools/registry';
import { createMemoryTools } from './tools/memory-tools';
import { SqliteStore } from './memory/sqlite-store';
import { MemorySearch } from './memory/search';
import { createProvider } from './providers/factory';
import { SessionManager, type SessionManagerOptions } from './gateway/session';
import { createInterface } from 'readline';
import { secureMkdir } from './security';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Redacted — Health AI Companion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f8; color: #1a1a2e; height: 100vh; display: flex; flex-direction: column; }
    header { background: linear-gradient(135deg, #0d9488, #0369a1); color: white; padding: 1rem 1.5rem; display: flex; align-items: center; gap: 0.75rem; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    header span { font-size: 0.875rem; opacity: 0.9; }
    #chat { flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
    .message { max-width: 75%; padding: 0.875rem 1rem; border-radius: 1rem; line-height: 1.5; position: relative; }
    .user { align-self: flex-end; background: #0d9488; color: white; border-bottom-right-radius: 0.25rem; }
    .bot { align-self: flex-start; background: white; border: 1px solid #e2e8f0; border-bottom-left-radius: 0.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .meta { font-size: 0.7rem; opacity: 0.7; margin-top: 0.25rem; }
    .user .meta { text-align: right; }
    .typing { align-self: flex-start; background: white; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 0.875rem 1rem; display: none; }
    .typing.visible { display: block; }
    .typing-dot { display: inline-block; animation: bounce 1.4s infinite; }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
    #input-area { background: white; border-top: 1px solid #e2e8f0; padding: 1rem 1.5rem; display: flex; gap: 0.75rem; }
    #input { flex: 1; padding: 0.75rem 1rem; border: 1px solid #d1d5db; border-radius: 1.5rem; font-size: 1rem; outline: none; transition: border-color 0.2s; }
    #input:focus { border-color: #0d9488; }
    #send { background: #0d9488; color: white; border: none; border-radius: 1.5rem; padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; font-weight: 500; transition: background 0.2s; }
    #send:hover { background: #0f766e; }
    #send:disabled { opacity: 0.5; cursor: not-allowed; }
    footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 0.75rem 1.5rem; font-size: 0.75rem; color: #64748b; text-align: center; }
    .error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
  </style>
</head>
<body>
  <header>
    <h1>🩺 Redacted</h1>
    <span>Health AI Companion</span>
  </header>
  <div id="chat">
    <div class="message bot">
      Hello! I'm your Health AI Companion. How can I help you today?
      <div class="meta">Local test UI</div>
    </div>
  </div>
  <div class="typing" id="typing">
    <span class="typing-dot">•</span> <span class="typing-dot">•</span> <span class="typing-dot">•</span>
  </div>
  <div id="input-area">
    <input id="input" type="text" placeholder="Ask about your health..." autocomplete="off" autofocus>
    <button id="send">Send</button>
  </div>
  <footer>
    This is a test UI for local development only. For medical advice, consult your healthcare provider.
  </footer>
  <script>
    const chat = document.getElementById('chat');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const typing = document.getElementById('typing');

    function addMessage(text, role, meta = '') {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      const content = text.replace(/\\n/g, '<br>') + (meta ? '<div class="meta">' + meta + '</div>' : '');
      div.innerHTML = content;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    function showError(text) {
      const div = document.createElement('div');
      div.className = 'message bot error';
      div.textContent = 'Error: ' + text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    async function handleSend() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMessage(text, 'user', new Date().toLocaleTimeString());
      typing.classList.add('visible');
      sendBtn.disabled = true;

      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: 'web-chat', text }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        typing.classList.remove('visible');
        addMessage(data.response, 'bot', new Date().toLocaleTimeString());
      } catch (e) {
        typing.classList.remove('visible');
        showError(e.message);
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.addEventListener('click', handleSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } });
  </script>
</body>
</html>`;

/** Build the supported local web/CLI session seam with per-chat archive isolation enabled. */
export function createCliSessionManager(
  options: Omit<SessionManagerOptions, 'perChatArchive'>,
): SessionManager {
  return new SessionManager({ ...options, perChatArchive: true });
}

function countSessionFiles(dir: string): number {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countSessionFiles(full);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  const config = await loadConfig();

  process.stdout.write('[cli] Starting Redacted...\n');

  const workspacePath = path.resolve(config.memory.workspace.replace('~', process.env.HOME ?? ''));
  secureMkdir(workspacePath);

  const memory = new MemoryEngine(workspacePath);
  const dbPath = path.join(workspacePath, '..', 'search.db');
  const store = new SqliteStore(dbPath);
  const embeddingProvider = createProvider(config.providers.embeddings);

  const { MemoryIndexer } = await import('./memory/indexer');
  const indexer = new MemoryIndexer(store, embeddingProvider, workspacePath);
  await indexer.indexAll();
  process.stdout.write('[cli] Memory index ready\n');

  const search = new MemorySearch(store, embeddingProvider, config.memory.search.hybridWeights);

  const mainProvider = createProvider(config.providers.main);

  const registry = new ToolRegistry(config.tools);
  for (const tool of createMemoryTools(memory, search)) registry.register(tool);

  const assembler = new ContextAssembler(memory, config.memory.bootstrapMaxChars);
  const systemMessages = await assembler.buildSystemMessages();
  const agentLoop = new AgentLoop(
    mainProvider,
    registry,
    async () => ({ messages: systemMessages, healthContextTouched: systemMessages.length > 0 }),
    config.agent,
  );

  const sessionsPath = path.join(process.env.HOME ?? '', '.redacted', 'sessions');
  const sessions = createCliSessionManager({
    sessionsPath,
    softResetMinutes: config.sessions.softResetAfterMinutes,
    hardResetMinutes: config.sessions.hardResetAfterMinutes,
    provider: mainProvider,
    toolRegistry: registry,
    compaction: config.sessions.compaction,
  });

  const app = express();
  app.use(express.json());

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(HTML);
  });

  app.post('/chat', async (req: Request, res: Response) => {
    const { chatId = 'web-chat', text } = req.body;
    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      const history = await sessions.prepareHistory(chatId);
      const result = await agentLoop.run(text, history);
      await sessions.recordTurn(chatId, [
        { role: 'user', content: text },
        ...result.trace,
      ]);
      // M6: feed the real window-fill signal so the CLI harness exercises the spec-14 token triggers too.
      await sessions.recordPromptUsage(chatId, result.lastPromptTokens);
      res.json({ response: result.text });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  const PORT = 3456;
  app.listen(PORT, () => {
    process.stdout.write(`[cli] Redacted ready. Web UI: http://localhost:${PORT}\n\n`);
    process.stdout.write('🩺 Redacted CLI - type /quit to exit\n\n');
  });

  const chatId = 'cli-chat';
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question('💬 ', (answer) => {
        resolve(answer);
      });
    });
  };

  for (;;) {
    const text = (await askQuestion()).trim();

    if (!text) continue;

    if (text === '/quit' || text === '/exit') {
      process.stdout.write('Shutting down...\n');
      store.close();
      rl.close();
      process.exit(0);
    }

    if (text === '/new') {
      await sessions.resetSession(chatId);
      process.stdout.write('✓ New session started.\n\n');
      continue;
    }

    if (text === '/status') {
      const history = sessions.getHistory(chatId);
      process.stdout.write(`Session: ${history.length} messages\n\n`);
      continue;
    }

    if (text === '/sessions') {
      const files = fs.existsSync(sessionsPath) ? countSessionFiles(sessionsPath) : 0;
      process.stdout.write(`Active sessions: ${files}\n\n`);
      continue;
    }

    process.stdout.write('⏳ Processing...\n');

    try {
      const history = await sessions.prepareHistory(chatId);
      const result = await agentLoop.run(text, history);
      await sessions.recordTurn(chatId, [
        { role: 'user', content: text },
        ...result.trace,
      ]);
      // M6: feed the real window-fill signal so the CLI harness exercises the spec-14 token triggers too.
      await sessions.recordPromptUsage(chatId, result.lastPromptTokens);
      process.stdout.write(`🤖 ${result.text}\n\n`);
    } catch (e) {
      process.stdout.write(`❌ Error: ${e}\n\n`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stdout.write(`Fatal error: ${e}\n`);
    process.exit(1);
  });
}
