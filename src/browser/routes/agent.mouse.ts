import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { handleRouteError, readBody, requirePwAi, resolveProfileContext } from "./agent.shared.js";
import { jsonError, toNumber, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentMouseRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/mouse", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const body = readBody(req);
    const kind = toStringOrEmpty(body.kind);
    if (!kind || !["move", "click", "doubleClick", "rightClick"].includes(kind)) {
      return jsonError(res, 400, "kind must be one of: move, click, doubleClick, rightClick");
    }
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const ref = toStringOrEmpty(body.ref) || undefined;
    const x = toNumber(body.x);
    const y = toNumber(body.y);

    if (!ref && (x === undefined || y === undefined)) {
      return jsonError(res, 400, "ref or x/y screen coordinates are required");
    }

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId);
      const cdpUrl = profileCtx.profile.cdpUrl;

      const pw = await requirePwAi(res, "mouse");
      if (!pw) {
        return;
      }
      const result = await pw.mouseViaCliclick({
        cdpUrl,
        targetId: tab.targetId,
        kind: kind as "move" | "click" | "doubleClick" | "rightClick",
        ref,
        x: x ?? undefined,
        y: y ?? undefined,
      });

      return res.json({ ok: true, targetId: tab.targetId, ...result });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
