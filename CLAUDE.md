# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Haha — a locally-runnable fork/fix of Claude Code with custom API endpoint support, desktop GUI (Tauri 2 + React), and IM channel adapters (Telegram, Feishu). Runs on Bun with TypeScript throughout.

## Commands

### Root (CLI / Server)
```bash
bun install                          # install root dependencies
./bin/claude-haha                    # run CLI in interactive TUI mode
./bin/claude-haha -p "prompt"        # headless/print mode
bun run start                        # alias for CLI
SERVER_PORT=3456 bun run src/server/index.ts   # start API/WebSocket server for desktop
bun run docs:dev                     # VitePress docs dev server
bun run docs:build                   # build VitePress docs
bun test                             # run root-level tests (Bun test runner)
bun test src/server/__tests__/sessions.test.ts  # run a single test file
```

### Desktop App (`desktop/`)
```bash
cd desktop && bun install            # install desktop dependencies
cd desktop && bun run dev            # Vite dev server (http://127.0.0.1:2024 by default)
cd desktop && bun run build          # tsc + vite production build
cd desktop && bun run test           # Vitest suite
cd desktop && bun run test -- src/components/chat/MessageList.test.tsx  # single test
cd desktop && bun run lint           # tsc --noEmit type check
```

### Adapters (`adapters/`)
```bash
cd adapters && bun install           # install adapter dependencies
cd adapters && bun run telegram      # run Telegram adapter
cd adapters && bun run feishu        # run Feishu adapter
cd adapters && bun test              # run all adapter tests
cd adapters && bun test common/      # run only common tests
```

## Architecture

### Three Main Packages
- **Root (`/`)** — Bun-based CLI, Ink TUI, API/WebSocket server, core agent runtime
- **`desktop/`** — React 18 + Vite frontend, Tauri 2 shell, Zustand state management, Tailwind CSS 4, Vitest for tests
- **`adapters/`** — IM channel adapters (Telegram via grammy, Feishu via Lark SDK), WebSocket bridge to server

### Root `src/` Layout
| Directory | Purpose |
|-----------|---------|
| `entrypoints/` | CLI startup (`cli.tsx`), SDK types, MCP entrypoint |
| `screens/` | Ink TUI screens (REPL, Doctor, ResumeConversation) |
| `commands/` | Slash command implementations (each in its own subfolder with `index.ts`) |
| `bridge/` | WebSocket bridge between CLI sessions and desktop/remote clients |
| `assistant/` | Assistant session discovery and history |
| `buddy/` | Companion sprite system for desktop |
| `cli/` | CLI transport layer (SSE, WebSocket, Hybrid), update logic, background mode |
| `bootstrap/` | App state initialization |
| `server/` | HTTP API + WebSocket server powering desktop; has `__tests__/` with Bun tests |
| `utils/` | Shared utilities including cron, computer-use permissions |

### Desktop Architecture
- `desktop/src/api/` — API client modules (sessions, providers, settings, websocket, etc.)
- `desktop/src/components/` — UI components organized by domain: `chat/`, `layout/`, `settings/`, `tasks/`, `skills/`, `teams/`, `shared/`, `controls/`, `markdown/`
- `desktop/src/pages/` — Route-level page components
- `desktop/src/hooks/` — React hooks (keyboard shortcuts, etc.)
- `desktop/src/i18n/` — Internationalization (en, zh locales)
- `desktop/src/stores/` — Zustand stores
- `desktop/src/config/` — Provider presets, spinner verbs
- `desktop/src/lib/` — Utilities (cron description, desktop runtime detection)

### Request Flow
CLI sends prompts → Anthropic SDK calls → agent executes tools → responses streamed back via Ink TUI or WebSocket bridge to desktop/IM adapters.

### Key Patterns
- Server (`src/server/`) is the bridge between desktop/IM and the Claude Code agent runtime
- Bridge system (`src/bridge/`) manages WebSocket sessions, JWT auth, peer sessions, and message routing
- Each slash command is a self-contained module under `src/commands/<name>/` with `index.ts` export
- Adapters share common code in `adapters/common/` (chat queue, message buffer/dedup, HTTP client, session store, WS bridge)

## Coding Conventions

- TypeScript, 2-space indent, ESM imports, no semicolons
- `PascalCase` for React components, `camelCase` for functions/hooks/stores
- Desktop tests: `*.test.ts` or `*.test.tsx` colocated or in `__tests__/`; Vitest + Testing Library + jsdom
- Root/server tests: Bun built-in test runner; test files use `*.test.ts` in `__tests__/` subdirectories
- Adapters tests: Bun test runner; organized by adapter (`__tests__/` within each adapter directory)
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `docs:`, etc.

## Environment

Copy `.env.example` to `.env` and fill in API keys. The server port defaults can be overridden with `SERVER_PORT`. See `docs/guide/env-vars.md` for full reference.
