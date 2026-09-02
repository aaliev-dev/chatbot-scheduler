import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';
import { parseWhen, WhenParseError } from './parser';
import { registerChatParticipant } from './participant';
import { Scheduler } from './scheduler';
import { Delivery, Schedule } from './types';

export function activate(context: vscode.ExtensionContext): void {
    const scheduler = new Scheduler(context.globalState);

    // ---------------------------------------------------------------------------
    // Delivery: what actually happens when a scheduled message fires.
    // 'chat' opens the native chat panel and submits the message as a query —
    // so "check TODOs in 2h" lands right where you'd type it.
    // ---------------------------------------------------------------------------
    const openInChat = (query: string): void => {
        void vscode.commands
            .executeCommand('workbench.action.chat.open', { query })
            .then(undefined, (err: unknown) => {
                void vscode.window.showWarningMessage(
                    `ChatBot: could not open the chat panel (${String(err)}). Message was: "${query}"`
                );
            });
    };

    const deliver = (s: Schedule): void => {
        if (s.delivery === 'chat') {
            openInChat(s.message);
        } else {
            void vscode.window
                .showInformationMessage(`⏰ ${s.message}`, 'Open Chat')
                .then((choice) => {
                    if (choice === 'Open Chat') { openInChat(s.message); }
                });
        }
    };

    scheduler.onFire(deliver);
    context.subscriptions.push(scheduler);

    // Background windows throttle timers → catch up when focus returns.
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) { scheduler.checkDue(); }
        })
    );

    // "Дополнить": @bot participant in the native chat panel.
    registerChatParticipant(context, scheduler);

    // "Заменить": own chat UI + scheduler management in the sidebar.
    const chatProvider = new ChatViewProvider(context, scheduler);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider),

        vscode.commands.registerCommand('chatbot.scheduleMessage', async () => {
            const message = await vscode.window.showInputBox({
                title: 'Message to deliver',
                prompt: 'For chat delivery this is submitted as a chat query — you can use @participants, #files, etc.',
                placeHolder: 'e.g. @bot summarize the open TODOs',
            });
            if (message === undefined || !message.trim()) { return; }

            const when = await vscode.window.showInputBox({
                title: 'When to deliver',
                placeHolder: 'in 2h · in 1h 30m · at 17:30 · at 17:30 tomorrow · daily 09:00',
            });
            if (when === undefined) { return; }

            try {
                const parsed = parseWhen(when);
                const delivery = await pickDelivery();
                if (!delivery) { return; }
                const s = scheduler.add(message.trim(), delivery, parsed.at, parsed.repeat);
                void vscode.window.showInformationMessage(
                    `⏰ ChatBot: "${s.message}" scheduled for ${fmtDate(s.fireAt)}${repeatSuffix(s)}.`
                );
            } catch (err) {
                if (err instanceof WhenParseError) {
                    void vscode.window.showErrorMessage(`ChatBot: ${err.message}`);
                } else {
                    throw err;
                }
            }
        }),

        vscode.commands.registerCommand('chatbot.listSchedules', () => {
            const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
            const toItems = (): (vscode.QuickPickItem & { id: string })[] =>
                [...scheduler.list()]
                    .sort((a, b) => a.fireAt - b.fireAt)
                    .map((s) => ({
                        id: s.id,
                        label: `$(clock) ${fmtDate(s.fireAt)}${repeatSuffix(s)}`,
                        description: s.delivery,
                        detail: s.message,
                    }));

            const items = toItems();
            if (!items.length) {
                void vscode.window.showInformationMessage('ChatBot: no scheduled messages.');
                return;
            }
            qp.placeholder = 'Select a schedule to cancel it';
            qp.items = items;
            qp.onDidAccept(() => {
                const sel = qp.selectedItems[0];
                if (!sel) { return; }
                scheduler.remove(sel.id);
                const rest = toItems();
                if (rest.length) {
                    qp.items = rest;
                } else {
                    qp.hide();
                    void vscode.window.showInformationMessage('ChatBot: all schedules cancelled.');
                }
            });
            qp.show();
        })
    );
}

export function deactivate(): void {
    // nothing to clean up beyond context.subscriptions
}

// --- helpers ------------------------------------------------------------------

async function pickDelivery(): Promise<Delivery | undefined> {
    const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: Delivery }>([
        {
            label: 'Send to Chat',
            value: 'chat',
            description: 'Opens the chat panel and submits the message',
        },
        {
            label: 'Notification',
            value: 'notification',
            description: 'Shows an information notification',
        },
    ], { placeHolder: 'How should the message be delivered?' });
    return pick?.value;
}

function fmtDate(t: number): string {
    return new Date(t).toLocaleString();
}

function repeatSuffix(s: Schedule): string {
    if (s.repeat.kind === 'daily') {
        return ` (daily at ${pad2(s.repeat.hour)}:${pad2(s.repeat.minute)})`;
    }
    return s.repeat.kind === 'none' ? '' : ' (recurring)';
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}
