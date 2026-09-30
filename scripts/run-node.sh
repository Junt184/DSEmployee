#!/bin/sh
# Stable launcher for a DSEmployee terminal node on macOS/Linux.
#
# Lives in scripts/ (not bin/ -- that one is gitignored by the Gitee template).
# This is the POSIX twin of start-node.ps1 on Windows: the thing that never changes,
# whose only job is "ask which release should run, run it, and bring it back if it dies".
# Which code actually runs is decided by the pointer file:
#
#     <releases>/current.json                { release, previous, failedStarts, ... }
#     <releases>/<code-fingerprint>/         one frozen export per version
#
# The DECISION (run / rollback / run-anyway) is not implemented here: it lives in
# src/node/release.ts and is asked for via `dse release start-plan`. Two implementations
# of "when to roll back" would drift, and drift shows up as "rollback works on one
# machine but not the other" -- the worst kind of thing to debug at night.
#
# Why this loops instead of `exec`: the node asks for a restart by exiting with
# EXIT_RESTART (75) after it has swapped the pointer. A supervised loop is what makes
# that a *restart* rather than an outage; on Windows the scheduled task's
# RestartOnFailure plays the same role.
#
# Exit-code convention (must match src/node/*):
#   0            clean shutdown -- the loop stops
#   75           "restart me, this is intentional" -- not counted as a crash
#   anything else, and it died within the grace window -- counted as a crash, and the
#                next iteration may decide to roll back
#
# Usage:
#   scripts/run-node.sh --hub ws://127.0.0.1:19791/ws --name 本机Mac \
#                   --employee-root ./.dev-employees [extra node flags...]
#
# Everything after the flags is passed through to `dse node` unchanged.

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

