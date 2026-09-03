import * as vscode from 'vscode';
import { parseWhen, WhenParseError } from './parser';
import { registerChatParticipant } from './participant';
import { Scheduler } from './scheduler';
import { findSessionBySnapshot } from './sessionFinder';
import { Delivery, Schedule } from './types';

export function activate(context: vscode.ExtensionContext): void {
    // Shared delay options for the clock button and "change time" flows.
    const DELAY_OPTIONS: (vscode.QuickPickItem & { when: string })[] = [
        { label: '$(clock) 15 минут', when: '15m' },
        { label: '$(clock) 30 минут', when: '30m' },
        { label: '$(clock) 1 час', when: '1h' },
        { label: '$(clock) 2 часа', when: '2h' },
        { label: '$(clock) 3 часа', when: '3h' },
        { label: '$(calendar) Другое время…', when: 'custom' },
    ];
    // Instrumentation goes to the exthost console log — survives even if the
    // extension dies mid-way, unlike the Output channel. Remove once stable.
    const trace = (msg: string): void => {
        console.log(`[chatbot] ${msg}`);
        log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    };

    // Lightweight diagnostics channel: visible in Output → "ChatBot", so
    // "nothing happens" reports can be traced to a concrete step next time.
    const log = vscode.window.createOutputChannel('ChatBot');
    context.subscriptions.push(log);

    trace(`activate start (v${context.extension.packageJSON.version ?? '?'})`);

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
    const submitQuery = (
        query: string,
        previousRequests?: { request: string; response: string }[]
    ): Thenable<unknown> =>
        vscode.commands.executeCommand('workbench.action.chat.open', {
            query,
            // Never clobber the user's draft: submit this query while keeping
            // whatever text is currently typed in the chat input box.
            preserveInput: true,
            ...(previousRequests?.length ? { previousRequests: previousRequests.slice(-25) } : {}),
        });

    /**
     * Cross-window race guard: two VS Code windows share globalState and both
     * keep in-memory copies of the schedule — both timers fire at the same
     * second. The first window writes its claim; the second one sees a claim
     * from the other window and backs off.
     */
    const claimDelivery = async (id: string): Promise<boolean> => {
        const key = `chatbot.delivered.${id}`;
        if (context.globalState.get<string>(key)) { return false; }
        const mine = `win:${Math.random()}`;
        await context.globalState.update(key, mine);
        await new Promise((r) => setTimeout(r, 120));
        return context.globalState.get<string>(key) === mine;
    };

    /** True when an editor tab for this chat session is visible AND active right now. */
    const isSessionTabActive = (resource: vscode.Uri): boolean => {
        try {
            const active = vscode.window.tabGroups.activeTabGroup?.activeTab;
            const uri = (active?.input as { uri?: vscode.Uri } | undefined)?.uri;
            return uri?.toString() === resource.toString();
        } catch {
            return false;
        }
    };

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
            // Cross-window guard first: only one VS Code window delivers.
            if (s.delivery === 'chat' && !(await claimDelivery(s.id))) { return; }

            // Core semantics (user requirement): find the TARGET chat by its
            // conversation snapshot and deliver THERE, always — even if the
            // user has since moved to another chat.
            if (s.history?.length) {
                const found = await findSessionBySnapshot(context.storageUri, s.history);
                if (!found) {
                    // Target chat deleted → continue the dialogue in a fresh
                    // chat seeded with the captured history.
                    await vscode.commands.executeCommand('workbench.action.chat.newChat');
                    await submitQuery(s.message, s.history);
                    return;
                }
                if (isSessionTabActive(found.resource)) {
                    // Target chat is open and in front right now → zero noise.
                    await submitQuery(s.message);
                    return;
                }
                // Route to the target chat: reveal its existing editor tab
                // (revealIfOpened prevents duplicates) and submit there.
                await vscode.commands.executeCommand('vscode.open', found.resource, { revealIfOpened: true });
                await submitQuery(s.message);
                return;
            }
            await submitQuery(s.message);
        } catch (err) {
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
    trace('participant registered');

    // Hot-swap guard: reinstalling the extension with --force into a live
    // window can activate a second instance while the first still holds the
    // command registrations ("command 'x' already exists"). Losing the
    // registration race must not kill activation — the surviving instance
    // keeps serving the command either way.
    const register = (command: string, handler: (...args: never[]) => unknown): void => {
        try {
            context.subscriptions.push(vscode.commands.registerCommand(command, handler));
        } catch (err) {
            trace(`registerCommand(${command}) conflict (hot-swap): ${String(err)}`);
        }
    };

    // Clock button in the chat input status area:
    // pick a delay → if the input has a draft, compose & submit the schedule
    // command with it; if the input is empty, prefill the command template.
    register('chatbot.insertSchedule', async (...args: unknown[]) => {
            trace(`insertSchedule invoked (args: ${JSON.stringify(args)?.slice(0, 200) ?? '[]'})`);
            try {
            const picked = await vscode.window.showQuickPick(DELAY_OPTIONS.filter(o => o.when !== 'custom'), {
                placeHolder: 'Когда отправить сообщение?',
                title: 'ChatBot: отложенная отправка',
            });
            if (!picked) {
                trace('  picker dismissed without a choice');
                return;
            }

            const prefix = `@bot /schedule in ${picked.when}`;
            const draft = await readChatDraft();
            trace(
                `  delay=${picked.when} draft=${draft === undefined ? 'unreadable' : JSON.stringify(draft.slice(0, 80))}`
            );
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
            trace('  insertSchedule finished OK');
            } catch (err) {
                trace(`  insertSchedule FAILED: ${String(err)}`);
                throw err;
            }
        });

    register('chatbot.scheduleMessage', async () => {
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
        });

    // Target chat label for a schedule: derived from its conversation
    // snapshot — the first user prompt of the founding session identifies the
    // chat naturally ("the chat about the job"). Schedules created outside a
    // chat (@bot) have no snapshot and go to the focused chat.
    const targetLabel = async (s: Schedule): Promise<string> => {
        if (!s.history?.length) { return '→ focused chat'; }
        const found = await findSessionBySnapshot(context.storageUri, s.history);
        const firstPrompt = s.history[0].request.replace(/\s+/g, ' ').trim();
        if (!found) { return `→ (original chat deleted) «${trunc(firstPrompt, 24)}»`; }
        return `→ «${trunc(firstPrompt, 24)}»`;
    };

    const trunc = (text: string, max: number): string =>
        text.length > max ? `${text.slice(0, max - 1)}…` : text;

    const showScheduleManager = async (): Promise<void> => {
        interface SchedulePickItem extends vscode.QuickPickItem {
            id: string;
        }
        const deleteButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Delete this schedule',
        };
        const sorted = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
        if (!sorted.length) {
            void vscode.window.showInformationMessage(
                'Chat Bot Scheduler: no scheduled messages yet. Create one with the ⏱ button or ⌘⌥S.'
            );
            return;
        }
        const toItems = async (): Promise<SchedulePickItem[]> => {
            const sorted_ = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
            const labels = await Promise.all(sorted_.map(targetLabel));
            return sorted_.map((s, i) => ({
                id: s.id,
                label: `$(clock) ${fmtDate(s.fireAt)}${repeatSuffix(s)}`,
                description: labels[i],
                detail: `#${i + 1} · ${s.message}`,
                buttons: [deleteButton],
            }));
        };

        const qp = vscode.window.createQuickPick<SchedulePickItem>();
        qp.items = await toItems();

        const refreshOrHide = async (): Promise<void> => {
            if (scheduler.list().length) {
                qp.items = await toItems();
            } else {
                qp.hide();
                void vscode.window.showInformationMessage('Chat Bot Scheduler: all schedules deleted.');
            }
        };
        const remove = async (item: SchedulePickItem): Promise<void> => {
            scheduler.remove(item.id);
            await refreshOrHide();
        };

        qp.placeholder = 'Enter or 🗑 deletes the selected schedule';
        qp.onDidTriggerItemButton((e) => { void remove(e.item as SchedulePickItem); });
        qp.onDidAccept(async () => {
            const sel = qp.selectedItems[0];
            if (sel) { await remove(sel); }
        });
        qp.show();
    };

    // One command, two faces: the title-bar icon switches to a "pending" bell
    // (via the chatbotHasSchedules context key) whenever schedules exist.
    // This is how the calendar stays grey while idle and highlighted when
    // there is anything pending.
    register('chatbot.listSchedules', () => { void showScheduleManager(); });
    register('chatbot.listSchedulesActive', () => { void showScheduleManager(); });

    const updateHasSchedules = (): void => {
        void vscode.commands.executeCommand('setContext', 'chatbotHasSchedules', scheduler.list().length > 0);
    };
    updateHasSchedules();
    context.subscriptions.push(scheduler.onDidChange(updateHasSchedules));

    // Inline buttons in the @bot confirmation message (command links).
    // With an id arg — act on that schedule; without — fall back to the manager.
    register('chatbot.removeSchedule', async (id?: string) => {
        if (!id || !scheduler.remove(id)) {
            void vscode.window.showWarningMessage('Chat Bot Scheduler: this schedule is already gone.');
            return;
        }
        void vscode.window.showInformationMessage('🗑 Schedule cancelled.');
    });

    register('chatbot.rescheduleSchedule', async (id?: string) => {
        if (!id) {
            void vscode.window.showWarningMessage('Chat Bot Scheduler: this schedule is already gone.');
            return;
        }
        const target = scheduler.list().find((s) => s.id === id);
        if (!target) {
            void vscode.window.showWarningMessage('Chat Bot Scheduler: this schedule is already gone.');
            return;
        }
        const picked = await vscode.window.showQuickPick(DELAY_OPTIONS, {
            placeHolder: `Новое время для «${target.message.slice(0, 40)}»`,
            title: 'Chat Bot Scheduler: перенос отложенного сообщения',
        });
        if (!picked) { return; }

        let parsed: { at: number; repeat: typeof target.repeat };
        if (picked.when === 'custom') {
            const when = await vscode.window.showInputBox({
                title: 'Когда доставить',
                placeHolder: 'in 1h 30m · at 17:30 · at 17:30 tomorrow · daily 09:00',
            });
            if (when === undefined) { return; }
            try {
                parsed = parseWhen(when);
            } catch (err) {
                void vscode.window.showErrorMessage(`Chat Bot Scheduler: ${err instanceof WhenParseError ? err.message : String(err)}`);
                return;
            }
        } else {
            parsed = parseWhen(picked.when);
        }

        if (scheduler.reschedule(id, parsed.at, parsed.repeat)) {
            void vscode.window.showInformationMessage(`⏱ Rescheduled to ${fmtDate(parsed.at)}.`);
        }
    });

    trace('activate complete — all commands registered');
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
