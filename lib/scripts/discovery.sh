#!/usr/bin/env bash
# Remote discovery for dsh-remote-codex-agent. Read-only: no Codex files are modified.
# Emitted records (pipe-delimited). T/P/J free text is base64; S/U free text is
# SQLite hex() because SQL cannot base64-encode:
#   DSH1
#   T|session|widx|pidx|title|pane_pid|window_name|session_id|pane_id|active|current_command
#   P|pane_id|cwd|cmdline|pid
#   S|id_hex|title_hex|cwd_hex|updated_at|rollout_path_hex|rollout_mtime|source
#   J|mtime|path_base64|session_id_base64|cwd_base64
#   U|id_hex|last_user_line_base64
#   E|area|message
#   END
set -u

DSH_DAYS="${DSH_DAYS:-3}"
case "$DSH_DAYS" in
  ''|*[!0-9]*) DSH_DAYS=3 ;;
esac
if [ "$DSH_DAYS" -lt 1 ]; then DSH_DAYS=1; fi
if [ "$DSH_DAYS" -gt 30 ]; then DSH_DAYS=30; fi
DSH_WINDOW=$((DSH_DAYS * 86400))
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"

BASE="${TMPDIR:-/tmp}/dsh-remote-codex-agent"
mkdir -p "$BASE" 2>/dev/null || {
  BASE="$HOME/.dsh-remote-codex-agent"
  mkdir -p "$BASE" 2>/dev/null || BASE="/tmp"
}
TMP="$BASE/discover.$$"
ERR="$BASE/discover.$$.err"
PYTMP="$BASE/python.$$"
JSONL="$BASE/jsonl.$$"
cleanup() { rm -f "$TMP" "$ERR" "$PYTMP" "$JSONL" "$JSONL.cut"; }
trap cleanup EXIT

b64() { printf '%s' "$1" | base64 2>/dev/null | tr -d '\n'; }
emit_err() { printf 'E|%s|%s\n' "$1" "$(b64 "$2")"; }
stat_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || printf '0'; }

walk_pid() {
  local pid="$1" depth="$2" pane="$3"
  local comm cmd cwd children child is_codex
  [ -n "$pid" ] || return 0
  [ "$depth" -le 6 ] || return 0
  comm=$(cat "/proc/$pid/comm" 2>/dev/null) || return 0
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || cmd=""
  is_codex=0
  case "$comm" in codex*) is_codex=1 ;; esac
  case "$cmd" in *codex*) is_codex=1 ;; esac
  if [ "$is_codex" = 1 ]; then
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || cwd=""
    printf 'P|%s|%s|%s|%s\n' "$pane" "$(b64 "$cwd")" "$(b64 "$cmd")" "$pid"
  fi
  children=$(cat "/proc/$pid/task/$pid/children" 2>/dev/null) || children=""
  for child in $children; do
    walk_pid "$child" $((depth + 1)) "$pane"
  done
}

printf 'DSH1\n'

if ! command -v base64 >/dev/null 2>&1; then
  emit_err base64 "base64 未安装，tmux 与会话文本字段不可用"
fi

# --- tmux panes (location clues only) -------------------------------------
if command -v tmux >/dev/null 2>&1; then
  MSG=$(tmux list-sessions 2>&1 >/dev/null) && TMUX_OK=1 || TMUX_OK=0
  if [ "$TMUX_OK" = 1 ]; then
    SEP=$'\x1f'
    FMT="#{session_name}${SEP}#{window_index}${SEP}#{pane_index}${SEP}#{pane_title}${SEP}#{pane_pid}${SEP}#{window_name}${SEP}#{session_id}${SEP}#{pane_id}${SEP}#{pane_active}${SEP}#{pane_current_command}"
    tmux list-panes -a -F "$FMT" 2>"$ERR" | while IFS="$SEP" read -r sname widx pidx ptitle ppid wname sid paneid active curcmd; do
      printf 'T|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "$(b64 "$sname")" "$widx" "$pidx" "$(b64 "$ptitle")" "$ppid" \
        "$(b64 "$wname")" "$(b64 "$sid")" "$paneid" "$active" "$(b64 "$curcmd")"
      walk_pid "$ppid" 0 "$paneid"
    done
    if [ -s "$ERR" ]; then emit_err tmux "$(head -c 300 "$ERR" 2>/dev/null)"; fi
  else
    case "$MSG" in
      *"no server running"*|*"No such file or directory"*|*"no sessions"*|*"failed to connect to server"*) : ;;
      *) emit_err tmux "$MSG" ;;
    esac
  fi
