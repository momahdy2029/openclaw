#!/usr/bin/env python3
"""OpenClaw Supervisor Bot — standalone Telegram bot that runs Claude Code CLI.

Features:
  - Telegram long-polling (stdlib only, zero deps)
  - Claude Code CLI subprocess with streaming responses
  - Session continuity via --resume
  - Proactive health watchdog (alerts on gateway down)
  - Inline keyboard buttons for quick actions
  - Voice replies via Supertonic TTS
  - Native Claude auto-memory (CLAUDE.md + ~/.claude/projects/)
"""

import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# --- Config ---

BOT_TOKEN = os.environ.get("SUPERVISOR_BOT_TOKEN", "")
ALLOWED_USER = int(os.environ.get("SUPERVISOR_ALLOWED_USER", "5021811410"))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local" / "bin" / "claude"))
SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent / "system-prompt.md"
SUPERVISOR_DIR = Path(__file__).resolve().parent

# Supertonic TTS
TTS_SCRIPT = Path.home() / "supertonic" / "py" / "tts_stdout.py"
TTS_ONNX_DIR = Path.home() / "supertonic" / "assets" / "onnx"
TTS_VOICE_STYLE = Path.home() / "supertonic" / "assets" / "voice_styles" / "F1.json"
TTS_PYTHON = "/usr/bin/python3"

CLAUDE_TIMEOUT = 120
POLL_TIMEOUT = 30
MAX_MSG_LEN = 4000
HEALTH_CHECK_INTERVAL = 60  # seconds

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


def tg_multipart(method, files, fields=None):
    """Multipart form upload to Telegram (for sendVoice etc)."""
    boundary = "----SupervisorBoundary"
    body = b""
    for key, val in (fields or {}).items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode()
    for key, (filename, data, content_type) in files.items():
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}"
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except Exception as e:
        log.error("Telegram multipart %s failed: %s", method, e)
        return None


def send(chat_id, text, parse_mode=None, reply_markup=None):
    """Send a message, chunking if needed. Returns last message_id."""
    chunks = chunk_text(text, MAX_MSG_LEN)
    msg_id = None
    for i, c in enumerate(chunks):
        # Only attach reply_markup to the last chunk
        markup = reply_markup if i == len(chunks) - 1 else None
        result = tg("sendMessage", chat_id=chat_id, text=c,
                     parse_mode=parse_mode, reply_markup=markup)
        if result and result.get("ok"):
            msg_id = result["result"]["message_id"]
    return msg_id


def edit_message(chat_id, message_id, text, parse_mode=None):
    """Edit an existing message."""
    tg("editMessageText", chat_id=chat_id, message_id=message_id,
        text=text, parse_mode=parse_mode)


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


def make_action_keyboard():
    """Inline keyboard with common actions."""
    return json.dumps({"inline_keyboard": [
        [
            {"text": "Status", "callback_data": "action:status"},
            {"text": "Logs", "callback_data": "action:logs"},
            {"text": "Restart GW", "callback_data": "action:restart"},
        ],
        [
            {"text": "New Session", "callback_data": "action:new"},
            {"text": "Voice", "callback_data": "action:voice"},
        ],
    ]})


# --- Session management ---

sessions = {}  # chat_id -> session_id
last_voice_response = {}  # chat_id -> last response text (for voice replay)


def clear_session(chat_id):
    sessions.pop(chat_id, None)


# --- Claude CLI ---

def load_system_prompt():
    try:
        return SYSTEM_PROMPT_PATH.read_text().strip()
    except FileNotFoundError:
        return "You are a supervisor for the OpenClaw gateway. Help diagnose and fix issues."


