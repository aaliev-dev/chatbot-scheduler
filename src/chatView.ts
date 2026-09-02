import * as vscode from 'vscode';
import { pickDefaultCopilotModel } from './copilot';
import { parseWhen, WhenParseError } from './parser';
import { Scheduler } from './scheduler';
import { Delivery } from './types';

interface ChatHistoryEntry {
    role: 'user' | 'assistant';
    text: string;
}

const CHAT_SYSTEM_PROMPT =
    'You are ChatBot — a concise, friendly assistant embedded in a VS Code extension sidebar. ' +
    'Answer briefly, in Markdown, and prefer practical, actionable responses.';

/**
 * Custom chat in a webview view (the "replace" part).
 * Talks directly to Copilot models via vscode.lm — the UI, history and
 * features are fully ours, independent of the built-in chat panel.
 * Also hosts the scheduler management UI.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'chatbot.chatView';

    private view?: vscode.WebviewView;
    private history: ChatHistoryEntry[] = [];
    private currentCts: vscode.CancellationTokenSource | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly scheduler: Scheduler
    ) {
        context.subscriptions.push(scheduler.onDidChange(() => this.pushSchedules()));
    }

    resolveWebviewView(
        view: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
        view.webview.html = this.buildHtml(view.webview);
        void view.webview.onDidReceiveMessage((msg: unknown) => { void this.handleMessage(msg); });
        this.pushSchedules();
    }

    // --- messages from the webview -------------------------------------------

    private async handleMessage(raw: unknown): Promise<void> {
        const msg = raw as {
            type?: string;
            text?: string;
            when?: string;
            message?: string;
            delivery?: string;
            id?: string;
        };
        switch (msg?.type) {
            case 'ready':
                this.pushSchedules();
                break;
            case 'chat.send':
                await this.runChat(String(msg.text ?? '').trim());
                break;
            case 'schedule.add':
                this.addSchedule(
                    String(msg.when ?? ''),
                    String(msg.message ?? ''),
                    msg.delivery === 'notification' ? 'notification' : 'chat'
                );
                break;
            case 'schedule.cancel':
                this.scheduler.remove(String(msg.id ?? ''));
                break;
        }
    }

    // --- chat ------------------------------------------------------------------

    private async runChat(text: string): Promise<void> {
        if (!text) { return; }

        // One request at a time: starting a new one cancels the previous.
        this.currentCts?.dispose();
        const cts = new vscode.CancellationTokenSource();
        this.currentCts = cts;

        this.postToView({ type: 'chat.user', text });
        this.postToView({ type: 'chat.assistant.start' });
        try {
            const model = await pickDefaultCopilotModel();
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(CHAT_SYSTEM_PROMPT),
            ];
            for (const entry of this.history.slice(-10)) {
                if (entry.role === 'user') {
                    messages.push(vscode.LanguageModelChatMessage.User(entry.text));
                } else {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(entry.text));
                }
            }
            messages.push(vscode.LanguageModelChatMessage.User(text));

            const response = await model.sendRequest(messages, {}, cts.token);
            let acc = '';
            for await (const chunk of response.text) {
                if (cts.token.isCancellationRequested) { break; }
                acc += chunk;
                this.postToView({ type: 'chat.assistant.delta', text: chunk });
            }
            this.history.push({ role: 'user', text }, { role: 'assistant', text: acc });
            this.postToView({ type: 'chat.assistant.done' });
        } catch (err) {
            this.history.push({ role: 'user', text });
            this.postToView({
                type: 'chat.error',
                message: err instanceof Error ? err.message : String(err),
            });
        } finally {
            if (this.currentCts === cts) {
                cts.dispose();
                this.currentCts = undefined;
            }
        }
    }

    // --- schedules ----------------------------------------------------------------

    private addSchedule(when: string, message: string, delivery: Delivery): void {
        try {
            if (!message) { throw new WhenParseError('Message cannot be empty.'); }
            const parsed = parseWhen(when);
            this.scheduler.add(message, delivery, parsed.at, parsed.repeat);
            this.postToView({
                type: 'schedule.result',
                ok: true,
                text: `Scheduled for ${new Date(parsed.at).toLocaleString()}.`,
            });
            this.pushSchedules();
        } catch (err) {
            this.postToView({
                type: 'schedule.result',
                ok: false,
                text: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private pushSchedules(): void {
        this.postToView({ type: 'schedule.data', schedules: this.scheduler.list() });
    }

    private postToView(msg: unknown): void {
        void this.view?.webview.postMessage(msg);
    }

    // --- html ---------------------------------------------------------------------

    private buildHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const cspSource = webview.cspSource;
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<style>
  body {
    display: flex; flex-direction: column; height: 100vh;
    margin: 0; padding: 10px; box-sizing: border-box;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-sideBar-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  }
  #chat-log { flex: 1; overflow-y: auto; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .msg .role { font-size: 10px; text-transform: uppercase; opacity: .7; margin-bottom: 2px; }
  .msg.user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-focusBorder); }
  .msg.assistant { border-left: 3px solid var(--vscode-charts-blue, #3794ff); }
  .msg.error { color: var(--vscode-errorForeground); }
  .composer { display: flex; gap: 6px; padding-top: 8px; }
  .composer textarea { flex: 1; resize: none; }
  #chat-status { color: var(--vscode-descriptionForeground); font-size: 11px; min-height: 14px; }
  #scheduler { border-top: 1px solid var(--vscode-panel-border, #333); margin-top: 8px; padding-top: 8px; }
  #scheduler h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; opacity: .8; }
  #add-form { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px; }
  #add-form #sch-delivery, #add-form #sch-add { grid-column: 1 / -1; }
  #sch-result { min-height: 1em; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: pre-wrap; }
  #sch-list { list-style: none; margin: 6px 0 0; padding: 0; }
  #sch-list li { display: flex; align-items: baseline; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); }
  #sch-list .when { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 11px; }
  #sch-list .msg-text { flex: 1; word-break: break-word; }
  input, textarea, select, button {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 5px;
    font-family: inherit; font-size: inherit;
  }
  button { cursor: pointer; }
</style>
</head>
<body>
  <div id="chat-log"></div>
  <div id="chat-status"></div>
  <div class="composer">
    <textarea id="chat-input" rows="2" placeholder="Message ChatBot… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="chat-send" title="Send">Send</button>
  </div>

  <section id="scheduler">
    <h2>⏰ Scheduled messages</h2>
    <form id="add-form">
      <input id="sch-when" placeholder="in 2h / at 17:30 / daily 09:00">
      <input id="sch-message" placeholder="Message (may start with @bot, #file…)">
      <select id="sch-delivery">
        <option value="chat">Send to chat panel when due</option>
        <option value="notification">Show a notification when due</option>
      </select>
      <button id="sch-add" type="submit">Schedule</button>
    </form>
    <div id="sch-result"></div>
    <ul id="sch-list"></ul>
  </section>

<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var log = document.getElementById('chat-log');
  var status = document.getElementById('chat-status');
  var streaming = null; // body element of the assistant message being streamed

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  // Note: everything is rendered via textContent — deliberately XSS-safe,
  // model output and user text are never interpreted as HTML.
  function addMsg(role, text) {
    var wrap = el('div', 'msg ' + role);
    wrap.appendChild(el('div', 'role', role));
    var body = el('div', 'body', text);
    wrap.appendChild(body);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return body;
  }

  function send() {
    var input = document.getElementById('chat-input');
    var text = input.value.trim();
    if (!text) { return; }
    input.value = '';
    vscode.postMessage({ type: 'chat.send', text: text });
  }

  function fmt(t) { return new Date(t).toLocaleString(); }

  function renderSchedules(schedules) {
    var ul = document.getElementById('sch-list');
    ul.textContent = '';
    if (!schedules || !schedules.length) {
      ul.appendChild(el('li', null, 'Nothing scheduled yet.'));
      return;
    }
    var sorted = schedules.slice().sort(function (a, b) { return a.fireAt - b.fireAt; });
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      var li = document.createElement('li');
      li.appendChild(el('span', 'when', fmt(s.fireAt) + (s.repeat && s.repeat.kind !== 'none' ? ' ↻' : '')));
      li.appendChild(el('span', 'msg-text', s.message + '  (' + s.delivery + ')'));
      var btn = document.createElement('button');
      btn.textContent = '✕';
      btn.title = 'Cancel this schedule';
      btn.dataset.id = s.id;
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  document.getElementById('chat-send').addEventListener('click', send);
  document.getElementById('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  document.getElementById('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    vscode.postMessage({
      type: 'schedule.add',
      when: document.getElementById('sch-when').value.trim(),
      message: document.getElementById('sch-message').value.trim(),
      delivery: document.getElementById('sch-delivery').value
    });
  });

  document.getElementById('sch-list').addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.dataset && t.dataset.id) {
      vscode.postMessage({ type: 'schedule.cancel', id: t.dataset.id });
    }
  });

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m) { return; }
    if (m.type === 'chat.user') { addMsg('user', m.text); }
    else if (m.type === 'chat.assistant.start') { streaming = addMsg('assistant', ''); status.textContent = 'thinking…'; }
    else if (m.type === 'chat.assistant.delta') {
      if (streaming) { streaming.textContent += m.text; log.scrollTop = log.scrollHeight; }
    }
    else if (m.type === 'chat.assistant.done') { streaming = null; status.textContent = ''; }
    else if (m.type === 'chat.error') { streaming = null; status.textContent = ''; addMsg('error', '⚠ ' + m.message); }
    else if (m.type === 'schedule.data') { renderSchedules(m.schedules); }
    else if (m.type === 'schedule.result') {
      document.getElementById('sch-result').textContent = m.text;
      if (m.ok) {
        document.getElementById('sch-when').value = '';
        document.getElementById('sch-message').value = '';
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