else
  emit_err tmux "tmux 未安装"
fi

# --- Codex sessions (SQLite threads, JSONL fallback) ----------------------
SQLITE_OK=0
DB="$CODEX_HOME_DIR/state_5.sqlite"

# 1) Preferred source: Python's stdlib sqlite3. It needs no external binary and
# gives us thread_source / first_user_message so the Host can tell the main
# Codex task apart from its subagents. Read-only, no journal writes.
if [ -f "$DB" ] && command -v python3 >/dev/null 2>&1; then
  PY_OUT=$(python3 - "$DSH_WINDOW" "$DB" 2>"$ERR" <<'PY'
import base64, os, re, sqlite3, sys, time
import urllib.parse

window = int(sys.argv[1]) if len(sys.argv) > 1 else 2592000
db = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser('~/.codex/state_5.sqlite')

def b64(value):
    return base64.b64encode(str(value or '').encode('utf-8', 'replace')).decode('ascii')

def hexed(value):
    return str(value or '').encode('utf-8', 'replace').hex()

def parent_of(source):
    match = re.search(r'"parent_thread_id"\s*:\s*"([^"]+)"', source or '')
    return match.group(1) if match else ''

def last_user_line(path):
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 65536))
            data = handle.read().decode('utf-8', 'ignore')
        for line in reversed(data.splitlines()):
            if '"role":"user"' in line or '"user_message"' in line:
                return line[:20000]
    except OSError:
        pass
    return ''

columns = 'id,title,cwd,updated_at,rollout_path'
extended = 'id,title,cwd,updated_at,rollout_path,thread_source,source,first_user_message,agent_nickname'
try:
    # CODEX_HOME may point outside ~; pass the resolved DB and escape it for
    # the read-only SQLite URI.
    con = sqlite3.connect('file:' + urllib.parse.quote(db, safe='/') + '?mode=ro', uri=True, timeout=3)
    cutoff = int(time.time()) - window
    try:
        cursor = con.execute(
            'SELECT ' + extended + ' FROM threads '
            'WHERE archived = 0 AND updated_at >= ? ORDER BY updated_at DESC LIMIT 500',
            (cutoff,),
        )
        has_extras = True
    except sqlite3.OperationalError:
        cursor = con.execute(
            'SELECT ' + columns + ' FROM threads '
            'WHERE archived = 0 AND updated_at >= ? ORDER BY updated_at DESC LIMIT 500',
            (cutoff,),
        )
        has_extras = False
    for index, row in enumerate(cursor):
        if has_extras:
            ident, title, cwd, updated, rollout, thread_source, source, first_user, nickname = row
        else:
            ident, title, cwd, updated, rollout = row
            thread_source = source = first_user = nickname = ''
        ident = '' if ident is None else str(ident)
        title = '' if title is None else str(title)
        cwd = '' if cwd is None else str(cwd)
        rollout = '' if rollout is None else str(rollout)
        thread_source = '' if thread_source is None else str(thread_source)
        source = '' if source is None else str(source)
        first_user = '' if first_user is None else str(first_user)[:500]
        nickname = '' if nickname is None else str(nickname)
        mtime = 0
        if rollout:
            try:
                mtime = int(os.stat(rollout).st_mtime)
            except OSError:
                mtime = 0
        print('S|%s|%s|%s|%s|%s|%s|sqlite|%s|%s|%s|%s' % (
            hexed(ident), hexed(title), hexed(cwd), int(updated or 0), hexed(rollout), mtime,
            hexed(thread_source), hexed(parent_of(source)), hexed(first_user), hexed(nickname),
        ))
        if not title and not first_user and rollout and index < 100:
            line = last_user_line(rollout)
            if line:
                print('U|%s|%s' % (hexed(ident), b64(line)))
    con.close()
except Exception as exc:
    print('E|sqlite|%s' % b64('%s: %s' % (type(exc).__name__, exc)))
PY
)
  if printf '%s' "$PY_OUT" | grep -q '^S|'; then
    SQLITE_OK=1
    printf '%s\n' "$PY_OUT"
  else
    PY_ERROR=$(printf '%s\n' "$PY_OUT" | grep -m 1 '^E|sqlite|')
    if [ -n "$PY_ERROR" ]; then
      printf '%s\n' "$PY_ERROR"
    else
      emit_err sqlite "$(head -c 400 "$ERR" 2>/dev/null)"
    fi
  fi
