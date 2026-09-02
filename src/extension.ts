import * as vscode from 'vscode';
import { parseWhen, WhenParseError } from './parser';
import { registerChatParticipant } from './participant';
import { Scheduler } from './scheduler';
import { findSessionBySnapshot } from './sessionFinder';
import { Delivery, Schedule } from './types';

export function activate(context: vscode.ExtensionContext): void {
    const scheduler = new Scheduler(context.globalState);

    // ---------------------------------------------------------------------------
    // Delivery: what actually happens when a scheduled message fires.
    //
    // 1. Snapshot match (best): find the stored chat session whose history
    //    contains the conversation snapshot captured at /schedule time, open
    //    THAT chat, and submit the message into it.
    // 2. Re-seed (fallback): the chat was deleted or storage changed — open a
    //    new chat seeded with the captured conversation via previousRequests,
    //    so the message lands in a continuation of the same dialogue.
    // 3. Plain: schedules created outside a chat (Command Palette) just go to
    //    the chat widget that last had focus.
    // ---------------------------------------------------------------------------
    const submitQuery = (query: string, previousRequests?: { request: string; response: string }[]): Thenable<unknown> =>
        vscode.commands.executeCommand('workbench.action.chat.open', {
            query,
            ...(previousRequests?.length ? { previousRequests: previousRequests.slice(-25) } : {}),
        });

    const deliver = async (s: Schedule): Promise<void> => {
        if (s.delivery === 'notification') {
            void vscode.window
                .showInformationMessage(`⏰ ${s.message}`, 'Open Chat')
                .then((choice) => {
                    if (choice === 'Open Chat') { void submitQuery(s.message); }
                });
            return;
        }

        try {
            if (s.history?.length) {
                const found = await findSessionBySnapshot(context.storageUri, s.history);
                if (found) {
                    // Same chat found → open it and submit the message there.
                    await vscode.commands.executeCommand('vscode.open', found.resource);
                    await submitQuery(s.message);
                    return;
                }
                // Chat not found → continue the conversation in a fresh chat.
                await vscode.commands.executeCommand('workbench.action.chat.newChat');
                await submitQuery(s.message, s.history);
                return;
            }
            await submitQuery(s.message);
        } catch (err) {
            // Last resort: plain submit to the focused chat.
            try {
                await submitQuery(s.message);
            } catch {
                void vscode.window.showWarningMessage(
                    `ChatBot: could not deliver the scheduled message (${String(err)}). Message: "${s.message}"`
                );
            }
        }
    };

    scheduler.onFire((s) => { void deliver(s); });
    context.subscriptions.push(scheduler);

    // Background windows throttle timers → catch up when focus returns.
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) { scheduler.checkDue(); }
        })
    );

    // "Дополнить": @bot participant in the native chat panel.
    registerChatParticipant(context, scheduler);

    context.subscriptions.push(
        // Clock button in the chat input status area:
        // pick a delay → if the input has a draft, compose & submit the schedule
        // command with it; if the input is empty, prefill the command template.
        vscode.commands.registerCommand('chatbot.insertSchedule', async () => {
            const DELAYS: (vscode.QuickPickItem & { when: string })[] = [
                { label: '$(clock) 15 минут', when: '15m' },
                { label: '$(clock) 30 минут', when: '30m' },
                { label: '$(clock) 1 час', when: '1h' },
                { label: '$(clock) 2 часа', when: '2h' },
                { label: '$(clock) 3 часа', when: '3h' },
            ];
            const picked = await vscode.window.showQuickPick(DELAYS, {
                placeHolder: 'Когда отправить сообщение?',
                title: 'ChatBot: отложенная отправка',
            });
            if (!picked) { return; }

            const prefix = `@bot /schedule in ${picked.when}`;
            const draft = await readChatDraft();
            if (draft !== undefined && draft.trim()) {
                // Draft exists → schedule it right away (submit immediately).
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: `${prefix} :: ${draft.trim()}`,
                });
            } else {
                // Empty or unreadable input → just insert the template, no submit.
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: `${prefix} :: `,
                    isPartialQuery: true,
                });
            }
        }),

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

/**
 * Reads the current text in the native chat input.
 *
 * Theory: there is no public API to read the chat input draft, but the input
 * is a Monaco editor, and generic editor commands route to the focused
 * editor. So we borrow the clipboard for a moment:
 *
 *   save clipboard → drop a sentinel → focusInput → selectAll → copy → read
 *
 * If the clipboard now differs from the sentinel, it holds the draft; if it is
 * still the sentinel, the input was empty (copy had nothing to overwrite
 * with). The saved clipboard content is restored in `finally`.
 *
 * Caveat, honestly: `clipboard.readText/writeText` are text-only. If the user
 * had a non-text payload (e.g. a screenshot) in the clipboard, it cannot be
 * saved or restored and is lost by this action.
 */
const DRAFT_PROBE = '\u2063chatbot:draft-probe';

async function readChatDraft(): Promise<string | undefined> {
    let saved = '';
    try {
        saved = await vscode.env.clipboard.readText();
    } catch {
        saved = '';
    }
    try {
        await vscode.env.clipboard.writeText(DRAFT_PROBE);
        await clipboardBecomes((v) => v === DRAFT_PROBE, 300);

        await vscode.commands.executeCommand('workbench.action.chat.focusInput');
        await sleep(60); // let the input actually take focus
        await vscode.commands.executeCommand('editor.action.selectAll');
        await sleep(30);
        await vscode.commands.executeCommand('editor.action.clipboardCopyAction');

        // Empty input leaves the sentinel in place — 400ms is enough to see that.
        const copied = await clipboardBecomes((v) => v !== DRAFT_PROBE && v !== '', 400);
        return copied === DRAFT_PROBE || copied === '' ? '' : copied;
    } catch {
        return undefined;
    } finally {
        try { await vscode.env.clipboard.writeText(saved); } catch { /* best effort */ }
    }
}

/** Polls the clipboard until `predicate` holds or timeout — Electron writes
 *  are occasionally asynchronous, so a bare read can race the write. */
async function clipboardBecomes(predicate: (v: string) => boolean, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let value = await vscode.env.clipboard.readText();
    while (!predicate(value) && Date.now() < deadline) {
        await sleep(40);
        value = await vscode.env.clipboard.readText();
    }
    return value;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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
