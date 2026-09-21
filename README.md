# MCP OpenAI — Astra second opinion

An MCP server that gives Claude Code a second, independent opinion from OpenAI models.

It exposes two tools:

- **`openai_chat`**: ask an OpenAI model a question and get a text answer.
- **`astra_investigate`**: hand a task to an autonomous OpenAI agent that inspects the project on its own through the same MCP servers Claude uses (Unreal Editor, Perplexity, ...) and reports back a verdict with evidence.

The point of `astra_investigate` is independence: the agent is not fed Claude's summary of the situation, it looks at the real state of the project with its own criteria.

> Fork of [mzxrai/mcp-openai](https://github.com/mzxrai/mcp-openai), extended with the autonomous agent, model tiers and a cross-agent semaphore.

## How it works

```
Claude Code
    │  astra_investigate(prompt, tier)
    ▼
this server (stdio MCP)
    │  reads the project .mcp.json, connects to every MCP server except itself
    ├──[http]──▶ unreal-mcp
    ├──[stdio]─▶ perplexity
    │
    │  loop:  OpenAI Responses API ──function_call──▶ forward to the owning MCP server
    │                              ◀──function_call_output──
    ▼
final verdict + trace (tool calls, tokens) back to Claude
```

Child MCP servers are connected lazily on the first `astra_investigate` call, so `openai_chat` keeps working even when, say, the Unreal Editor is closed. Servers that fail to connect are skipped and listed as `unavailable` in the trace.

Every investigation re-checks the servers, so you can open or close the Unreal Editor at any time without restarting anything:

- a server that was unavailable is retried, and picked up as soon as it is running;
- an already connected server is pinged first; if it stopped answering (e.g. the editor was closed and reopened, which invalidates the old session), the stale connection is dropped and a new one is opened.

A server that goes down *during* an investigation makes the remaining calls fail; the agent sees the errors and reports them.

## Tools

### `openai_chat`

| Argument | Required | Description |
|---|---|---|
| `messages` | yes | Array of `{ role: "system" \| "user" \| "assistant", content }` |
| `tier` | no | `fast`, `reason` (default) or `deep`, see [Model tiers](#model-tiers) |
| `model` | no | Exact model, overrides `tier` |

### `astra_investigate`

| Argument | Required | Description |
|---|---|---|
| `prompt` | yes | The task. Be specific: the agent decides which tools to call |
| `tier` | no | `fast`, `reason` (default) or `deep` |
| `model` | no | Exact model, overrides `tier` |
| `allowedServers` | no | Restrict the agent to some MCP servers, e.g. `["unreal-mcp"]` |

Example prompts, as you would type them to Claude:

```text
Use astra_investigate with tier deep: verify that PCG_CliffRockScatter has slope
filters that really catch vertical walls. Verdict plus suggested fixes.
```

```text
Ask astra_investigate to test whether the maxThreshold of FilterCliffSlopes can be
changed via MCP, then restore it.
```

The answer ends with a trace like:

```text
Astra trace: model=gpt-6-astra, servers=unreal-mcp, perplexity
Tokens: 73430 in (59664 cached) / 890 out
Tool calls (7):
- unreal-mcp__list_toolsets {}
- unreal-mcp__call_tool {"toolset_name":"PCGToolset.PCGToolset","tool_name":"UpdateNode",...}
...
```

## Model tiers

The default is **never** the expensive model: ask for `deep` explicitly.

| Tier | Model | Use for |
|---|---|---|
| `fast` | `gpt-5-mini` | Trivial lookups. Noticeably less reliable on facts |
| `reason` (default) | `gpt-5` | Most checks and reviews |
| `deep` | `gpt-6-astra` | Critical audits. Much slower and more expensive than the other tiers |

`model` accepts any of these, all verified on both the Chat Completions and the Responses API with function calling:

`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5`, `gpt-5-mini`, `o3`, `o4-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o`, `gpt-4o-mini`

Tiers and the model list live in [`src/models.ts`](src/models.ts). Verify a model before adding it.

## What the agent may do

The agent has **write access** to the MCP servers, because some questions can only be answered by trying something. Its instructions require it to:

1. read and note original values before changing anything;
2. restore every original value and verify the restore by reading it back;
3. never save assets, levels or packages, and never delete assets;
4. end its answer with a **Modifications** table (object, property, original, test value, restored?).

Changes therefore stay in memory in the editor: if something goes wrong, close without saving or use Undo.

Two unreal-mcp toolsets are always blocked for the agent: `ProgrammaticToolset` (runs Python in the editor) and `SlateInspectorToolset` (simulates UI input).

## Semaphore between Claude and the agent

Claude and the agent must not drive the same MCP server at the same time, especially while the agent is in the middle of a "change, test, restore" sequence.

- During an investigation the agent holds a lock on each server it uses, until the investigation ends.
- A Claude Code hook takes a short lock around each of Claude's own MCP calls and **denies** the call if the agent holds the server:
  `MCP server "unreal-mcp" is locked by Astra (pid 18616, since 13:05:48) running astra_investigate.`
- If Claude has a call in flight, the agent waits (up to 90 s) before touching that server.
- Locks of dead processes are ignored, so a crash never leaves a server blocked.

Locks are files in `~/.astra-mcp-locks/`. Install the hook in every project whose Claude sessions use the same MCP servers, in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "node", "args": ["<repo>/hooks/mcp-lock-hook.mjs"], "timeout": 15 }] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "node", "args": ["<repo>/hooks/mcp-lock-hook.mjs"], "timeout": 15 }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "node", "args": ["<repo>/hooks/mcp-lock-hook.mjs"], "timeout": 15 }] }
    ]
  }
}
```

The hook imports `dist/lock.js`, so the project must be built. If the hook itself fails, it lets the call through.

## Installation

Requirements: Node.js 18+, an [OpenAI API key](https://platform.openai.com/api-keys), Claude Code.

```bash
git clone https://github.com/Akira-AA83/MCP-OPENAI.git
cd MCP-OPENAI
npm install        # also builds dist/ through the prepare script
```

Register it in the project that holds the MCP servers the agent should use:

```bash
cd <your-project>
claude mcp add openai --scope project \
  --env OPENAI_API_KEY=<your-key> \
  --env ASTRA_MCP_CONFIG=<your-project>/.mcp.json \
  -- node <repo>/dist/index.js
