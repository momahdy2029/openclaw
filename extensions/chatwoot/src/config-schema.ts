import { DmPolicySchema } from "openclaw/plugin-sdk";
import { z } from "zod";

export const ChatwootAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiUrl: z.string().optional(),
    apiToken: z.string().optional(),
    tokenFile: z.string().optional(),
    webhookPath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("open"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    allowBots: z.boolean().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

export const ChatwootConfigSchema = ChatwootAccountSchema.extend({
  accounts: z.record(z.string(), ChatwootAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});
