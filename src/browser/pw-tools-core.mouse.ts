import { execFile } from "node:child_process";
import { platform } from "node:os";
import {
  ensurePageState,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { requireRef, toAIFriendlyError } from "./pw-tools-core.shared.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };

type MouseKind = "move" | "click" | "doubleClick" | "rightClick";

const VALID_MOUSE_KINDS = new Set<string>(["move", "click", "doubleClick", "rightClick"]);

export function isMouseKind(value: string): value is MouseKind {
  return VALID_MOUSE_KINDS.has(value);
}

// ---------------------------------------------------------------------------
// cliclick presence check (cached)
// ---------------------------------------------------------------------------

let cliclickPath: string | null | undefined; // undefined = not checked yet

async function ensureCliclick(): Promise<string> {
  if (platform() !== "darwin") {
    throw new Error("Mouse cursor control is only available on macOS (requires cliclick)");
  }
  if (cliclickPath !== undefined) {
    if (cliclickPath === null) {
      throw new Error("cliclick is not installed. Install with: brew install cliclick");
    }
    return cliclickPath;
  }
  return new Promise<string>((resolve, reject) => {
    execFile("which", ["cliclick"], (err, stdout) => {
      const path = stdout?.trim();
      if (err || !path) {
        cliclickPath = null;
        reject(new Error("cliclick is not installed. Install with: brew install cliclick"));
      } else {
        cliclickPath = path;
        resolve(path);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Current cursor position
// ---------------------------------------------------------------------------

async function getCurrentCursorPosition(bin: string): Promise<Point> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["p:."], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        return reject(err);
      }
      // Output is "x,y\n"
      const parts = stdout.trim().split(",");
      if (parts.length !== 2) {
        return reject(new Error(`Unexpected cliclick p:. output: ${stdout}`));
      }
      resolve({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
    });
  });
}

// ---------------------------------------------------------------------------
// Bezier curve path generation
// ---------------------------------------------------------------------------

/** Cubic ease-in-out: smooth acceleration and deceleration. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Evaluate a cubic Bezier at parameter t. */
function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

function distance(a: Point, b: Point): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

/**
 * Generate a human-like mouse movement path using cubic Bezier curves.
 *
 * - Two random control points offset perpendicular to the straight line.
 * - Fitts's Law-based duration.
 * - Ease-in-out timing for natural acceleration/deceleration.
 * - Overshoot + correction for long moves (>300px).
 */
function generatePath(from: Point, to: Point): Point[] {
  const dist = distance(from, to);
  if (dist < 2) {
    return [to];
  }

  // Duration via Fitts's Law, clamped 200–800ms
  const durationMs = Math.min(800, Math.max(200, 200 + 100 * Math.log2(Math.max(1, dist / 50))));
  // Steps targeting ~60fps, clamped 8–60
  const steps = Math.min(60, Math.max(8, Math.round(durationMs / 16)));

  // Perpendicular direction for control point offsets
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const perpX = -dy / len;
  const perpY = dx / len;

  // Spread scales with distance, capped at 150px
  const spread = Math.min(dist * 0.3, 150);

  // Random offsets for 2 control points (asymmetric for natural look)
  const off1 = (Math.random() - 0.5) * 2 * spread;
  const off2 = (Math.random() - 0.5) * 2 * spread;

  const cp1: Point = {
    x: from.x + dx * 0.3 + perpX * off1,
    y: from.y + dy * 0.3 + perpY * off1,
  };
  const cp2: Point = {
    x: from.x + dx * 0.7 + perpX * off2,
    y: from.y + dy * 0.7 + perpY * off2,
  };

  const path: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    const t = easeInOutCubic(rawT);
    const p = cubicBezier(from, cp1, cp2, to, t);
    path.push({ x: Math.round(p.x), y: Math.round(p.y) });
  }

  // Overshoot + correction for long moves (>300px)
  if (dist > 300) {
    const overshootPx = Math.min(12, dist * 0.02);
    const ndx = dx / len;
    const ndy = dy / len;
    const last = path[path.length - 1];
    // Push past target
    path[path.length - 1] = {
      x: Math.round(last.x + ndx * overshootPx),
      y: Math.round(last.y + ndy * overshootPx),
    };
    // Correction step back to exact target
    path.push({ x: Math.round(to.x), y: Math.round(to.y) });
  }

  return path;
}

// ---------------------------------------------------------------------------
// cliclick command building & execution
// ---------------------------------------------------------------------------

/** Build cliclick argument list for a batch of moves (no waits — timing is handled by the caller). */
function buildMoveBatch(points: Point[]): string[] {
  return points.map((p) => `m:${p.x},${p.y}`);
}

function buildFinalAction(point: Point, kind: MouseKind): string[] {
  const coord = `${point.x},${point.y}`;
  switch (kind) {
    case "move":
      return [`m:${coord}`];
    case "click":
      return [`c:${coord}`];
    case "doubleClick":
      return [`dc:${coord}`];
    case "rightClick":
      return [`rc:${coord}`];
  }
}

function runCliclick(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        const combined = [stderr?.trim(), stdout?.trim()].filter(Boolean).join(" | ");
        const errObj = err as Record<string, unknown>;
        const sig = typeof errObj.signal === "string" ? errObj.signal : "";
        const code = typeof errObj.code === "number" ? errObj.code : -1;
        const exitInfo = sig ? `signal=${sig}` : code >= 0 ? `exit=${code}` : "";
        const detail =
          combined || exitInfo || (err instanceof Error ? err.message : "unknown error");
        if (
          detail.includes("accessibility") ||
          detail.includes("permission") ||
          detail.includes("trusted")
        ) {
          reject(
            new Error(
              "cliclick needs Accessibility permissions. Go to System Settings > Privacy & Security > Accessibility and enable the app running OpenClaw (Terminal, iTerm, or node).",
            ),
          );
        } else {
          reject(new Error(`cliclick failed (${exitInfo}): ${detail}`));
        }
      } else {
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Screen coordinate calculation from element ref
// ---------------------------------------------------------------------------

async function getElementScreenCoords(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
}): Promise<Point> {
  const t0 = Date.now();
  const page = await getPageForTargetId(opts);
  const t1 = Date.now();
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const ref = requireRef(opts.ref);
  const locator = refLocator(page, ref);

  let box: { x: number; y: number; width: number; height: number } | null;
  try {
    box = await locator.boundingBox({ timeout: 8000 });
  } catch (err) {
    throw toAIFriendlyError(err, ref);
  }
  const t2 = Date.now();
  if (!box) {
    throw new Error("Element has no bounding box (not visible). Try scrolling into view first.");
  }

  const metrics = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    chromeHeight: window.outerHeight - window.innerHeight,
  }));
  const t3 = Date.now();
  console.log(`[mouse] getPage=${t1 - t0}ms boundingBox=${t2 - t1}ms evaluate=${t3 - t2}ms`);

  return {
    x: Math.round(metrics.screenX + box.x + box.width / 2),
    y: Math.round(metrics.screenY + metrics.chromeHeight + box.y + box.height / 2),
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function mouseViaCliclick(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: MouseKind;
  ref?: string;
  x?: number;
  y?: number;
}): Promise<{ screenX: number; screenY: number; kind: string }> {
  const bin = await ensureCliclick();

  // Resolve target screen coordinates
  let target: Point;
  if (opts.ref) {
    target = await getElementScreenCoords({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ref: opts.ref,
    });
  } else if (typeof opts.x === "number" && typeof opts.y === "number") {
    target = { x: Math.round(opts.x), y: Math.round(opts.y) };
  } else {
    throw new Error("ref or x/y screen coordinates are required");
  }

  // Get current cursor position and generate human-like path
  const current = await getCurrentCursorPosition(bin);
  const path = generatePath(current, target);

  if (path.length > 0) {
    // Execute moves in small batches with Node.js delays between batches.
    // Running everything in one giant cliclick call can hang in LaunchAgent contexts.
    const BATCH_SIZE = 5;
    const DELAY_MS = 16;
    const intermediates = path.slice(0, -1);
    for (let i = 0; i < intermediates.length; i += BATCH_SIZE) {
      const batch = intermediates.slice(i, i + BATCH_SIZE);
      await runCliclick(bin, buildMoveBatch(batch));
      if (i + BATCH_SIZE < intermediates.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
    // Final action (click/move/etc.) at the last point
    const last = path[path.length - 1];
    await runCliclick(bin, buildFinalAction(last, opts.kind));
  }

  return { screenX: target.x, screenY: target.y, kind: opts.kind };
}
