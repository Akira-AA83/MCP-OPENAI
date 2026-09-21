// Cross-process semaphore between Astra and Claude Code on shared MCP servers.
//
// - Astra holds `<server>.astra.lock` for a whole investigation; it is valid while the owning pid is alive.
// - Each Claude Code tool call holds `<server>.claude.<toolUseId>.lock` (written by the hook in
//   hooks/mcp-lock-hook.mjs); it is valid until it expires, in case PostToolUse never fires.
//
// Both sides write their own lock first and then check for the other side's, backing off on conflict,
// so the two can never hold the same server at once.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCK_DIR = process.env.ASTRA_LOCK_DIR ?? path.join(os.homedir(), ".astra-mcp-locks");
const CLAUDE_LOCK_TTL_MS = Number(process.env.ASTRA_CLAUDE_LOCK_TTL_MS ?? 120_000);

type LockRecord = {
    owner: "astra" | "claude";
    pid: number;
    acquiredAt: number;
    expiresAt?: number;
};

// Servers whose Astra lock this process currently holds
const held = new Set<string>();

function safe(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function astraLockPath(server: string): string {
    return path.join(LOCK_DIR, `${safe(server)}.astra.lock`);
}

function claudeLockPath(server: string, toolUseId: string): string {
    return path.join(LOCK_DIR, `${safe(server)}.claude.${safe(toolUseId)}.lock`);
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function readLock(file: string): LockRecord | null {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function isValid(lock: LockRecord | null): lock is LockRecord {
    if (!lock) return false;
    if (lock.owner === "astra") return isAlive(lock.pid);
    return (lock.expiresAt ?? 0) > Date.now();
}

function remove(file: string): void {
    try {
        unlinkSync(file);
    } catch {
        // already gone
    }
}

// Returns the lock if still valid, deleting it otherwise
function validLockAt(file: string): LockRecord | null {
    const lock = readLock(file);
    if (isValid(lock)) return lock;
    remove(file);
    return null;
}

function tryCreate(file: string, lock: LockRecord): boolean {
    try {
        writeFileSync(file, JSON.stringify(lock), { flag: "wx" });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    }
}

function activeClaudeLocks(server: string): LockRecord[] {
    const prefix = `${safe(server)}.claude.`;
    return readdirSync(LOCK_DIR)
        .filter(file => file.startsWith(prefix))
        .map(file => validLockAt(path.join(LOCK_DIR, file)))
        .filter((lock): lock is LockRecord => lock !== null);
}

function describe(lock: LockRecord): string {
    const since = new Date(lock.acquiredAt).toLocaleTimeString();
    return lock.owner === "astra" ? `Astra (pid ${lock.pid}, since ${since})` : `Claude Code (since ${since})`;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Astra side ---

export async function acquireAstraLock(server: string, waitMs: number): Promise<void> {
    if (held.has(server)) return;
    mkdirSync(LOCK_DIR, { recursive: true });

    const file = astraLockPath(server);
    const deadline = Date.now() + waitMs;
    let blocker = "unknown";

    while (true) {
        validLockAt(file);
        if (tryCreate(file, { owner: "astra", pid: process.pid, acquiredAt: Date.now() })) {
            const claudeLocks = activeClaudeLocks(server);
            if (claudeLocks.length === 0) {
                held.add(server);
                return;
            }
            remove(file);
            blocker = describe(claudeLocks[0]);
        } else {
            const other = readLock(file);
            blocker = other ? describe(other) : blocker;
        }
        if (Date.now() >= deadline) {
            throw new Error(`MCP server "${server}" is busy, in use by ${blocker}. Waited ${Math.round(waitMs / 1000)}s.`);
        }
        await sleep(1000);
    }
}

export function releaseAllAstraLocks(): void {
    for (const server of held) {
        const file = astraLockPath(server);
        if (readLock(file)?.pid === process.pid) remove(file);
    }
    held.clear();
}

// --- Claude Code side (used by the PreToolUse/PostToolUse hook) ---

export function claudeBeforeTool(server: string, toolUseId: string): { allowed: true } | { allowed: false; reason: string } {
    mkdirSync(LOCK_DIR, { recursive: true });
    const file = claudeLockPath(server, toolUseId);
    const now = Date.now();
    writeFileSync(file, JSON.stringify({ owner: "claude", pid: process.pid, acquiredAt: now, expiresAt: now + CLAUDE_LOCK_TTL_MS }));

    const astra = validLockAt(astraLockPath(server));
    if (astra) {
        remove(file);
        return {
            allowed: false,
            reason: `MCP server "${server}" is locked by ${describe(astra)} running astra_investigate. Wait for the investigation to finish, then retry.`,
        };
    }
    return { allowed: true };
}

export function claudeAfterTool(server: string, toolUseId: string): void {
    remove(claudeLockPath(server, toolUseId));
}
