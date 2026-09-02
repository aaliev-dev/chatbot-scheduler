import * as vscode from 'vscode';
import { pickDefaultCopilotModel } from './copilot';
import { parseWhen, splitWhenAndMessage, WhenParseError } from './parser';
import { Scheduler } from './scheduler';
import { Schedule } from './types';

const SYSTEM_PROMPT =
    'You are ChatBot — a concise, friendly assistant living in a VS Code extension. ' +
    'Answer in Markdown, get to the point, and prefer practical, actionable advice.';

/**
 * Registers the "@bot" participant in the NATIVE chat panel.
 * This is the "дополнить" part: the user keeps the built-in chat UX,
 * but gets an agent of their own with extra commands (/schedule, /list).
 */
export function registerChatParticipant(context: vscode.ExtensionContext, scheduler: Scheduler): void {
    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        try {
            if (request.command === 'schedule') {
                handleScheduleCommand(request, scheduler, stream);
                return {};
            }
            if (request.command === 'list') {
                renderScheduleList(scheduler, stream);
                return {};
            }
            await handleChat(request, chatContext, stream, token);
        } catch (err) {
            stream.markdown(`⚠️ ${errorMessage(err)}`);
        }
        return {};
    };

    const participant = vscode.chat.createChatParticipant('chatbot.scheduler', handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'bot.svg');
    context.subscriptions.push(participant);
}

// --- /schedule --------------------------------------------------------------

function handleScheduleCommand(request: vscode.ChatRequest, scheduler: Scheduler, stream: vscode.ChatResponseStream): void {
    const prompt = request.prompt.trim();
    if (!prompt) {
        stream.markdown(
            'Schedules a delayed message (like Telegram). When the time comes, ' +
            'the message is submitted to the chat panel automatically:\n\n' +
            '```\n/schedule in 2h :: summarize what changed in the workspace\n```\n\n' +
            '`when` accepts: `in 10m` · `in 1h 30m` · `at 17:30` · `at 17:30 tomorrow` · `daily 09:30` · ISO timestamps.\n' +
            'Short form works too: `/schedule in 2h check the TODOs`.'
        );
        return;
    }
    try {
        const { when, message } = splitWhenAndMessage(prompt);
        if (!message) { throw new WhenParseError('The message part is empty.'); }
        const parsed = parseWhen(when);
        const s = scheduler.add(message, 'chat', parsed.at, parsed.repeat);
        stream.markdown(
            `⏰ Scheduled for **${fmtDate(s.fireAt)}**${repeatSuffix(s)}.\n\n` +
            `Message: \`${s.message.replace(/`/g, "'")}\`\n\n` +
            'It will be submitted to the chat panel automatically when the time comes.'
        );
    } catch (err) {
        stream.markdown(`⚠️ ${errorMessage(err)}`);
    }
}

// --- /list -------------------------------------------------------------------

function renderScheduleList(scheduler: Scheduler, stream: vscode.ChatResponseStream): void {
    const all = [...scheduler.list()].sort((a, b) => a.fireAt - b.fireAt);
    if (!all.length) {
        stream.markdown('No scheduled messages yet. Add one with `/schedule in 2h :: hello`. Or use **ChatBot: Schedule Message** from the Command Palette.');
        return;
    }
    stream.markdown('| When | Message | Delivery |\n|---|---|---|\n');
    for (const s of all) {
        stream.markdown(`| ${fmtDate(s.fireAt)}${repeatSuffix(s)} | \`${escapeCell(s.message)}\` | ${s.delivery} |\n`);
    }
}

// --- plain chat --------------------------------------------------------------

async function handleChat(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    try {
        // Prefer the model the user picked in the chat dropdown, if exposed on the request.
        const fromRequest = (request as unknown as { model?: vscode.LanguageModelChat }).model;
        const model = fromRequest ?? await pickDefaultCopilotModel();

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
        ];

        // Replay a few recent turns so the agent has conversational context.
        for (const turn of chatContext.history.slice(-6)) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const text = turn.response
                    .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ''))
                    .join('')
                    .trim();
                if (text) { messages.push(vscode.LanguageModelChatMessage.Assistant(text)); }
            }
        }

        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        const response = await model.sendRequest(messages, {}, token);
        for await (const fragment of response.text) {
            stream.markdown(fragment);
            if (token.isCancellationRequested) { return; }
        }
    } catch (err) {
        stream.markdown(`⚠️ ${errorMessage(err)}`);
    }
}

// --- helpers ------------------------------------------------------------------

function errorMessage(err: unknown): string {
    if (err instanceof vscode.LanguageModelError) {
        return `Language model error: ${err.message} (code: ${err.code ?? 'n/a'})`;
    }
    if (err instanceof WhenParseError) { return err.message; }
    return err instanceof Error ? err.message : String(err);
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

function escapeCell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/`/g, "'");
}
