import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { handleRouteError, resolveProfileContext } from "./agent.shared.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

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
      const { sendCdpCommandViaPlaywright } = await import("../pw-tools-core.state.js");
      const result = await sendCdpCommandViaPlaywright({
        cdpUrl: profileCtx.profile.cdpUrl,
        targetId: tab.targetId,
        method,
        params,
      });
      res.json({ ok: true, result: result ?? {} });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
