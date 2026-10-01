# DSEmployee

**English** | [简体中文](README.md)

**A digital-employee platform built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

dsh on its own is a complete agent runtime, but it only governs a single machine and has no notion of *who is allowed in*. DSEmployee adds the four missing pieces — **authentication, cross-machine reach, a directory, and authorization** — so the dsh workspaces scattered across your computers become one digital-employee team you can command centrally:

> **One digital employee ≡ one dsh workspace.**
> The role brief and knowledge base are the workspace's `AGENTS.md` (dsh injects it at the start of every session); per-employee skills live in `<workspace>/.dsh/skills/`; the chat is a dsh session inside that workspace; a custom model endpoint is `.dsemployee/llm.json`; a custom avatar is `.dsemployee/avatar.*`.
> Employee identity travels with the directory: copy the whole directory to another machine and it is still the same employee.

Division of roles: the **Hub** (one server) handles authentication, directory aggregation, authorization and relaying; **terminal nodes** (office Mac, home Windows box, …) each host their local dsh and carry the employees; **authorized devices** (the browser console on a phone or laptop, the CLI, scripts) send instructions to any employee through the Hub.

---

## Architecture

```
                 ┌───────────── server (one) ──────────────┐
  browser console│  Hub                                    │
  (phone/laptop) │   one port: HTTP console + WS control   │
        │        │   auth: Ed25519 challenge + pairing     │
        │outbound│   directory: cross-node employee list   │
        ▼        │   authz: invoke ACL + approval center   │
        └───────▶│   relay: routing + offline mailbox      │
                 └────▲──────────────────▲─────────────────┘
                      │ node dials out   │ node dials out
              ┌───────┴───────┐  ┌───────┴───────┐
              │ Terminal A    │  │ Terminal B    │
              │  node-agent   │  │  node-agent   │
              │   ├ dsh (loopback only)           │
              │   ├ employee 小艾                 │
              │   └ employee …                    │
              └───────────────┘  └───────────────┘
```

**Nodes dial out to the Hub**; the Hub never needs to reach back into a node, so no NAT traversal is required. **dsh always listens on loopback only** — just the co-located node-agent can drive it, and all external traffic converges at the Hub.

The key mechanisms, one paragraph each:

