import type { ResolvedChatwootAccount } from "./accounts.js";

export async function sendChatwootMessage(params: {
  apiUrl: string;
  apiToken: string;
  accountId: number;
  conversationId: number;
  content: string;
}): Promise<{ id?: number } | null> {
  const { apiUrl, apiToken, accountId, conversationId, content } = params;
  const url = `${apiUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      api_access_token: apiToken,
    },
    body: JSON.stringify({
      content,
      message_type: "outgoing",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chatwoot API ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as { id?: number } | null;
}

export async function probeChatwoot(account: ResolvedChatwootAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  try {
    const url = `${account.apiUrl}/api/v1/profile`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        api_access_token: account.apiToken,
      },
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status, error: res.statusText };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
