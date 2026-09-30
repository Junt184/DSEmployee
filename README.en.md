# DSEmployee

DSEmployee is a digital employee platform built on top of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds authentication,
cross-device connectivity, employee discovery, and authorization around dsh workspaces, so a
Hub can coordinate employees hosted by multiple terminal nodes while keeping dsh local to each
machine.

## Installation

Requirements: Node.js >= 22.19 and a local `dsh` installation.

```bash
npm install
npm run build
```

Start a Hub with `node bin/dse.mjs hub --port 19790`, then connect a terminal node with the
Hub WebSocket URL and an employee root:

```bash
node bin/dse.mjs node \
  --hub ws://<server-ip>:19790/ws \
  --name Office-PC \
  --employee-root /path/to/employees
```

The Hub prints a one-time pairing code for authorizing a browser, CLI, or node. See the
[Chinese README](README.md) for the full architecture, deployment options, and command reference.

## Development

Run the type checker and test suite with:

```bash
npm run typecheck
npm test
```