- **Employee = workspace.** A node scans its employee root for directories containing `.dsemployee/employee.json` to build the employee list, then reports the full list to the Hub (delete a directory and it converges naturally — no ghost entries). `AGENTS.md` is the role brief and is injected by dsh at the start of every session; `<workspace>/.dsh/skills/` holds that employee's private skills (rank 100, highest priority).
- **Authentication and pairing bootstrap.** A device identity is an Ed25519 key pair generated in the browser or CLI (private key non-exportable), with `deviceId = sha256(SPKI DER)`. The handshake is a one-time nonce challenge signature plus a bounded device token (the Hub stores only its sha256). The main path for authorizing a new device is a **6-digit pairing code** (printed at Hub startup, or generated with `dse pair-code`; a terminal node can also issue one for nearby authorization), or any authorized console approving it inline from the *Devices* card. The fallback is `dse pair approve` on the Hub host itself. After approval no token needs to be carried anywhere — the device collects it on its next handshake.
- **Per-employee model endpoints.** Each employee can have its own OpenAI-compatible endpoint (API URL + key + model). The shared endpoint library is stored in Hub's `llm-endpoints.json` (0600), while the employee workspace at `.dsemployee/llm.json` stores only the endpoint reference and model selection. API responses always mask the key; the employee node receives and stores its own working copy for dsh. On save the node wires it into dsh — a pi-ai provider route declared as `dse-emp-<id>` plus credentials — and newly created sessions automatically `session.selectModel` onto that route. Existing sessions are not migrated.
- **Invoke ACL + approvals.** Employees can call each other (`employee.invoke`), constrained by `from/to/effect` rules. Calls that hit an `approve` rule go to the approval center and run once the console decides.
- **Idempotent RPC retries.** Requests whose method is marked `idempotent: true` must carry an `idempotencyKey`; the Hub persists an execution reservation and the response keyed by device, key, method and a digest of the normalized parameters. Replaying the same request returns the original response; a replay with different parameters is rejected. The cache is retained for 24 hours and bounded in total size. If a Hub crash leaves an unfinished reservation, the Hub reports the outcome as indeterminate and refuses to re-run automatically, avoiding a possible duplicate side effect. This is not an exactly-once transaction across external systems.
- **Unattended approvals and questions.** When an employee runs on a machine with nobody at the keyboard, dsh's own approval gate fails closed (that turn simply hangs until aborted). The node lifts dsh's `approval/requested` / `question/requested` into the Hub approval center; once the console approves (or answers), the answer is written back to dsh along the same path and the blocked step continues on the spot. Questions are presented as structured choice cards and the answer is fed back verbatim — **the Hub does not interpret its shape**.
- **Chat instructions and async invokes can queue while a node is offline.** `session.prompt` for an offline node goes into the Hub mailbox and is delivered in order once the node reconnects. `employee.invoke` is queued as an async dispatch, acknowledged by the node when accepted, and completed later through `employee.invoke.settle`. The queue holds at most 50 entries per node for at most 24 hours, and tells the truth when an entry expires or the queue is full. When delivery status is unknown the Hub stops after at most 3 attempts so an employee does not receive a duplicate instruction. Methods that need an immediate return value (creating a session, cancelling a session, …) still fail immediately with `node-offline` rather than pretending to succeed. This is not exactly-once either; the health page shows what is still sitting in the mailbox.
- **Connection robustness.** Two liveness layers. An application-level tick (one frame every 15s from the Hub) feeds the client watchdogs (console and node share the logic: 2.5 missed intervals means half-open, so reconnect); at the transport layer the Hub sweeps with ping/pong (two missed pongs and it terminates). When the same nodeId reconnects, the old connection is evicted immediately and forwarding always lands on the new one — a half-open connection behind a public reverse proxy never becomes an invisible zombie.
- **Reverse-proxy deployments (`--trust-proxy`).** By default the Hub trusts only the TCP peer IP. Behind a controlled nginx/caddy reverse proxy, add `--trust-proxy` so the client IP is taken from `X-Real-IP`/`X-Forwarded-For`, preserving the loopback semantics of node pairing. Enabling it on a direct-connection deployment only adds a spoofing surface.

---

## Quick start

Prerequisites: Node ≥ 22.19 and `dsh` installed locally (`npm i -g @deepseek-ai/dsh`).

```bash
npm install
npm run build          # or during development just use bin/dse.mjs (Node strips TS types natively)
```

### 1. Start the Hub on a server

```bash
node bin/dse.mjs hub --port 19790
```

The output prints the console URL, the control-plane WS URL, and a **6-digit pairing code** (valid 24h, single use):

```
  ╔══════════════════════════════╗
  ║  Pairing code: 482913 (24h)  ║
  ╚══════════════════════════════╝
```

### 2. Start a node on a terminal machine

```bash
node bin/dse.mjs node \
  --hub ws://<server-ip>:19790/ws \
  --name office-pc \
  --employee-root D:\Employees \
  --dsh-home D:\Employees\.dsh \
  --dsh-env DEEPSEEK_API_KEY=sk-xxxx
```

The node will: spawn the local `dsh --profile web` (listening on loopback only) → scan employee workspaces → connect to the Hub and report the directory.
A node whose first connection comes from loopback (and which requests no scopes) is approved automatically; otherwise a pending request appears on the Hub — **the node keeps waiting and connects by itself once approved, with no restart**.

