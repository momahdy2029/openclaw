#!/usr/bin/env python3
"""OpenClaw Supervisor Bot — standalone Telegram bot that runs Claude Code CLI."""

import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BOT_TOKEN = os.environ.get("SUPERVISOR_BOT_TOKEN", "")
ALLOWED_USER = int(os.environ.get("SUPERVISOR_ALLOWED_USER", "5021811410"))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local" / "bin" / "claude"))
SYSTEM_PROMPT_PATH = Path(__file__).parent / "system-prompt.md"
CLAUDE_TIMEOUT = 120
POLL_TIMEOUT = 30
MAX_MSG_LEN = 4000

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("supervisor")

# --- Telegram helpers (stdlib only) ---

def tg(method, **params):
    """Call a Telegram Bot API method. Returns parsed JSON or None."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps({k: v for k, v in params.items() if v is not None}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=POLL_TIMEOUT + 10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        log.error("Telegram %s error %s: %s", method, e.code, body)
        return None
    except Exception as e:
        log.error("Telegram %s failed: %s", method, e)
        return None


def send(chat_id, text, parse_mode=None):
    """Send a message, chunking if needed."""
    chunks = chunk_text(text, MAX_MSG_LEN)
    for c in chunks:
        tg("sendMessage", chat_id=chat_id, text=c, parse_mode=parse_mode)


def typing(chat_id):
    """Send typing indicator."""
    tg("sendChatAction", chat_id=chat_id, action="typing")


def chunk_text(text, limit):
    """Split text at word boundaries into chunks of at most `limit` chars."""
    if len(text) <= limit:
        return [text]
    chunks = []
    while text:
        if len(text) <= limit:
            chunks.append(text)
            break
        cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        if cut < limit // 4:
            cut = limit
        chunks.append(text[:cut])
        text = text[cut:].lstrip("\n")
    return chunks


# --- Session management ---

sessions = {}  # chat_id -> session_id


def clear_session(chat_id):
    sessions.pop(chat_id, None)


# --- Claude CLI ---

def load_system_prompt():
    try:
        return SYSTEM_PROMPT_PATH.read_text().strip()
    except FileNotFoundError:
        return "You are a supervisor for the OpenClaw gateway. Help diagnose and fix issues."


def run_claude(chat_id, user_text):
    """Invoke claude CLI, return response text."""
    session_id = sessions.get(chat_id)
    system_prompt = load_system_prompt()

    cmd = [
        CLAUDE_BIN, "-p",
        "--output-format", "json",
        "--dangerously-skip-permissions",
        "--model", "sonnet",
    ]

    if session_id:
        cmd += ["--resume", session_id]
    else:
        cmd += ["--append-system-prompt", system_prompt]

    cmd.append(user_text)

    log.info("Claude cmd: %s", " ".join(cmd[:6]) + " ...")

    # Clean env: unset CLAUDECODE to avoid nested-session detection
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=CLAUDE_TIMEOUT,
            cwd=str(Path(__file__).resolve().parent),
            env=env,
        )
    except subprocess.TimeoutExpired:
        return "[timeout] Claude took too long (>120s). Try a simpler request or /new to reset."

    if proc.returncode != 0:
        stderr = proc.stderr.strip()[-500:] if proc.stderr else "(no stderr)"
        log.error("Claude exit %d: %s", proc.returncode, stderr)
        return f"[error] Claude exited with code {proc.returncode}.\n{stderr}"

    # Parse JSON output
    stdout = proc.stdout.strip()
    if not stdout:
        return "[error] Claude returned empty output."

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        # Sometimes output has non-JSON preamble; try last line
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    result = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
        else:
            return f"[error] Could not parse Claude output:\n{stdout[:1000]}"

    # Store session for continuity
    if "session_id" in result:
        sessions[chat_id] = result["session_id"]

    message = result.get("result", result.get("message", ""))
    if not message:
        return f"[warning] No message in response. Raw:\n{json.dumps(result)[:1000]}"

    return message


# --- Built-in commands (no Claude needed) ---

def cmd_status():
    """Quick OpenClaw health check."""
    lines = []

    # launchctl check
    try:
        out = subprocess.run(
            ["launchctl", "list"],
            capture_output=True, text=True, timeout=5
        ).stdout
        gw = [l for l in out.splitlines() if "openclaw.gateway" in l]
        if gw:
            parts = gw[0].split()
            pid, status = parts[0], parts[1]
            lines.append(f"Gateway: PID {pid} (exit status {status})")
        else:
            lines.append("Gateway: NOT loaded in launchctl")
    except Exception as e:
        lines.append(f"Gateway: launchctl check failed ({e})")

    # Port check
    try:
        out = subprocess.run(
            ["lsof", "-i", ":18789", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if out:
            lines.append(f"Port 18789: LISTENING")
        else:
            lines.append("Port 18789: NOT listening")
    except Exception as e:
        lines.append(f"Port check: failed ({e})")

    # Log tail
    log_path = Path.home() / ".openclaw" / "logs" / "gateway.err.log"
    try:
        content = log_path.read_text()
        last_lines = content.strip().splitlines()[-3:]
        if last_lines:
            lines.append("Recent errors:\n" + "\n".join(last_lines))
        else:
            lines.append("No recent errors in log.")
    except FileNotFoundError:
        lines.append("Error log not found.")

    return "\n".join(lines)


def cmd_logs(n=20):
    """Tail recent gateway logs."""
    for name in ["gateway.err.log", "gateway.log"]:
        path = Path.home() / ".openclaw" / "logs" / name
        try:
            content = path.read_text()
            tail = "\n".join(content.strip().splitlines()[-n:])
            if tail:
                return f"=== {name} (last {n} lines) ===\n{tail}"
        except FileNotFoundError:
            continue
    return "No log files found."


# --- Main loop ---

def handle_message(msg):
    chat_id = msg["chat"]["id"]
    user = msg.get("from", {})
    user_id = user.get("id", 0)
    text = msg.get("text", "").strip()

    if not text:
        return

    if user_id != ALLOWED_USER:
        log.warning("Rejected message from user %d (%s)", user_id, user.get("username", "?"))
        send(chat_id, "Not authorized.")
        return

    log.info("From user %d: %s", user_id, text[:80])

    # Built-in commands
    if text.lower() == "/new" or text.lower() == "/start":
        clear_session(chat_id)
        send(chat_id, "Session cleared. Fresh start.")
        return

    if text.lower() == "/status":
        send(chat_id, cmd_status())
        return

    if text.lower().startswith("/logs"):
        parts = text.split()
        n = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 20
        send(chat_id, cmd_logs(n))
        return

    if text.lower() == "/help":
        send(chat_id, (
            "/status — quick gateway health check\n"
            "/logs [N] — tail N lines of gateway logs\n"
            "/new — clear Claude session\n"
            "Anything else goes to Claude."
        ))
        return

    # Send to Claude
    typing(chat_id)

    # Run Claude in a thread so we can keep sending typing indicators
    result_holder = [None]
    error_holder = [None]

    def worker():
        try:
            result_holder[0] = run_claude(chat_id, text)
        except Exception as e:
            error_holder[0] = str(e)

    t = threading.Thread(target=worker)
    t.start()

    # Send typing every 5s while Claude is working
    while t.is_alive():
        t.join(timeout=5)
        if t.is_alive():
            typing(chat_id)

    if error_holder[0]:
        log.error("Claude worker error: %s", error_holder[0])
        send(chat_id, f"[error] {error_holder[0]}")
    elif result_holder[0]:
        log.info("Sending response (%d chars)", len(result_holder[0]))
        send(chat_id, result_holder[0])
    else:
        log.warning("No response from Claude")
        send(chat_id, "[error] No response from Claude.")


def poll_loop():
    offset = 0
    log.info("Supervisor bot starting (allowed user: %d)", ALLOWED_USER)

    while True:
        try:
            resp = tg("getUpdates", offset=offset, timeout=POLL_TIMEOUT)
            if not resp or not resp.get("ok"):
                log.warning("getUpdates failed, retrying in 5s...")
                time.sleep(5)
                continue

            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                if "message" in update:
                    try:
                        handle_message(update["message"])
                    except Exception as e:
                        log.exception("Error handling message: %s", e)
        except KeyboardInterrupt:
            log.info("Shutting down.")
            break
        except Exception as e:
            log.exception("Poll loop error: %s", e)
            time.sleep(5)


def main():
    if not BOT_TOKEN:
        print("Set SUPERVISOR_BOT_TOKEN environment variable.", file=sys.stderr)
        sys.exit(1)

    # Verify token with getMe
    me = tg("getMe")
    if not me or not me.get("ok"):
        print("Invalid bot token — getMe failed.", file=sys.stderr)
        sys.exit(1)

    bot_info = me["result"]
    log.info("Bot: @%s (%s)", bot_info.get("username"), bot_info.get("first_name"))

    # Graceful shutdown
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    poll_loop()


if __name__ == "__main__":
    main()
