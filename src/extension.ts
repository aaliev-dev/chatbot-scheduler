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

    /** Direct scheduling: ask for the message, persist, toast with a Cancel
     *  action. Does NOT touch the chat at all (no @bot writes, no bubbles —
     *  the user explicitly wants chat informs out of the way). */
    const scheduleDirect = async (when: string): Promise<void> => {
        const message = await vscode.window.showInputBox({
            title: `Что отправить (${when})?`,
            placeHolder: 'Текст отложенного сообщения',
        });
        if (!message || !message.trim()) { return; }
        let parsed;
        try {
            parsed = parseWhen(when);
        } catch (err) {
            void vscode.window.showErrorMessage(
                `Chat Bot Scheduler: ${err instanceof WhenParseError ? err.message : String(err)}`
            );
            return;
        }
        const s = scheduler.add(message.trim(), 'chat', parsed.at, parsed.repeat);
        const d = new Date(s.fireAt);
        const at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const toast = (msg: string): Thenable<string | undefined> =>
            vscode.window.showInformationMessage(msg, 'Cancel');
        void toast(`Will be sent ${when} (${at}) — “${s.message}”`).then((choice) => {
            if (choice === 'Cancel') {
                scheduler.remove(s.id);
                void vscode.window.showInformationMessage('Schedule cancelled.');
            }
        });
        void parsed; // repeat is embedded in scheduler.add above via parsed
    };

    const pickPeriod = async (): Promise<string | undefined> => {
        const picked = await vscode.window.showQuickPick(DELAY_OPTIONS, {
            placeHolder: 'Когда отправить сообщение?',
            title: 'Chat Bot Scheduler: отложенная отправка',
        });
        return picked?.when;
    };

    register('chatbot.insertSchedule', async (...args: unknown[]) => {
        trace(`insertSchedule invoked (args: ${JSON.stringify(args)?.slice(0, 200) ?? '[]'})`);
        const when = await pickPeriod();
        if (!when) { return; }
        await runScheduleFlow(when);
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

    // Target chat label for a schedule: prefers the chat title (workspace
    // name for untitled sessions), then the first prompt of the conversation.
    const targetLabel = async (s: Schedule): Promise<string> => {
        const wsName = vscode.workspace.name ?? 'this workspace';
        if (!s.history?.length) { return `→ ${wsName}`; }
        const found = await findSessionBySnapshot(context.storageUri, s.history);
        if (found?.title) { return `→ ${found.title}`; }
        const firstPrompt = s.history[0].request.replace(/\s+/g, ' ').trim();
        if (!found) { return `→ (original chat deleted) «${trunc(firstPrompt, 24)}»`; }
        return `→ «${trunc(firstPrompt, 24)}»`;
    };

    const trunc = (text: string, max: number): string =>
        text.length > max ? `${text.slice(0, max - 1)}…` : text;

    /** "Will be sent in 15m (16:59)" phrase, computed back from fire time. */
    const relativeSchedulePhrase = (s: Schedule): string => {
        if (s.repeat.kind === 'daily') {
            return `daily at ${String(s.repeat.hour).padStart(2, '0')}:${String(s.repeat.minute).padStart(2, '0')} —`;
        }
        const diff = s.fireAt - Date.now();
        if (diff <= 0) { return 'now'; }
        const mins = Math.round(diff / 60000);
        if (mins < 60) { return `in ${mins}m`; }
        const hours = Math.round(diff / 3600000);
        if (hours < 24) { return `in ${hours}h`; }
        return `in ${Math.round(diff / 86400000)}d`;
    };

    const showScheduleManager = async (): Promise<void> => {
        interface SchedulePickItem extends vscode.QuickPickItem {
            id?: string;
            /** Set on period rows: picking one starts a new schedule flow. */
            when?: string;
        }
        const deleteButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Delete this schedule',
        };

        // Grouped exactly like @bot /list: chat-title sections, per-chat
        // numbering, "Will be sent in 15m (16:59)" rows, trash per row.
        const buildItems = async (): Promise<SchedulePickItem[]> => {
            const all = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
            const labeled = await Promise.all(
                all.map(async (s) => ({ s, label: await targetLabel(s) }))
            );
            const groups: { label: string; rows: { s: Schedule; label: string }[] }[] = [];
            for (const e of labeled) {
                let g = groups.find((x) => x.label === e.label);
                if (!g) {
                    g = { label: e.label, rows: [] };
                    groups.push(g);
                }
                g.rows.push(e);
            }

            const items: SchedulePickItem[] = [];
            for (const g of groups) {
                items.push({
                    label: g.label.replace('→ ', ''),
                    kind: vscode.QuickPickItemKind.Separator,
                });
                g.rows
                    .sort((a, b) => a.s.fireAt - b.s.fireAt)
                    .forEach((r, i) => {
                        const abs = new Date(r.s.fireAt);
                        const at = `${String(abs.getHours()).padStart(2, '0')}:${String(abs.getMinutes()).padStart(2, '0')}`;
                        items.push({
                            id: r.s.id,
                            label: `${i + 1}. Will be sent ${relativeSchedulePhrase(r.s)} (${at}) “${r.s.message.slice(0, 60)}”`,
                            buttons: [deleteButton],
                        });
                    });
            }
            return items;
        };

        // Under the grouped list: period rows for scheduling something new.
        const appendPeriodItems = (items: SchedulePickItem[]): void => {
            items.push({
                label: 'New scheduled message',
                kind: vscode.QuickPickItemKind.Separator,
            });
            for (const o of DELAY_OPTIONS) {
                items.push({ label: o.label, when: o.when, alwaysShow: true });
            }
        };

        const qp = vscode.window.createQuickPick<SchedulePickItem>();

        const refresh = async (): Promise<void> => {
            if (scheduler.list().length) {
                const items = await buildItems();
                appendPeriodItems(items);
                qp.items = items;
            } else {
                qp.hide();
            }
        };

        // Idle calendar behaves like the clock did: straight to the picker.
        if (!scheduler.list().length) {
            const when = await pickPeriod();
            if (when) { await scheduleDirect(when); }
            return;
        }

        {
            const items = await buildItems();
            appendPeriodItems(items);
            qp.items = items;
        }
        qp.placeholder = 'Enter or 🗑 deletes the selected schedule · pick a period below to schedule new';
        const remove = async (item: SchedulePickItem): Promise<void> => {
            if (item.id) { scheduler.remove(item.id); }
            await refresh();
        };

        qp.onDidTriggerItemButton((e) => { void remove(e.item as SchedulePickItem); });
        qp.onDidAccept(async () => {
            const sel = qp.selectedItems[0];
            if (!sel) { return; }
            if (sel.id) {
                await remove(sel);
                return;
            }
            // Period row → direct scheduling (no chat writes).
            qp.hide();
            if (sel.when) { await scheduleDirect(sel.when); }
        });
        qp.show();
    };

    // Single calendar button in the title bar — one icon, no state swapping
    // (the two-icon highlight caused two calendars to render side by side).
    // Pending schedules are communicated by the creation toast and /list.
    // One calendar button, two colors: grey codicon when idle, the same
    // official glyph painted red when schedules exist. The swap is driven by
    // the chatbotHasSchedules context key (raw truthiness in when-clauses).
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