def run_claude_streaming(chat_id, user_text, on_partial=None):
    """Invoke claude CLI with streaming, call on_partial with progressive text."""
    session_id = sessions.get(chat_id)
    system_prompt = load_system_prompt()

    cmd = [
        CLAUDE_BIN, "-p",
        "--output-format", "stream-json",
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
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(SUPERVISOR_DIR),
            env=env,
        )
    except Exception as e:
        return f"[error] Failed to start Claude: {e}"

    full_text = ""
    new_session_id = None
    deadline = time.time() + CLAUDE_TIMEOUT

    try:
        for raw_line in proc.stdout:
            if time.time() > deadline:
                proc.kill()
                return "[timeout] Claude took too long (>120s). Try /new to reset."

            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            etype = event.get("type", "")

            # Capture session_id from any event
            if "session_id" in event:
                new_session_id = event["session_id"]

            if etype == "assistant" and "message" in event:
                # Partial message chunk
                partial = event["message"]
                if partial and on_partial:
                    full_text = partial
                    on_partial(full_text)

            elif etype == "result":
                full_text = event.get("result", full_text)
                if "session_id" in event:
                    new_session_id = event["session_id"]

    except Exception as e:
        log.error("Streaming read error: %s", e)

    proc.wait(timeout=10)

    if new_session_id:
        sessions[chat_id] = new_session_id

    if proc.returncode != 0 and not full_text:
        stderr = proc.stderr.read().decode(errors="replace").strip()[-500:]
        log.error("Claude exit %d: %s", proc.returncode, stderr)
        return f"[error] Claude exited with code {proc.returncode}.\n{stderr}"

    return full_text or "[error] No response from Claude."


# --- Supertonic TTS ---

def text_to_voice(text, lang="en"):
    """Convert text to WAV bytes using Supertonic TTS. Returns bytes or None."""
    if not TTS_SCRIPT.exists():
        log.warning("TTS script not found at %s", TTS_SCRIPT)
        return None

    # Truncate very long text for TTS (keep first ~500 chars)
    tts_text = text[:500] if len(text) > 500 else text

    try:
        proc = subprocess.run(
            [
                TTS_PYTHON,
                str(TTS_SCRIPT),
                "--onnx-dir", str(TTS_ONNX_DIR),
                "--voice-style", str(TTS_VOICE_STYLE),
                "--lang", lang,
                "--text", tts_text,
            ],
            capture_output=True,
            timeout=30,
            cwd=str(TTS_SCRIPT.parent),
        )
        if proc.returncode == 0 and proc.stdout:
            # Convert WAV to OGG/Opus for Telegram voice messages
            return wav_to_ogg(proc.stdout)
        else:
            log.error("TTS failed (exit %d): %s", proc.returncode,
                      proc.stderr.decode(errors="replace")[-200:])
            return None
    except Exception as e:
        log.error("TTS error: %s", e)
        return None


