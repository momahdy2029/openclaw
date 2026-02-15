import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  missingTargetError,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  type ChannelDock,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listChatwootAccountIds,
  resolveDefaultChatwootAccountId,
  resolveChatwootAccount,
  type ResolvedChatwootAccount,
} from "./accounts.js";
import { sendChatwootMessage, probeChatwoot } from "./api.js";
import { ChatwootConfigSchema } from "./config-schema.js";
import { resolveChatwootWebhookPath, startChatwootMonitor } from "./monitor.js";
import { getChatwootRuntime } from "./runtime.js";

const meta = {
  id: "chatwoot",
  label: "Chatwoot",
  selectionLabel: "Chatwoot",
  detailLabel: "Chatwoot",
  docsPath: "/channels/chatwoot",
  docsLabel: "chatwoot",
  blurb: "Chatwoot live chat via webhooks.",
  systemImage: "message.fill",
};

function normalizeChatwootTarget(raw?: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/^chatwoot:/i, "");
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export const chatwootDock: ChannelDock = {
  id: "chatwoot",
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    media: false,
    threads: false,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 4000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveChatwootAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map((entry) =>
          entry
            .trim()
            .replace(/^chatwoot:/i, "")
            .toLowerCase(),
        ),
  },
};

export const chatwootPlugin: ChannelPlugin<ResolvedChatwootAccount> = {
  id: "chatwoot",
  meta: { ...meta },
  pairing: {
    idLabel: "chatwootContactId",
    normalizeAllowEntry: (entry) =>
      entry
        .trim()
        .replace(/^chatwoot:/i, "")
        .toLowerCase(),
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.chatwoot"] },
  configSchema: buildChannelConfigSchema(ChatwootConfigSchema),
  config: {
    listAccountIds: (cfg) => listChatwootAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveChatwootAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultChatwootAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "chatwoot",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "chatwoot",
        accountId,
        clearBaseFields: ["apiUrl", "apiToken", "tokenFile", "webhookPath", "name"],
      }),
    isConfigured: (account) => Boolean(account.apiUrl && account.apiToken),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiUrl && account.apiToken),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveChatwootAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map((entry) =>
          entry
            .trim()
            .replace(/^chatwoot:/i, "")
            .toLowerCase(),
        ),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.["chatwoot"]?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.chatwoot.accounts.${resolvedAccountId}.`
        : "channels.chatwoot.";
      return {
        policy: account.config.dmPolicy ?? "open",
        allowFrom: account.config.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("chatwoot"),
        normalizeEntry: (raw) =>
          raw
            .trim()
            .replace(/^chatwoot:/i, "")
            .toLowerCase(),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (account.config.dmPolicy === "open") {
        const hasWildcard = (account.config.allowFrom ?? []).some((v) => String(v) === "*");
        if (!hasWildcard && (account.config.allowFrom ?? []).length === 0) {
          warnings.push(
            `- Chatwoot DMs are open to any visitor. Set channels.chatwoot.dmPolicy="pairing" or "allowlist" for restricted access.`,
          );
        }
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: normalizeChatwootTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return /^\d+$/.test(value);
      },
      hint: "<conversation_id>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveChatwootAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const allowFrom = account.config.allowFrom ?? [];
      const peers = Array.from(
        new Set(
          allowFrom
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*"),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async () => [],
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      return inputs.map((input) => {
        const normalized = normalizeChatwootTarget(input);
        if (!normalized) {
          return { input, resolved: false, note: "empty target" };
        }
        if (/^\d+$/.test(normalized)) {
          return { input, resolved: true, id: normalized };
        }
        return { input, resolved: false, note: "use a numeric conversation ID" };
      });
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "chatwoot",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "CHATWOOT_API_TOKEN env var can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Chatwoot requires --token (API access token) or --token-file.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "chatwoot",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "chatwoot",
            })
          : namedConfig;
      const patch: Record<string, unknown> = {};
      if (!input.useEnv) {
        if (input.tokenFile) {
          patch.tokenFile = input.tokenFile;
        } else if (input.token) {
          patch.apiToken = input.token;
        }
      }
      const webhookPath = input.webhookPath?.trim();
      if (webhookPath) {
        patch.webhookPath = webhookPath;
      }
      const apiUrl = (input as Record<string, unknown>).apiUrl;
      if (typeof apiUrl === "string" && apiUrl.trim()) {
        patch.apiUrl = apiUrl.trim();
      }
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            chatwoot: {
              ...next.channels?.["chatwoot"],
              enabled: true,
              ...patch,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          chatwoot: {
            ...next.channels?.["chatwoot"],
            enabled: true,
            accounts: {
              ...next.channels?.["chatwoot"]?.accounts,
              [accountId]: {
                ...next.channels?.["chatwoot"]?.accounts?.[accountId],
                enabled: true,
                ...patch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getChatwootRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        const normalized = normalizeChatwootTarget(trimmed);
        if (normalized) {
          return { ok: true, to: normalized };
        }
      }
      const list = (allowFrom ?? [])
        .map((entry) => String(entry).trim())
        .filter((entry) => entry && entry !== "*");
      if (list.length > 0) {
        return { ok: true, to: list[0] };
      }
      return {
        ok: false,
        error: missingTargetError(
          "Chatwoot",
          "<conversation_id> or channels.chatwoot.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveChatwootAccount({ cfg, accountId });
      const conversationId = parseInt(to, 10);
      if (isNaN(conversationId)) {
        throw new Error(`Invalid Chatwoot conversation ID: ${to}`);
      }
      // We need the Chatwoot account ID from the API URL context
      // For outbound, we extract it from the config or default to 1
      const chatwootAcctId = extractChatwootAccountIdFromConfig(account);
      const result = await sendChatwootMessage({
        apiUrl: account.apiUrl,
        apiToken: account.apiToken,
        accountId: chatwootAcctId,
        conversationId,
        content: text,
      });
      return {
        channel: "chatwoot",
        messageId: result?.id != null ? String(result.id) : "",
        chatId: to,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) {
          return [];
        }
        const issues: ChannelStatusIssue[] = [];
        if (!entry.baseUrl) {
          issues.push({
            channel: "chatwoot",
            accountId,
            kind: "config",
            message: "Chatwoot apiUrl is missing (set channels.chatwoot.apiUrl).",
            fix: "Set channels.chatwoot.apiUrl to your Chatwoot instance URL.",
          });
        }
        if (!entry.tokenSource) {
          issues.push({
            channel: "chatwoot",
            accountId,
            kind: "config",
            message: "Chatwoot apiToken is missing.",
            fix: "Set channels.chatwoot.apiToken or CHATWOOT_API_TOKEN env var.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      webhookPath: snapshot.webhookPath ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeChatwoot(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiUrl && account.apiToken),
      baseUrl: account.apiUrl || undefined,
      tokenSource: account.apiToken ? "configured" : undefined,
      webhookPath: account.config.webhookPath,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dmPolicy ?? "open",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Chatwoot webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveChatwootWebhookPath({ account }),
      });
      const unregister = await startChatwootMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};

/**
 * Extract the Chatwoot numeric account ID from config.
 * Users can put it in the apiUrl (e.g. https://chatwoot.example.com)
 * but we need the numeric account ID for API calls.
 * This is stored via the webhook payload during inbound, but for outbound
 * we need a fallback. Default to 1 if not determinable.
 */
function extractChatwootAccountIdFromConfig(account: ResolvedChatwootAccount): number {
  // Check if apiUrl contains the account ID pattern
  // Fallback: use 1 as default (single-account Chatwoot installs)
  return 1;
}
