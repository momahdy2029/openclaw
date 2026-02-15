---
name: claude-consult
description: "Consult Claude (Anthropic) for a second opinion, planning help, code review, or reasoning on complex topics. Use `claude -p` for quick one-shot questions."
metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["claude"] } } }
---

# Consult Claude

Use the Claude Code CLI in **print mode** (`-p`) to ask Claude a question and get a direct response. This is for quick consultations — not for running Claude as a coding agent.

## When to Use

- You need a second opinion on a plan or approach
- You want help reasoning through a complex problem
- You need a code review or sanity check
- You want to verify facts or get a different perspective
- The user asks you to "check with Claude" or "ask Claude"

## Usage

```bash
claude -p "Your question here"
```

The `-p` flag runs Claude in non-interactive print mode: it sends the prompt, prints the full response, and exits.

## Examples

Ask for a planning opinion:

```bash
claude -p "I'm building a rate limiter for a webhook endpoint. Should I use a token bucket or sliding window approach? The endpoint receives ~500 req/s in bursts."
```

Get a code review:

```bash
claude -p "Review this function for bugs and edge cases: $(cat /path/to/file.ts)"
```

Verify an approach:

```bash
claude -p "Is it safe to use crypto.randomUUID() for idempotency keys in a distributed system?"
```

## Rules

1. **Use `-p` only** — do NOT run interactive `claude` sessions for consultations
2. **Be specific** — include relevant context in your prompt so Claude has enough to work with
3. **Keep it focused** — one question per invocation; don't dump entire codebases
4. **Attribute clearly** — when relaying Claude's answer, tell the user it came from Claude
