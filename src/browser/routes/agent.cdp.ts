import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { handleRouteError, resolveProfileContext } from "./agent.shared.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

/**
 * Send a CDP command directly through the extension relay WebSocket,
 * bypassing Playwright's CDPSession (which fails with Target.attachToBrowserTarget
 * on extension relays).
 */
async function sendCdpCommandViaRelay(opts: {
  cdpUrl: string;
  targetId?: string;
  method: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const { withCdpSocket } = await import("../cdp.helpers.js");
  const wsUrl =
    opts.cdpUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "") + "/cdp";

  return await withCdpSocket(
    wsUrl,
    async (send) => {
      let sessionId: string | undefined;
      if (opts.targetId) {
        const attached = (await send("Target.attachToTarget", {
          targetId: opts.targetId,
        })) as { sessionId?: string };
        sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
      }
      return await send(opts.method, opts.params ?? {}, sessionId);
    },
    { handshakeTimeoutMs: 5000 },
  );
}

export function registerBrowserAgentCdpRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/cdp", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const method = toStringOrEmpty(body.method);
    if (!method) {
      return jsonError(res, 400, "method is required");
    }
    const params =
      typeof body.params === "object" && body.params !== null
        ? (body.params as Record<string, unknown>)
        : undefined;
    const targetId = toStringOrEmpty(body.targetId) || undefined;

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);

      let result: unknown;
      if (profileCtx.profile.driver === "extension") {
        // Extension relay: send CDP directly through the relay WebSocket.
        // Playwright's newCDPSession fails on extension relays because
        // Target.attachToBrowserTarget is not supported.
        result = await sendCdpCommandViaRelay({
          cdpUrl: profileCtx.profile.cdpUrl,
          targetId: tab.targetId,
          method,
          params,
        });
      } else {
        const { sendCdpCommandViaPlaywright } = await import("../pw-tools-core.state.js");
        result = await sendCdpCommandViaPlaywright({
          cdpUrl: profileCtx.profile.cdpUrl,
          targetId: tab.targetId,
          method,
          params,
        });
      }
      res.json({ ok: true, result: result ?? {} });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