# Path-valued flags MUST be absolute.
#
# Why this is enforced instead of "helpfully" resolved (real incident, 2026-09-23):
# started as
#   scripts/run-node.sh --employee-root ./.dev-employees --home .dse-live-node
# the node ran relative to the *release* directory after an upgrade, so it
#   * found 0 employees (the path pointed inside the release),
#   * created a brand-new state dir -> a brand-new device identity -> it re-paired as a
#     second node and left a stray node record on the hub,
#   * wrote that state into the release directory, i.e. into a frozen artifact.
# Refusing to start beats silently running against the wrong directory; the Windows
# launcher never had this bug because it builds absolute paths from $Repo/$Root.
#
# (Rewriting the arguments here would mean re-quoting a list through a shell string --
# brittle in POSIX sh. A clear error is worth more than cleverness.)
prev=""
HAS_HUB=0
for arg in "$@"; do
  case "$prev" in
    --employee-root|--home|--dsh-home|--identity|--params-file)
      case "$arg" in
        /*) ;;
        *)
          echo "[run-node] $prev 必须是绝对路径，收到 '$arg'" >&2
          echo "[run-node] 相对路径在切换版本后会指到 release 目录里面（曾经因此把员工根指丢、还重新配了一台设备）" >&2
          exit 2
          ;;
      esac
      ;;
  esac
  if [ "$arg" = "--hub" ]; then HAS_HUB=1; fi
  prev="$arg"
done

# Where releases live. The node process and the launcher must agree on this; if unset,
# src/node/release.ts falls back to "<repo>/../dse-releases" (see releasePaths).
# The node needs to know where the git clone is: it runs from a *release* directory
# (a frozen export with no .git), so `dse release update` cannot fetch from there.
# Passing it explicitly is the reliable way; the pointer also records it as a fallback.
DSE_REPO="$REPO"
export DSE_REPO

if [ -z "${DSE_RELEASES:-}" ]; then
  DSE_RELEASES="$(dirname "$REPO")/dse-releases"
  export DSE_RELEASES
fi

# Which hub, when the caller did not say.
#
# Same reasoning as start-node.ps1: the address must not be a literal in a public repo
# (that publishes one operator's endpoint to every clone), and it must not be a
# placeholder either (that strands machines already deployed). So it is read back from
# the machine -- $DSE_HUB, else <DSE_HOME>/hub-url, which the node writes itself on every
# start (HUB_URL_FILE in src/node/agent.ts), since the node is the side that receives it.
# A URL is not a credential; this is hygiene, not secrecy.
if [ "$HAS_HUB" -eq 0 ]; then
  HUB_URL="${DSE_HUB:-}"
  if [ -z "$HUB_URL" ]; then
    HUB_FILE="${DSE_HOME:-${HOME:-.}/.dsemployee}/hub-url"
    if [ -f "$HUB_FILE" ]; then
      HUB_URL="$(tr -d '\r' <"$HUB_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' | head -n 1)"
    fi
  fi
  if [ -z "$HUB_URL" ]; then
    echo "[run-node] no --hub given, and no hub address on this machine." >&2
    echo "[run-node] pass --hub <url>, or set DSE_HUB, or write one line to ${DSE_HOME:-${HOME:-.}/.dsemployee}/hub-url" >&2
    exit 2
  fi
  set -- --hub "$HUB_URL" "$@"
fi

# How long a freshly started node has to prove itself. If it exits inside this window
# with a non-zero, non-75 code, that is a failed start (counted toward rollback).
GRACE_SEC=90
# Backoff between iterations (avoid a hot loop if something fails instantly).
RETRY_SEC=5

plan() {
  "$NODE_BIN" "$REPO/bin/dse.mjs" release start-plan --repo "$REPO" 2>/dev/null || true
}

# Read one JSON string field without requiring jq (node is guaranteed present here).
field() {
  "$NODE_BIN" -e '
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")) } catch { process.stdout.write("") }
    })
  ' "$1"
}

while :; do
  PLAN="$(plan)"
  CODE_DIR="$(printf '%s' "$PLAN" | field codeDir)"
  RELEASE="$(printf '%s' "$PLAN" | field release)"
  ACTION="$(printf '%s' "$PLAN" | field action)"
  REASON="$(printf '%s' "$PLAN" | field reason)"

  # Fallbacks, in order of preference: the plan, then the repo working tree.
  # A plan that cannot start is worse than no plan at all.
  if [ -z "$CODE_DIR" ] || [ ! -f "$CODE_DIR/bin/dse.mjs" ]; then
    echo "[run-node] plan unusable (dir='$CODE_DIR'); falling back to the repo working tree" >&2
    CODE_DIR="$REPO"
    RELEASE="__source__"
    ACTION="run"
    REASON="plan unusable"
  fi

  if [ "$ACTION" = "rollback" ]; then
    echo "[run-node] ROLLBACK: $REASON" >&2
    "$NODE_BIN" "$REPO/bin/dse.mjs" release switch --to "$RELEASE" --by launcher-rollback --repo "$REPO" >/dev/null 2>&1 || true
  fi

  echo "[run-node] release=$RELEASE action=$ACTION dir=$CODE_DIR reason=$REASON" >&2
  STARTED_AT="$(date +%s)"

  set +e
  ( cd "$CODE_DIR" && "$NODE_BIN" bin/dse.mjs node "$@" )
  CODE=$?
  set -e

  RAN_SEC=$(( $(date +%s) - STARTED_AT ))

  if [ "$CODE" -eq 0 ]; then
    echo "[run-node] node exited cleanly; stopping" >&2
    exit 0
  fi
  if [ "$CODE" -eq 75 ]; then
    # Intentional restart (the node swapped the pointer and asked to be brought back).
    echo "[run-node] restart requested by the node (exit 75) after ${RAN_SEC}s" >&2
    sleep 2
    continue
  fi
  if [ "$RAN_SEC" -lt "$GRACE_SEC" ]; then
    echo "[run-node] child exited code=$CODE after ${RAN_SEC}s (< ${GRACE_SEC}s grace) -- noting a crash" >&2
    "$NODE_BIN" "$REPO/bin/dse.mjs" release note-crash --repo "$REPO" >/dev/null 2>&1 || true
  fi
  sleep "$RETRY_SEC"
done