> **Model credentials are required.** Without `--dsh-env DEEPSEEK_API_KEY=…` (and without writing it on that DSH_HOME's dsh Web *Models* page), an employee connects and can create sessions, but **the first task it runs fails with `MISSING_CREDENTIAL`**. That error propagates all the way back to the caller instead of being swallowed — deliberate, so a failure never looks like "it finished but produced nothing".

### 3. Authorize your first device (pairing code)

Open the console (step 4); it generates a device identity automatically and starts pairing. While the page sits on the authorization screen, type the pairing code from the Hub startup output and click *Authorize with pairing code*. Done.

When the Hub is on a cloud server (so you would need SSH just to read the startup output), **any terminal node can issue a code instead** — run this on the machine at hand (reported under the local node's identity, valid 10 minutes, and it raises a desktop notification):

```bash
node bin/dse.mjs pair-code --hub ws://<server-address>:19790/ws --label office-mac
```

If the code expires or you lose it, regenerate it on the Hub host (the old code is invalidated; a running Hub honours the new one immediately):

```bash
node bin/dse.mjs pair-code
```

> **The trust model in one sentence:** a Hub code is equivalent to "can see the Hub's terminal output"; a node code is equivalent to "can operate an already-paired terminal" — and the latter already holds a node identity that can drive all of its employees, so granting it code-issuing rights does not widen the attack surface.
> All codes store only a sha256 and are burned on first use; node codes live at most 30 minutes, at most 3 active codes per node, and 5 wrong entries get that IP briefly rejected.

**Fallback path** (when a pairing code is not available): approve directly on the Hub host —

```bash
node bin/dse.mjs pair list               # who is requesting pairing
node bin/dse.mjs pair approve <requestId> --name my-phone
```

> This command edits the state file locally and does not go over the network; its trust anchor is "whoever can read and write the Hub state file already controls this machine" — more auditable than any first-connection-auto-admit magic. **After approval no token needs to be carried anywhere**: the device collects it on its next connection (being able to sign the challenge is proof that it is itself). If a token is lost, rotate it on the Hub host with `dse token rotate <deviceId>`; for a local CLI the new token is written back automatically.

### 4. Open the console

Point a browser at the Hub's address. The console generates an Ed25519 device key automatically (private key non-exportable, stored in IndexedDB) and connects. The first visit stops at the authorization screen — enter the pairing code — and every later visit logs in automatically.

The console is also a PWA: on iPhone use Safari's *Share → Add to Home Screen* (Android Chrome offers the install prompt directly), and launching from the home-screen icon gives you a standalone full-screen window. The service worker caches only the static shell (page/script/icons) and is **network-first throughout**; the cache is an offline fallback only. The control-plane WS and `/api` always talk to the Hub directly and are never cached. The script URL carries a content fingerprint (`/ui.js?v=<fingerprint>`), and the SW cache name and precache list derive from that same fingerprint, so **changing one line of front-end code rolls the version automatically**: clients self-heal on next open with nobody having to remember to bump a version number, and you never get the "right on the desktop, stale on the phone" mismatch. The page prints its current script fingerprint and turns red automatically when it differs from the server's (mechanism in `docs/03` §3.8).

> There are two work-station layouts: wide screens use a two-column *avatar | mini-screen* row (the avatar is the visual anchor, 110px); **narrow screens (≤900px, phones) switch to a vertical layout** — the avatar occupies the left column across two rows, name-over-status sits to its right, and **the mini-screen takes a full row** at the card's full width. On a phone the card is only 161–163px wide; side by side the live output is squeezed to 47px (5 CJK characters per line), while the vertical layout gives it 143–149px (15–18 characters per line). When text would overflow, the mini-screen wins and name/status stack instead (measured numbers in `docs/05` §13.5).

The console's home page is the **office**: employees are grouped into sections, one pixel work station each (the default avatar is an 8-bit figure generated deterministically from the employee id; while busy the badge breathes, the desk monitor scrolls the live output, and an unread dot lights up when there is new output and you are not in that employee's chat). Click a station to open the chat with that employee. The tab at the top switches to **model configuration**, where you can give a single employee a model endpoint; the *change avatar* action under the nameplate uploads a custom avatar (png/webp/gif/jpeg, ≤2MB) and *restore default* goes back to the pixel figure.

One card in the console, **health check** (collapsed by default), surfaces three classes of problem that **never raise an error**:

| Check | Criterion | Why it deserves a dedicated place |
|---|---|---|
| Console script | This page's script fingerprint vs the one the server prints into the page | A mismatch means this page is running a stale script frozen by the PWA cache (the classic cause of "the phone and the desktop disagree") |
| Node code | Each node's reported code fingerprint vs the Hub's own | Nodes are upgraded by hand: while running old code they look identical in the UI (still online, still listing employees), they are just missing capabilities. `unknown` means an old node did not report one — **not treated as a match** |
| Employee workspace | Missing the `.git` anchor + has private skills | dsh's `projectRoot` only recognises `.git`: without the anchor in the workspace, private skills written under `.dsh/skills` are **silently ignored** |

### 5. Create a digital employee

> On Windows prefer `--params-file` over inline JSON — PowerShell eats the quotes inside arguments.

```bash
node bin/dse.mjs rpc employee.create --params-file create.json \
  --hub ws://127.0.0.1:19790/ws
# create.json: {"nodeId":"<node-id>","name":"小艾","role":"owns the weekly report and data reconciliation","group":"ops"}
# group is optional (≤64 chars): the console office view uses it for sections; omit to land in "ungrouped"
# intro is optional (≤500 chars): the initial prompt, a one-line identity/setting injected at the start of every session
```

This is generated on the node:

```
D:\Employees\xiao-ai\
├── .dsemployee\employee.json    employee identity and metadata (group, intro)
├── AGENTS.md                    role brief + knowledge base (dsh injects it every session)
└── .dsh\skills\                 skills private to this employee (dsh scans at rank 100, highest priority)
```

You can also create one right in the console's office view, from the *New employee* collapsible card (name / role / group / which node it lands on).

### 6. (Optional) Give one employee its own model endpoint

The console's *Model configuration* tab lists every employee by group; expand one to configure an **OpenAI-compatible endpoint** (API URL + API key + model). After filling in URL and key, *Fetch model list* pulls the available models from the endpoint's `/models` (the node talks to the endpoint directly, not through dsh).

- The endpoint library is stored in Hub's `llm-endpoints.json` (0600); the employee workspace at `.dsemployee/llm.json` stores the reference and model selection, and the apiKey is written to the employee node for dsh. The API only ever returns a mask. Forwarding through the Hub is part of the transport path — a production deployment must go over Tailscale/TLS (see the deployment section below).
- Saving wires it into dsh immediately: a pi-ai provider route declared as `dse-emp-<id>` with credentials written alongside; sessions **newly created** for that employee automatically select the model on that route. Existing sessions are not migrated.
- *Clear configuration* removes both the provider declaration and the credentials, and new sessions fall back to the node's default model.

### Deploying to a cloud server (Alibaba Cloud, etc.)

The Hub **authenticates callers but does not encrypt transport**. Binding to a public interface means device tokens, session contents and employee output all cross the network in the clear — so a non-loopback bind only starts with an explicit `--allow-non-loopback`, and the correct approach is to add encryption at the transport layer, one of two ways:

- **Tailscale (recommended):** install Tailscale on the server and the terminals, bind the Hub to loopback or a `100.x` address (`--host 100.x.y.z --allow-non-loopback`), and reach the console at `http://100.x.y.z:19790/`. Traffic is WireGuard-encrypted and nothing is exposed publicly.
- **TLS reverse proxy:** nginx/caddy terminates TLS and forwards to the loopback Hub (forward the WS upgrade headers), and the console is opened over `https://`. **A reverse-proxy deployment must pass `--trust-proxy` to the Hub:** without it every connecting client's IP looks like loopback, and the automatic-approval gate for node pairing (`fromLoopback`) would admit internet traffic as if it were a local node. Enable it only when the proxy is yours and it overwrites rather than passes through `X-Real-IP`/`X-Forwarded-For`; enabling it on a direct-connection deployment introduces a spoofing surface instead. In production, run it under systemd (put `--trust-proxy` into the unit's ExecStart — the option is not persisted and is lost on restart).

