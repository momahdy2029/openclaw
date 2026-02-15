import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { ChatwootAccountConfig } from "./types.config.js";

export type ResolvedChatwootAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: ChatwootAccountConfig;
  apiUrl: string;
  apiToken: string;
};

const ENV_API_TOKEN = "CHATWOOT_API_TOKEN";

function getChatwootSection(
  cfg: OpenClawConfig,
):
  | (ChatwootAccountConfig & {
      accounts?: Record<string, ChatwootAccountConfig>;
      defaultAccount?: string;
    })
  | undefined {
  return cfg.channels?.["chatwoot"] as any;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = getChatwootSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listChatwootAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultChatwootAccountId(cfg: OpenClawConfig): string {
  const channel = getChatwootSection(cfg);
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }
  const ids = listChatwootAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ChatwootAccountConfig | undefined {
  const accounts = getChatwootSection(cfg)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeChatwootAccountConfig(cfg: OpenClawConfig, accountId: string): ChatwootAccountConfig {
  const raw = getChatwootSection(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as ChatwootAccountConfig;
}

function resolveApiToken(params: { accountId: string; config: ChatwootAccountConfig }): string {
  const { accountId, config } = params;

  // 1. Inline token in config
  const inline = config.apiToken?.trim();
  if (inline) {
    return inline;
  }

  // 2. Token file
  const tokenFile = config.tokenFile?.trim();
  if (tokenFile) {
    try {
      return readFileSync(tokenFile, "utf8").trim();
    } catch {
      // fall through
    }
  }

  // 3. Environment variable (default account only)
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envToken = process.env[ENV_API_TOKEN]?.trim();
    if (envToken) {
      return envToken;
    }
  }

  return "";
}

export function resolveChatwootAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedChatwootAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = getChatwootSection(params.cfg)?.enabled !== false;
  const merged = mergeChatwootAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const apiToken = resolveApiToken({ accountId, config: merged });
  const apiUrl = (merged.apiUrl ?? "").replace(/\/+$/, "");

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    apiUrl,
    apiToken,
  };
}

export function listEnabledChatwootAccounts(cfg: OpenClawConfig): ResolvedChatwootAccount[] {
  return listChatwootAccountIds(cfg)
    .map((accountId) => resolveChatwootAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
