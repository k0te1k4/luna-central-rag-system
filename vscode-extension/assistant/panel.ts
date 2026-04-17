import * as vscode from 'vscode';

export type AssistantPanelCallbacks = {
  onAsk: (question: string, onDelta?: (deltaText: string) => void) => Promise<string>;
  onReindex: () => Promise<void>;
};

export class AssistantPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly cb: AssistantPanelCallbacks) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'lunaAssistant',
      'LuNA AI Assistant (Knowledge Base RAG)',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    const webview = this.panel.webview;
    webview.html = getHtml();

    webview.onDidReceiveMessage(async (msg: any) => {
      try {
        if (msg?.type === 'ask') {
          const q = String(msg.question ?? '').trim();
          if (!q) return;
          const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          // Tell UI to create a placeholder message that we'll stream into.
          webview.postMessage({ type: 'answerStart', requestId });
          const a = await this.cb.onAsk(q, deltaText => {
            webview.postMessage({ type: 'answerDelta', requestId, delta: deltaText });
          });
          webview.postMessage({ type: 'answerDone', requestId, answer: a });
        } else if (msg?.type === 'reindex') {
          await this.cb.onReindex();
          webview.postMessage({ type: 'system', text: '✅ Индекс базы знаний обновлён.' });
        }
      } catch (e: any) {
        webview.postMessage({ type: 'error', text: e?.message ?? String(e) });
      }
    });
  }

  /**
   * Run an "ask" from the extension side (e.g. from a command), but render the result inside the chat panel.
   */
  async runAsk(question: string): Promise<void> {
    await this.runCustom(question, onDelta => this.cb.onAsk(String(question ?? '').trim(), onDelta));
  }

  async runCustom(
    question: string,
    runner: (onDelta?: (deltaText: string) => void) => Promise<string>
  ): Promise<void> {
    const q = String(question ?? '').trim();
    if (!q) return;

    if (!this.panel) this.show();
    if (!this.panel) return;

    const webview = this.panel.webview;

    // Show the user's message in the chat.
    webview.postMessage({ type: 'user', text: 'Вы: ' + q });

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    webview.postMessage({ type: 'answerStart', requestId });
    try {
      const a = await runner(deltaText => {
        webview.postMessage({ type: 'answerDelta', requestId, delta: deltaText });
      });
      webview.postMessage({ type: 'answerDone', requestId, answer: a });
    } catch (e: any) {
      webview.postMessage({ type: 'error', text: e?.message ?? String(e) });
    }
  }
}

function getHtml(): string {
  // Minimal webview UI (no frameworks).
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LuNA Assistant</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif; margin: 0; padding: 0; }
    header { padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,0.3); display: flex; gap: 8px; align-items: center; }
    header h1 { font-size: 14px; margin: 0; font-weight: 600; flex: 1; }
    button { padding: 6px 10px; font-size: 12px; }
    #log { padding: 12px; height: calc(100vh - 100px); overflow: auto; }
    .msg { margin: 0 0 10px 0; white-space: pre-wrap; line-height: 1.35; }
    .me { font-weight: 600; }
    .err { color: #b00020; }
    footer { padding: 10px 12px; border-top: 1px solid rgba(127,127,127,0.3); display: flex; gap: 8px; }
    input { flex: 1; padding: 8px; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h1>LuNA AI Assistant (RAG по базе знаний)</h1>
    <button id="reindex">Reindex knowledge base</button>
  </header>
  <div id="log"></div>
  <footer>
    <input id="q" placeholder="Спросите по документации LuNA…" />
    <button id="ask">Ask</button>
  </footer>
  <script>
    const vscode = acquireVsCodeApi();
    const log = document.getElementById('log');
    const q = document.getElementById('q');
    const btn = document.getElementById('ask');
    const reindex = document.getElementById('reindex');

    function add(text, cls) {
      const p = document.createElement('p');
      p.className = 'msg ' + (cls||'');
      p.textContent = text;
      log.appendChild(p);
      log.scrollTop = log.scrollHeight;
      return p;
    }

    const streaming = new Map();

    function ask() {
      const question = (q.value || '').trim();
      if (!question) return;
      add('Вы: ' + question, 'me');
      vscode.postMessage({ type: 'ask', question });
      q.value = '';
    }

    btn.addEventListener('click', ask);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    reindex.addEventListener('click', () => {
      add('⏳ Перестраиваю индекс базы знаний…');
      vscode.postMessage({ type: 'reindex' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg?.type === 'user') add(msg.text, 'me');
      if (msg?.type === 'answerStart') {
        const el = add('Ассистент: ', '');
        streaming.set(msg.requestId, { el, text: '' });
      }
      if (msg?.type === 'answerDelta') {
        const s = streaming.get(msg.requestId);
        if (s) {
          s.text += (msg.delta || '');
          s.el.textContent = 'Ассистент: ' + s.text;
          log.scrollTop = log.scrollHeight;
        }
      }
      if (msg?.type === 'answerDone') {
        const s = streaming.get(msg.requestId);
        if (s) {
          const finalText = (msg.answer || '').trim();
          s.el.textContent = 'Ассистент: ' + finalText;
          streaming.delete(msg.requestId);
        } else {
          add('Ассистент: ' + (msg.answer||''));
        }
      }
      if (msg?.type === 'user') add(msg.text, 'me');
      if (msg?.type === 'system') add(msg.text);
      if (msg?.type === 'error') add('Ошибка: ' + msg.text, 'err');
    });

    add('Подсказка: можно писать “в текущем файле/в открытой программе/в редакторе” — ассистент сам приложит код из активного редактора. Для новой схемы включите luna.backend.enabled, укажите luna.backend.baseUrl и luna.backend.projectSlug.');
  </script>
</body>
</html>`;
}