> Note: browsers only provide WebCrypto in a **secure context** (https or localhost). Plain `http://` plus a bare IP (outside Tailscale or an internal domain with a certificate) will not open the console — the authorization page says so.

---

## Commands

| Command | Description |
|---|---|
| `dse hub` | Start the Hub (the startup output contains a one-time pairing code); `--trust-proxy` for reverse-proxy deployments |
| `dse node` | Start a node agent on a terminal |
| `dse pair-code` | Regenerate the Hub pairing code (**Hub host only**, invalidates the old one); with `--hub <ws-url>` it issues a node code on the terminal instead (valid 10 minutes, raises a desktop notification) |
| `dse pair list\|approve\|reject\|remove` | Fallback device-pairing path (**Hub host only**) |
| `dse token rotate\|revoke` | Rotate or revoke a device token |
| `dse rpc <method> [json]` | Call a method as an operator (scripts and troubleshooting) |
| `dse identity` | Print this machine's device identity fingerprint |

---

## Layout

```
src/protocol/     wire protocol and authentication root (Ed25519, frames, roles, method table) — the single definition of permissions
src/hub/          Hub: transport and handshake, device ledger, pairing codes, employee directory, ACL, approvals, invoke relay
src/client/       Hub client (shared by the node agent and the CLI; includes the liveness watchdog)
src/node/         terminal node: hosts dsh, employee-as-workspace management, LLM endpoint wiring, avatars, event reporting
src/web/          console UI (single file, zero build; office / chat / model-config views plus the PWA shell)
src/util/         atomic writes, path boundaries, identity storage, desktop notifications
test/             protocol, Hub and node tests
scripts/          end-to-end verification and diagnostic probes
```

