import type { DmPolicy } from "openclaw/plugin-sdk";

export type ChatwootAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Chatwoot account. Default: true. */
  enabled?: boolean;
  /** Chatwoot instance base URL (e.g. https://app.chatwoot.com). */
  apiUrl?: string;
  /** Chatwoot API access token (agent or bot token). */
  apiToken?: string;
  /** Path to a file containing the Chatwoot API token. */
  tokenFile?: string;
  /** Webhook path (default: /chatwoot). */
  webhookPath?: string;
  /** Direct message access policy (default: open). */
  dmPolicy?: DmPolicy;
  /** Allowlist for senders (contact IDs or "*"). */
  allowFrom?: Array<string | number>;
  /** Allow bot-authored messages to trigger replies (default: false). */
  allowBots?: boolean;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  blockStreaming?: boolean;
};

export type ChatwootConfig = {
  /** Optional per-account Chatwoot configuration (multi-account). */
  accounts?: Record<string, ChatwootAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & ChatwootAccountConfig;