fi

# 2) sqlite3 CLI fallback (core columns only; older images / no python3).
if [ "$SQLITE_OK" = 0 ] && command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB" ]; then
  SQL="SELECT hex(COALESCE(id,'')), hex(COALESCE(title,'')), hex(COALESCE(cwd,'')), CAST(updated_at AS INTEGER), hex(COALESCE(rollout_path,'')), CASE WHEN COALESCE(rollout_path,'') GLOB '*[^A-Za-z0-9/._-]*' THEN '' ELSE COALESCE(rollout_path,'') END FROM threads WHERE archived = 0 AND updated_at >= strftime('%s','now') - $DSH_WINDOW ORDER BY updated_at DESC LIMIT 500;"
  if sqlite3 -readonly -separator $'\t' "$DB" "$SQL" >"$TMP" 2>"$ERR"; then
    SQLITE_OK=1
    while IFS=$'\t' read -r idh titleh cwdh upd rph rp; do
      [ -n "$idh" ] || continue
      mt=0
      if [ -n "$rp" ] && [ -f "$rp" ]; then mt=$(stat_mtime "$rp"); fi
      printf 'S|%s|%s|%s|%s|%s|%s|sqlite\n' "$idh" "$titleh" "$cwdh" "$upd" "$rph" "$mt"
      if [ -z "$titleh" ] && [ -n "$rp" ] && [ -f "$rp" ]; then
        last=$(tail -n 300 "$rp" 2>/dev/null | grep -a -E '"role":"user"|"user_message"' | tail -n 1 | head -c 20000)
        if [ -n "$last" ]; then printf 'U|%s|%s\n' "$idh" "$(b64 "$last")"; fi
      fi
    done < "$TMP"
  else
    emit_err sqlite "$(head -c 400 "$ERR" 2>/dev/null)"
  fi
fi

# 3) Last resort: parse rollout session_meta files. Sort by mtime descending
# before the cap: a directory can hold years of rollouts, and the running one is
# the newest file, not whichever file `find` happens to emit first.
if [ "$SQLITE_OK" = 0 ]; then
  if [ -d "$CODEX_HOME_DIR/sessions" ]; then
    if find "$CODEX_HOME_DIR/sessions" -maxdepth 0 -printf '' >/dev/null 2>&1; then
      find "$CODEX_HOME_DIR/sessions" -type f -name 'rollout-*.jsonl' -mtime -"$DSH_DAYS" -printf '%T@\t%p\n' 2>/dev/null \
        | sort -rn | head -n 200 | cut -f2- >"$JSONL.cut"
    else
      find "$CODEX_HOME_DIR/sessions" -type f -name 'rollout-*.jsonl' -mtime -"$DSH_DAYS" -print 2>/dev/null \
        | while IFS= read -r f; do printf '%s\t%s\n' "$(stat_mtime "$f")" "$f"; done \
        | sort -rn | head -n 200 | cut -f2- >"$JSONL.cut"
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      mt=$(stat_mtime "$f")
      # The first rollout line is a session_meta JSON object. It can be large
      # (embedded instructions), so extract only identity and cwd instead of
      # shipping the whole line. A truncated line still contains both early.
      first=$(head -n 1 "$f" 2>/dev/null | head -c 65536)
      # The thread id is `payload.id` (matches threads.id and the filename);
      # `payload.session_id` is the ancestor thread of a resumed/forked rollout.
      sid=$(printf '%s' "$first" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
      if [ -z "$sid" ]; then
        sid=$(printf '%s' "$first" | grep -o '"session_id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
      fi
      cwd=$(printf '%s' "$first" | grep -o '"cwd":"[^"]*"' | head -n 1 | cut -d'"' -f4)
      ts=$(printf '%s' "$first" | grep -o '"thread_source":"[^"]*"' | head -n 1 | cut -d'"' -f4)
      printf 'J|%s|%s|%s|%s|%s\n' "$mt" "$(b64 "$f")" "$(b64 "$sid")" "$(b64 "$cwd")" "$(b64 "$ts")"
    done <"$JSONL.cut"
  else
    emit_err codex "未找到 ${DB}，也没有 ${CODEX_HOME_DIR}/sessions 目录"
  fi
fi

printf 'END\n'