---

## Security model

- **Identity:** `deviceId = sha256(SPKI DER)`, i.e. the public-key fingerprint. The key is only 32 bytes.
- **Handshake:** the server issues a one-time nonce → the client signs canonical JSON with its private key (fixed key order, scopes sorted) → the server verifies the signature, checks the clock skew and burns the nonce.
- **Pairing:** a new device must be approved by a human by default. The main path is a 6-digit pairing code (printed at Hub startup or generated nearby by a terminal node; only a sha256 is stored, single use, expires on a timer, 5 wrong entries briefly ban that IP); the fallback is `dse pair approve` on the Hub host. Automatic approval happens only when four conditions hold at once: loopback/allowlist **and** `role: node` **and** no scopes requested **and** first connection.
- **Tokens:** the Hub stores only a sha256. Any scope issued or rotated **cannot exceed the set approved when that device paired** (enforced by `scopesExceeding`).
- **Permissions:** the method → scope mapping lives in exactly one place, `src/protocol/methods.ts`; unknown methods are always rejected; methods with side effects require an idempotency key; event broadcast is gated by scope and unknown event families are not delivered.
- **Secret boundary:** the LLM apiKey is stored with 0600 permissions in Hub's endpoint library and on the employee node for dsh; API responses always mask it. Protect Hub storage and the Hub-to-node transport in production.
- **Workspace boundary:** every file operation that comes from the network passes `isPathInside` first; `..`, absolute paths and symlink escapes are all rejected.
- **dsh is never exposed:** `/api` is reached only by the co-located node agent over loopback.
- **A preset is code:** `!!js` executes inside dsh composition files, and upstream rates the trust level of `$DSH_HOME/.agent-presets` as equivalent to shell access and deliberately refuses to accept composition text from any caller. This tool **no longer** materialises a per-employee preset (the private skill layer comes from dsh's default discovery); keep guarding this invariant: **data coming from the Hub side must never flow into composition YAML**.

---

## Development

> **Deploy source only; never ship `dist/`.** The rule in `bin/dse.mjs` is "if `dist/src/cli.js` exists, load it first", so shipping build output means **not a single line of your source change takes effect** — and everything still looks fine. (This actually happened: a public Hub ran build output for a while, and the two fingerprints disagreed while we assumed the code differed.)
> The console's *health check* now prints "running dist / src" as a line of fact.
>
> ```bash
> rsync -az --delete --exclude '/node_modules' --exclude '/.git' --exclude '/dist' \
>   --exclude '/.dse*' --exclude '/avatars' --exclude '/.tmp-*' ./ <host>:/srv/dsemployee/
> # if the target already has a historical dist/: delete it before restarting (otherwise it is still loaded first)
> ```

```bash
npm run typecheck      # tsc --noEmit
node --test --test-concurrency=1 test/*.test.ts  # full test suite (serial)
# ↑ --test-concurrency=1 is there for a reason: the default concurrency starts several real WS
#   servers/clients at once, and test/downlink.test.ts fails intermittently under that race
#   (observed: the same code passes twice serially and fails occasionally in parallel).
#   Serial is deterministic — a few seconds buys away a misleading false failure.
node scripts/probe-skill-roots.ts                # skill-root health check (can each employee see its private skills)
node scripts/e2e-approval.ts                     # full approval/question reverse channel (real Hub + real dsh + real model)
node scripts/e2e-two-nodes.ts                    # two terminals end to end (including invoke)
node scripts/e2e-llm-endpoint.ts                 # per-employee model endpoint wiring end to end
node scripts/e2e-pair-approve.ts                 # pairing approval → automatic token collection
node scripts/probe-dsh.ts <port>                 # read-only dsh health check (does not spend API quota)
node scripts/probe-mux.ts <port> <cwd>           # raw frame-type distribution on the dsh downlink
node scripts/inspect-session.ts <port> <sid>     # session event-type distribution + text extraction self-check
node scripts/dump-events.ts <port> <sid> [type]  # print the full raw JSON of one class of session event
```

Documentation:

Source comments contain references of the form `docs/0X §Y` — they point at **local design notes**, which are not part of this repository (`test/docs-methods.test.ts` skips that whole group when the notes are absent, so `npm test` does not go red after a clone).

---

## License

[MIT](LICENSE) © 2026 HIK

## Security notes (please read once)

- **Do not switch off device pairing authentication just to save trouble.** Allow insecure authentication, loosen the origin allowlist, and put a public domain in the allowlist — get all three together and "pairing is a first-class contract" is void, and that contract is the only admission gate this system has. If it is inconvenient during development, use a loopback address; do not touch the authentication switches.
- **This Hub authenticates callers but does not encrypt transport.** So a non-loopback bind requires explicit confirmation before it will start; to expose it, put a TLS-terminating reverse proxy in front (with `--trust-proxy`), or go over an SSH / WireGuard / Tailscale tunnel. An employee's LLM apiKey config forwarded from the Hub to the node travels this same path — it is safe only when Tailscale/TLS covers it; on disk it exists in Hub's endpoint library and on the node with 0600 permissions, so both storage locations must be protected.
- **Never expose dsh's `/api` to the network.** It has only a reachability fence against DNS rebinding and no authentication layer at all — which is why upstream deliberately forbids `dsh web --host 0.0.0.0`. This project has the node agent drive it over loopback on the same machine.
- **Keep credentials and private keys out of the repository.** This repo's `.gitignore` already covers `.dshdev/` (model credentials) and `.dse-*/` (device private keys and tokens); please do not change those rules after cloning.
