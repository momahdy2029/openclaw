import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ResolvedChatwootAccount } from "./accounts.js";
import { sendChatwootMessage } from "./api.js";
import { getChatwootRuntime } from "./runtime.js";

export type ChatwootRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type ChatwootMonitorOptions = {
  account: ResolvedChatwootAccount;
  config: OpenClawConfig;
  runtime: ChatwootRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type ChatwootCoreRuntime = ReturnType<typeof getChatwootRuntime>;

type WebhookTarget = {
  account: ResolvedChatwootAccount;
  config: OpenClawConfig;
  runtime: ChatwootRuntimeEnv;
  core: ChatwootCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: ChatwootCoreRuntime, runtime: ChatwootRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[chatwoot] ${message}`);
  }
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveWebhookPath(webhookPath?: string): string {
  const trimmedPath = webhookPath?.trim();
  if (trimmedPath) {
    return normalizeWebhookPath(trimmedPath);
  }
  return "/chatwoot";
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    let resolved = false;
    const doResolve = (value: { ok: boolean; value?: unknown; error?: string }) => {
      if (resolved) {
        return;
      }
      resolved = true;
      req.removeAllListeners();
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        doResolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          doResolve({ ok: false, error: "empty payload" });
          return;
        }
        doResolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      doResolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

export function registerChatwootWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

// Chatwoot webhook payload types
type ChatwootWebhookPayload = {
  event?: string;
  id?: number;
  content?: string;
  content_type?: string;
  message_type?: "incoming" | "outgoing" | "activity" | "template";
  account?: { id?: number };
  conversation?: { id?: number; status?: string };
  sender?: { id?: number; name?: string; email?: string; type?: string };
  inbox?: { id?: number; name?: string };
};

export async function handleChatwootWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const raw = body.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const payload = raw as ChatwootWebhookPayload;

  // Only handle message_created events
  if (payload.event !== "message_created") {
    res.statusCode = 200;
    res.end("ignored");
    return true;
  }

  // Only process incoming messages (skip outgoing/activity/template to avoid echo loops)
  if (payload.message_type !== "incoming") {
    res.statusCode = 200;
    res.end("ignored");
    return true;
  }

  // Match to a target by account ID
  const chatwootAccountId = payload.account?.id;
  const selected = targets[0]; // Use first target for this path

  if (!selected) {
    res.statusCode = 200;
    res.end("no target");
    return true;
  }

  selected.statusSink?.({ lastInboundAt: Date.now() });

  // Respond 200 immediately, process async
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end("{}");

  processChatwootMessage(payload, selected).catch((err) => {
    selected.runtime.error?.(
      `[${selected.account.accountId}] Chatwoot webhook failed: ${String(err)}`,
    );
  });

  return true;
}

function isSenderAllowed(senderId: string, allowFrom: Array<string | number>): boolean {
  if (allowFrom.length === 0) {
    return true;
  }
  const stringList = allowFrom.map((v) => String(v).trim().toLowerCase());
  if (stringList.includes("*")) {
    return true;
  }
  return stringList.includes(senderId.toLowerCase());
}

async function processChatwootMessage(
  payload: ChatwootWebhookPayload,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;

  const content = (payload.content ?? "").trim();
  if (!content) {
    return;
  }

  const chatwootAccountId = payload.account?.id;
  const conversationId = payload.conversation?.id;
  const senderId = payload.sender?.id;
  const senderName = payload.sender?.name ?? "";
  const senderType = payload.sender?.type ?? "";

  if (!chatwootAccountId || !conversationId || senderId == null) {
    logVerbose(core, runtime, "skip: missing account/conversation/sender id");
    return;
  }

  // Skip bot senders unless allowBots is true
  if (!account.config.allowBots) {
    if (senderType === "agent_bot" || senderType === "AgentBot") {
      logVerbose(core, runtime, `skip bot-authored message (sender=${senderId})`);
      return;
    }
  }

  // Check allowFrom
  const allowFrom = account.config.allowFrom ?? [];
  const dmPolicy = account.config.dmPolicy ?? "open";

  if (dmPolicy === "disabled") {
    logVerbose(core, runtime, `blocked Chatwoot message from ${senderId} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    const storeAllowFrom = await core.channel.pairing
      .readAllowFromStore("chatwoot")
      .catch(() => []);
    const effectiveAllowFrom = [...allowFrom, ...storeAllowFrom];

    if (!isSenderAllowed(String(senderId), effectiveAllowFrom)) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "chatwoot",
          id: String(senderId),
          meta: { name: senderName || undefined },
        });
        if (created) {
          logVerbose(core, runtime, `chatwoot pairing request sender=${senderId}`);
          try {
            await sendChatwootMessage({
              apiUrl: account.apiUrl,
              apiToken: account.apiToken,
              accountId: chatwootAccountId,
              conversationId,
              content: core.channel.pairing.buildPairingReply({
                channel: "chatwoot",
                idLine: `Your Chatwoot contact id: ${senderId}`,
                code,
              }),
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            logVerbose(core, runtime, `pairing reply failed for ${senderId}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(
          core,
          runtime,
          `blocked unauthorized Chatwoot sender ${senderId} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "chatwoot",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: String(conversationId),
    },
  });

  const fromLabel = senderName || `contact:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Chatwoot",
    from: fromLabel,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: content,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: `chatwoot:${senderId}`,
    To: `chatwoot:${conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: String(senderId),
    Provider: "chatwoot",
    Surface: "chatwoot",
    MessageSid: payload.id != null ? String(payload.id) : undefined,
    OriginatingChannel: "chatwoot",
    OriginatingTo: `chatwoot:${conversationId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`chatwoot: failed updating session meta: ${String(err)}`);
    });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "chatwoot",
    accountId: route.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        await deliverChatwootReply({
          payload: replyPayload,
          account,
          chatwootAccountId,
          conversationId,
          runtime,
          core,
          config,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Chatwoot ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverChatwootReply(params: {
  payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  account: ResolvedChatwootAccount;
  chatwootAccountId: number;
  conversationId: number;
  runtime: ChatwootRuntimeEnv;
  core: ChatwootCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatwootAccountId, conversationId, runtime, core, config, statusSink } =
    params;

  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 4000;
    const chunkMode = core.channel.text.resolveChunkMode(config, "chatwoot", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendChatwootMessage({
          apiUrl: account.apiUrl,
          apiToken: account.apiToken,
          accountId: chatwootAccountId,
          conversationId,
          content: chunk,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Chatwoot message send failed: ${String(err)}`);
      }
    }
  }
}

export function monitorChatwootProvider(options: ChatwootMonitorOptions): () => void {
  const core = getChatwootRuntime();
  const webhookPath = resolveWebhookPath(options.webhookPath ?? options.account.config.webhookPath);

  const unregister = registerChatwootWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    statusSink: options.statusSink,
  });

  return unregister;
}

export async function startChatwootMonitor(params: ChatwootMonitorOptions): Promise<() => void> {
  return monitorChatwootProvider(params);
}

export function resolveChatwootWebhookPath(params: { account: ResolvedChatwootAccount }): string {
  return resolveWebhookPath(params.account.config.webhookPath);
}
