import { readdir, readFile, stat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { SnapshotTurn } from './types';

// Reconstructed from VS Code core (src/vs/workbench/contrib/chat/common/):
//   Schemas.vscodeLocalChatSession = 'vscode-chat-session'
//   LocalChatSessionUri.forSession(id) = vscode-chat-session://local/<base64url(id)>
// These are internal constants — if VS Code changes them, lookups here simply
// fail and callers fall back to the previousRequests re-seeding strategy.
const SESSION_SCHEME = 'vscode-chat-session';
const LOCAL_AUTHORITY = 'local';

export interface FoundSession {
    /** Session id = file name inside the chatSessions storage folder. */
    sessionId: string;
    /** URI that `vscode.open` understands as "open this chat session". */
    resource: vscode.Uri;
    /** How many snapshot prompts matched (1..needles). */
    score: number;
    /** Human chat title from the session index, when available. */
    title?: string;
}

/** Builds a `vscode-chat-session://local/...` URI; mirrors LocalChatSessionUri.forSession(). */
export function localSessionResource(sessionId: string): vscode.Uri {
    const encoded = Buffer.from(sessionId, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return vscode.Uri.parse(`${SESSION_SCHEME}://${LOCAL_AUTHORITY}/${encoded}`);
}

/**
 * Finds the stored chat session whose history contains the snapshot prompts.
 *
 * Theory: VS Code persists every chat as `<workspaceStorage>/<ws>/chatSessions/<id>.json`
 * (`.jsonl` in newer builds). Our extension's `storageUri` is a sibling of that
 * folder, so we can scan it. Matching is deliberately format-agnostic: instead of
 * parsing the internal serialization, we look for the JSON-escaped prompt text as
 * a substring — it appears verbatim in both the flat and the append-log format.
 *
 * Escaping trick: `JSON.stringify(s).slice(1, -1)` yields exactly how `s` is
 * embedded inside any JSON document, quotes and newlines included.
 */
export async function findSessionBySnapshot(
    storageUri: vscode.Uri | undefined,
    history: SnapshotTurn[]
): Promise<FoundSession | undefined> {
    if (!storageUri || history.length === 0) { return undefined; }

    const chatDir = path.join(storageUri.fsPath, '..', 'chatSessions');
    let files: string[];
    try {
        files = await readdir(chatDir);
    } catch {
        return undefined; // storage layout not found — fallback path
    }

    // Match on the last few user prompts. Two needle variants per prompt:
    //  - the prompt as reported by ChatRequestTurn (participant prefix stripped)
    //  - the same text with its first word dropped (in case the stored message
    //    keeps the "@participant " / slash-command prefix instead)
    const needles = history.slice(-4).flatMap((turn) => {
        const variants = [JSON.stringify(turn.request).slice(1, -1)];
        const rest = turn.request.split(' ').slice(1).join(' ');
        if (rest.length >= 12) { variants.push(JSON.stringify(rest).slice(1, -1)); }
        return variants;
    });

    let best: { sessionId: string; score: number; mtimeMs: number } | undefined;
    for (const file of files) {
        if (!file.endsWith('.json') && !file.endsWith('.jsonl')) { continue; }
        const full = path.join(chatDir, file);
        try {
            const raw = await readFile(full, 'utf8');
            const score = needles.reduce(
                (acc, needle) => (raw.includes(needle) ? acc + 1 : acc),
                0
            );
            if (score === 0) { continue; }
            const { mtimeMs } = await stat(full);
            if (
                !best ||
                score > best.score ||
                (score === best.score && mtimeMs > best.mtimeMs)
            ) {
                best = { sessionId: file.replace(/\.(json|jsonl)$/, ''), score, mtimeMs };
            }
        } catch {
            // unreadable/corrupt session file — skip it
        }
    }

    if (!best) { return undefined; }
    return {
        sessionId: best.sessionId,
        resource: localSessionResource(best.sessionId),
        score: best.score,
        title: readSessionTitle(chatDir, best.sessionId),
    };
}

/**
 * Human chat title, read from VS Code's session index
 * (`state.vscdb` → key `chat.ChatSessionStore.index` → entries[id].title —
 * the same title the chat UI shows, e.g. the workspace name for untitled
 * sessions). Extracted with a regex over the raw sqlite bytes on purpose:
 * the index is a small JSON blob stored as plain text, and pulling in a
 * sqlite driver is not worth it.
 */
function readSessionTitle(chatDir: string, sessionId: string): string | undefined {
    try {
        const dbPath = path.join(chatDir, '..', 'state.vscdb');
        const raw = require('fs').readFileSync(dbPath, 'utf8');
        const m = raw.match(
            new RegExp(`"sessionId":"${sessionId.replace(/[^a-zA-Z0-9-]/g, '')}","title":"((?:[^"\\\\]|\\\\.)*)"`)
        );
        if (!m) { return undefined; }
        return JSON.parse(`"${m[1]}"`) as string;
    } catch {
        return undefined;
    }
}

export function findSessionTitle(chatDir: string, sessionId: string): string | undefined {
    return readSessionTitle(chatDir, sessionId);
}
