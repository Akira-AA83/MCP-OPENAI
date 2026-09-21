import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadChildServers, type ChildServerConfig } from "./mcpConfig.js";

const CONNECT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 3_000;

// Connected child clients, keyed by server name. Populated lazily on first use.
const clients = new Map<string, Client>();

function createTransport(config: ChildServerConfig): Transport {
    if (config.kind === "stdio") {
        return new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: config.env,
            stderr: "ignore",
        });
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
    });
}

async function connect(config: ChildServerConfig): Promise<Client> {
    const client = new Client({ name: "astra-agent", version: "0.2.0" });
    const transport = createTransport(config);
    client.onclose = () => {
        // Drop the client so the next investigation reconnects (e.g. Unreal editor restarted)
        if (clients.get(config.name) === client) clients.delete(config.name);
    };
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
}

export type ConnectReport = { connected: string[]; failed: Array<{ name: string; error: string }> };

// True if an already connected client still answers. HTTP transports are never told when the
// server goes away (e.g. Unreal Editor closed and reopened), so a stale session is only found by asking.
async function isAlive(client: Client): Promise<boolean> {
    try {
        await client.ping({ timeout: PING_TIMEOUT_MS });
        return true;
    } catch {
        return false;
    }
}

// Connects to every configured server, reconnecting stale clients. Failures are reported, not thrown,
// and never cached: the next investigation retries, so a server started later is picked up.
export async function ensureChildren(): Promise<ConnectReport> {
    const report: ConnectReport = { connected: [], failed: [] };
    const configs = loadChildServers();

    await Promise.all(configs.map(async config => {
        const existing = clients.get(config.name);
        if (existing) {
            if (await isAlive(existing)) {
                report.connected.push(config.name);
                return;
            }
            console.error(`[astra] "${config.name}" stopped answering, reconnecting`);
            clients.delete(config.name);
            await existing.close().catch(() => {});
        }
        try {
            clients.set(config.name, await connect(config));
            report.connected.push(config.name);
        } catch (error) {
            report.failed.push({ name: config.name, error: (error as Error).message });
            console.error(`[astra] Could not connect to "${config.name}": ${(error as Error).message}`);
        }
    }));
    return report;
}

export function getClient(serverName: string): Client {
    const client = clients.get(serverName);
    if (!client) throw new Error(`MCP server "${serverName}" is not connected`);
    return client;
}

export function getAllClients(): Map<string, Client> {
    return clients;
}

export async function shutdownAll(): Promise<void> {
    await Promise.allSettled([...clients.values()].map(client => client.close()));
    clients.clear();
}
