#!/usr/bin/env bash
# Long-lived remote side of one pane state capture. The SSH client keeps this
# process alive; stdout is the raw pane byte stream (OSC 7501 included).
set -u

PANE_ID="${PANE_ID:-}"
FIFO_HASH="${FIFO_HASH:-}"

case "$PANE_ID" in
  %[0-9]*) : ;;
  *) printf 'dsh-codex-agent: invalid pane id\n' >&2; exit 10 ;;
esac
case "$FIFO_HASH" in
  ''|*[!A-Za-z0-9]*) printf 'dsh-codex-agent: invalid fifo hash\n' >&2; exit 10 ;;
esac
if ! command -v tmux >/dev/null 2>&1; then
  printf 'dsh-codex-agent: tmux 未安装\n' >&2
  exit 11
fi

# Default to /tmp; fall back to the home directory when /tmp is restricted or
# the pipe-pane shell cannot write there.
FIFO="${TMPDIR:-/tmp}/dsh-codex-agent-${FIFO_HASH}.fifo"
# A leftover FIFO from a previous capture (hard-disconnected SSH) means a stale
# pipe-pane may still own the pane. Remember that before removing the file so
# only our own stale pipe is closed; another program's pipe is never replaced.
STALE_PIPE=0
if [ -e "$FIFO" ]; then STALE_PIPE=1; fi
rm -f "$FIFO"
if ! mkfifo -m 600 "$FIFO" 2>/dev/null; then
  FIFO="$HOME/.dsh-codex-agent-${FIFO_HASH}.fifo"
  STALE_PIPE=0
  if [ -e "$FIFO" ]; then STALE_PIPE=1; fi
  rm -f "$FIFO"
  if ! mkfifo -m 600 "$FIFO" 2>/dev/null; then
    printf 'dsh-codex-agent: mkfifo 失败（/tmp 与家目录均不可写）\n' >&2
    exit 12
  fi
fi

OPENED=0
cleanup() {
  # Close the pipe only when this process actually opened it. Never close a
  # pipe another program owns.
  if [ "$OPENED" = 1 ]; then
    tmux pipe-pane -t "$PANE_ID" '' >/dev/null 2>&1 || true
  fi
  rm -f "$FIFO"
}
trap cleanup EXIT
trap 'exit 0' TERM INT HUP

# #{pane_pipe} (tmux >= 3.1) is the only reliable way to tell whether this
# pane already owns a pipe. Without it, `pipe-pane -o` can silently refuse to
# open and we could later close a pipe another program owns, so fail loudly
# instead of risking the user's logger.
EXISTING_PIPE=$(tmux display-message -p -t "$PANE_ID" '#{pane_pipe}' 2>/dev/null || true)
case "$EXISTING_PIPE" in
  0|1) HAVE_PANE_PIPE=1 ;;
  *) HAVE_PANE_PIPE=0 ;;
esac
if [ "$HAVE_PANE_PIPE" = 0 ]; then
  printf 'dsh-codex-agent: 当前 tmux 不支持 pane_pipe，无法安全监控（建议 tmux >= 3.1）\n' >&2
  exit 15
fi
if [ "$EXISTING_PIPE" = "1" ]; then
  if [ "$STALE_PIPE" = 1 ]; then
    # The FIFO is ours, so the pipe it feeds is almost certainly our stale one.
    tmux pipe-pane -t "$PANE_ID" '' >/dev/null 2>&1 || true
  else
    printf 'dsh-codex-agent: 该窗格已有 pipe-pane 占用，未覆盖\n' >&2
    exit 14
  fi
fi

# `-O` pipes pane output to the command (the requested stream direction);
# `-o` refuses to replace a pipe that appeared after the check above.
if ! tmux pipe-pane -Oo -t "$PANE_ID" "cat >> '$FIFO'" 2>/dev/null; then
  printf 'dsh-codex-agent: tmux pipe-pane 失败\n' >&2
  exit 14
fi
OPENED_PIPE=$(tmux display-message -p -t "$PANE_ID" '#{pane_pipe}' 2>/dev/null || true)
if [ "$OPENED_PIPE" != "1" ]; then
  printf 'dsh-codex-agent: tmux pipe-pane 未生效（已有其他 pipe）\n' >&2
  exit 14
fi
OPENED=1
cat "$FIFO"