def wav_to_ogg(wav_bytes):
    """Convert WAV bytes to OGG Opus using ffmpeg. Returns bytes or None."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "48k",
             "-application", "voip", "-f", "ogg", "pipe:1"],
            input=wav_bytes,
            capture_output=True,
            timeout=15,
        )
        if proc.returncode == 0 and proc.stdout:
            return proc.stdout
        log.error("ffmpeg failed: %s", proc.stderr.decode(errors="replace")[-200:])
        return None
    except FileNotFoundError:
        log.warning("ffmpeg not found — sending WAV directly")
        return wav_bytes
    except Exception as e:
        log.error("ffmpeg error: %s", e)
        return None


def send_voice(chat_id, audio_bytes, caption=None):
    """Send a voice message via Telegram."""
    return tg_multipart(
        "sendVoice",
        files={"voice": ("response.ogg", audio_bytes, "audio/ogg")},
        fields={"chat_id": str(chat_id), **({"caption": caption} if caption else {})},
    )


# --- Built-in commands (no Claude needed) ---

def check_gateway_health():
    """Returns (is_healthy: bool, status_text: str)."""
    lines = []
    healthy = True

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
            if pid == "-":
                healthy = False
                lines.append("Gateway: NOT running (no PID)")
            else:
                lines.append(f"Gateway: PID {pid} (exit status {status})")
        else:
            healthy = False
            lines.append("Gateway: NOT loaded in launchctl")
    except Exception as e:
        healthy = False
        lines.append(f"Gateway: launchctl check failed ({e})")

    # Port check
    try:
        out = subprocess.run(
            ["lsof", "-i", ":18789", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5
        ).stdout.strip()
        if out:
            lines.append("Port 18789: LISTENING")
        else:
            healthy = False
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

    return healthy, "\n".join(lines)


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


# --- Health watchdog ---

_watchdog_last_state = {"healthy": True, "alerted": False}


def watchdog_loop(chat_id):
    """Background thread: checks gateway health periodically, alerts on failure."""
    log.info("Watchdog started (interval=%ds, chat=%d)", HEALTH_CHECK_INTERVAL, chat_id)
    while True:
        try:
            time.sleep(HEALTH_CHECK_INTERVAL)
            healthy, status = check_gateway_health()

            if not healthy and not _watchdog_last_state["alerted"]:
                # Gateway went down — alert!
                _watchdog_last_state["healthy"] = False
                _watchdog_last_state["alerted"] = True
                log.warning("Watchdog: gateway is DOWN")
                keyboard = json.dumps({"inline_keyboard": [
                    [
                        {"text": "Restart", "callback_data": "action:restart"},
                        {"text": "Logs", "callback_data": "action:logs"},
                        {"text": "Diagnose", "callback_data": "action:diagnose"},
                    ]
                ]})
                send(chat_id, f"Gateway is DOWN.\n\n{status}", reply_markup=keyboard)

            elif healthy and not _watchdog_last_state["healthy"]:
                # Gateway recovered
                _watchdog_last_state["healthy"] = True
                _watchdog_last_state["alerted"] = False
                log.info("Watchdog: gateway recovered")
                send(chat_id, "Gateway is back up.")

            elif healthy:
                _watchdog_last_state["alerted"] = False

        except Exception as e:
            log.exception("Watchdog error: %s", e)


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
    if text.lower() in ("/new", "/start"):
        clear_session(chat_id)
        send(chat_id, "Session cleared. Fresh start.", reply_markup=make_action_keyboard())
        return

    if text.lower() == "/status":
        _, status = check_gateway_health()
        send(chat_id, status, reply_markup=make_action_keyboard())
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
            "/voice — voice-read last response\n"
            "Anything else goes to Claude."
        ), reply_markup=make_action_keyboard())
        return

    if text.lower() == "/voice":
        last = last_voice_response.get(chat_id)
        if last:
            typing(chat_id)
            do_voice_reply(chat_id, last)
        else:
            send(chat_id, "No previous response to read aloud.")
        return

    # Send to Claude with streaming
    typing(chat_id)

    # Send initial "thinking..." message that we'll edit with streaming content
    placeholder = send(chat_id, "...")

    last_edit_time = [0.0]
    last_edit_text = [""]

    def on_partial(text_so_far):
        """Called with progressive response text as Claude streams."""
        now = time.time()
        # Throttle edits to every 3s and only if text changed meaningfully
        if (now - last_edit_time[0] >= 3
                and len(text_so_far) - len(last_edit_text[0]) > 40
                and placeholder
                and len(text_so_far) <= MAX_MSG_LEN):
            edit_message(chat_id, placeholder, text_so_far)
            last_edit_time[0] = now
            last_edit_text[0] = text_so_far
            typing(chat_id)

    # Run Claude in a thread so we can keep sending typing indicators
    result_holder = [None]
    error_holder = [None]

    def worker():
        try:
            result_holder[0] = run_claude_streaming(chat_id, text, on_partial)
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
        if placeholder:
            edit_message(chat_id, placeholder, f"[error] {error_holder[0]}")
        else:
            send(chat_id, f"[error] {error_holder[0]}")
    elif result_holder[0]:
        response = result_holder[0]
        log.info("Sending response (%d chars)", len(response))
        last_voice_response[chat_id] = response

        if placeholder and len(response) <= MAX_MSG_LEN:
            # Edit the placeholder with final response + action buttons
            edit_message(chat_id, placeholder, response)
            # Can't add inline keyboard to edited message text-only, send buttons separately
            # Actually we can use editMessageReplyMarkup
            tg("editMessageReplyMarkup", chat_id=chat_id, message_id=placeholder,
                reply_markup=make_action_keyboard())
        else:
            # Response too long for single edit, delete placeholder and send chunks
            if placeholder:
                tg("deleteMessage", chat_id=chat_id, message_id=placeholder)
            send(chat_id, response, reply_markup=make_action_keyboard())
    else:
        log.warning("No response from Claude")
        if placeholder:
            edit_message(chat_id, placeholder, "[error] No response from Claude.")
        else:
            send(chat_id, "[error] No response from Claude.")


def handle_callback(callback_query):
    """Handle inline keyboard button presses."""
    data = callback_query.get("data", "")
    chat_id = callback_query["message"]["chat"]["id"]
    user_id = callback_query["from"]["id"]
    callback_id = callback_query["id"]

    # Acknowledge the button press
    tg("answerCallbackQuery", callback_query_id=callback_id)

    if user_id != ALLOWED_USER:
        return

    log.info("Callback from %d: %s", user_id, data)

    if data == "action:status":
        _, status = check_gateway_health()
        send(chat_id, status, reply_markup=make_action_keyboard())

    elif data == "action:logs":
        send(chat_id, cmd_logs(20))

    elif data == "action:restart":
        typing(chat_id)
        try:
            proc = subprocess.run(
                ["launchctl", "kickstart", "-k", "gui/501/ai.openclaw.gateway"],
                capture_output=True, text=True, timeout=10
            )
            time.sleep(3)
            healthy, status = check_gateway_health()
            emoji = "OK" if healthy else "WARN"
            send(chat_id, f"[{emoji}] Restart issued.\n\n{status}",
                 reply_markup=make_action_keyboard())
        except Exception as e:
            send(chat_id, f"[error] Restart failed: {e}")

    elif data == "action:new":
        clear_session(chat_id)
        send(chat_id, "Session cleared.", reply_markup=make_action_keyboard())

    elif data == "action:voice":
        last = last_voice_response.get(chat_id)
        if last:
            typing(chat_id)
            do_voice_reply(chat_id, last)
        else:
            send(chat_id, "No previous response to read aloud.")

    elif data == "action:diagnose":
        # Ask Claude to diagnose the gateway issue
        typing(chat_id)
        handle_message({
            "chat": {"id": chat_id},
            "from": {"id": user_id},
            "text": "The gateway appears to be down. Check launchctl status, read recent error logs, check if port 18789 is in use, and tell me what's wrong and how to fix it.",
        })


def do_voice_reply(chat_id, text):
    """Generate and send a voice message from text."""
    # Detect language (simple heuristic)
    lang = "en"
    if any("\u0600" <= c <= "\u06FF" for c in text[:100]):
        lang = "en"  # Arabic not supported by Supertonic, fall back to English
    elif any("\uAC00" <= c <= "\uD7AF" for c in text[:100]):
        lang = "ko"

    audio = text_to_voice(text, lang)
    if audio:
        send_voice(chat_id, audio)
    else:
        send(chat_id, "[TTS unavailable — ffmpeg or Supertonic not set up]")


def poll_loop():
    offset = 0
    log.info("Supervisor bot starting (allowed user: %d)", ALLOWED_USER)

    # Start health watchdog in background
    watchdog = threading.Thread(
        target=watchdog_loop,
        args=(ALLOWED_USER,),  # Send alerts to user's chat (same as user_id for DMs)
        daemon=True,
    )
    watchdog.start()

    while True:
        try:
            resp = tg("getUpdates", offset=offset, timeout=POLL_TIMEOUT,
                       allowed_updates=json.dumps(["message", "callback_query"]))
            if not resp or not resp.get("ok"):
                log.warning("getUpdates failed, retrying in 5s...")
                time.sleep(5)
                continue

            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                try:
                    if "message" in update:
                        handle_message(update["message"])
                    elif "callback_query" in update:
                        handle_callback(update["callback_query"])
                except Exception as e:
                    log.exception("Error handling update: %s", e)
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