```

Keep the server name `openai`, or set `ASTRA_SELF_NAME` to the name you use: the server skips that entry to avoid launching itself. Then restart Claude Code (or `claude --continue`) and add the hook above.

`--scope project` writes the key into `.mcp.json`: don't commit that file, or use `--scope local`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | (required) | OpenAI key |
| `ASTRA_MCP_CONFIG` | `C:/Users/angel/Desktop/EDGELAB/THE_VALLEY/.mcp.json` | `.mcp.json` listing the servers the agent may use |
| `ASTRA_SELF_NAME` | `openai` | Name of this server in that file, excluded to avoid recursion |
| `ASTRA_MAX_ITERATIONS` | `30` | Max model round trips per investigation |
| `ASTRA_MAX_OUTPUT_TOKENS` | `8000` | Max output tokens per round trip |
| `ASTRA_MAX_RESULT_CHARS` | `20000` | Tool results longer than this are truncated; images are always omitted |
| `ASTRA_TOOL_TIMEOUT_MS` | `300000` | Timeout of a single child tool call |
| `ASTRA_LOCK_WAIT_MS` | `90000` | How long the agent waits for a server Claude is using |
| `ASTRA_CLAUDE_LOCK_TTL_MS` | `120000` | Expiry of Claude's per-call lock, in case PostToolUse never fires |
| `ASTRA_LOCK_DIR` | `~/.astra-mcp-locks` | Lock directory, shared by server and hook |

## Limitations

- Servers that authenticate through Claude Code's own OAuth (e.g. Atlassian) can't be reused by the agent and are skipped.
- Tool calls within one iteration run sequentially; no streaming.
- Only verified on Windows.

## Development

```bash
npm run build    # tsc into dist/
npm run watch    # rebuild on change
```

| File | Role |
|---|---|
| `src/index.ts` | MCP server, `openai_chat` and `astra_investigate` |
| `src/astraLoop.ts` | Agent loop over the Responses API, instructions, trace |
| `src/toolBridge.ts` | Aggregates child tools, naming, policy, result truncation |
| `src/childManager.ts` | Connects to child MCP servers (stdio / HTTP) |
| `src/mcpConfig.ts` | Reads `.mcp.json`, excludes this server |
| `src/models.ts` | Verified models and tiers |
| `src/lock.ts` | Semaphore shared by the server and the hook |
| `hooks/mcp-lock-hook.mjs` | Claude Code hook enforcing the semaphore |

## License

MIT. Original `openai_chat` server by [mzxrai](https://github.com/mzxrai/mcp-openai).
