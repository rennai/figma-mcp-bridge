// Reliable node/page resolution for `documentAccess: "dynamic-page"` documents.
//
// Under dynamic-page only the current page is guaranteed loaded. Any other
// node — cross-page nodes and instance sublayers (I-prefixed ids, whose
// resolution needs the main component's data) — is fetched on demand by the
// runtime over a channel that can fail for minutes at a time with "Unable to
// establish connection to Figma after 10 seconds" (unsaved local .fig files
// especially; see upstream issue #63). Loading pages explicitly via
// loadAsync()/loadAllPagesAsync() goes through the document's established
// channel instead, which stays reliable — see the switch_page comment.
//
// Strategy: memory-first fast path with a bounded wait; on failure load pages
// explicitly and match against the in-memory trees. Startup warmup does this
// proactively for small documents.

const CONNECTION_ERROR = /unable to establish connection/i;
const FAST_PATH_TIMEOUT = "fast-path timeout";

const FAST_PATH_TIMEOUT_MS = 1_500; // small docs: fallback is one cheap batched load
const SLOW_PATH_TIMEOUT_MS = 9_000; // large docs: healthy on-demand fetches take 0.6–7s;
// 9s sits just under the runtime's own 10s failure signal
const SCAN_BUDGET_MS = 90_000; // whole fallback budget — stays well under the
// bridge's 180s request timeout so callers get a real error, not a timeout
const WARMUP_BUDGET_MS = 60_000; // bounds the background warmup's per-page loop
const LOAD_RETRY_DELAY_MS = 2_000;
const WARMUP_MAX_PAGES = 50;
const WARMUP_MAX_CURRENT_PAGE_CHILDREN = 1_000;
const WARMUP_RETRY_DELAYS_MS = [5_000, 15_000];
const MAX_TREE_VISITS = 500_000; // paranoia cap for memory sweeps

const isConnectionError = (err: unknown): boolean =>
  CONNECTION_ERROR.test(err instanceof Error ? err.message : String(err));

/**
 * Cheap size proxy for the warmup / strategy guard. Page count is immediate;
 * current-page width is the only per-page size signal available before any
 * load. Both constants are deliberately conservative: a false "large" verdict
 * only skips warmup (the lazy fallback still works), never breaks anything.
 */
const isSmallDocument = (): boolean =>
  figma.root.children.length <= WARMUP_MAX_PAGES &&
  figma.currentPage.children.length <= WARMUP_MAX_CURRENT_PAGE_CHILDREN;

// --- page loading: memoized per page, one retry on channel errors ----------

const pageLoads = new Map<string, Promise<PageNode>>();

/** Load one page through the document's established channel; one retry. */
export const loadPageWithRetry = (page: PageNode): Promise<PageNode> => {
  const memoized = pageLoads.get(page.id);
  if (memoized) return memoized;
  const attempt = async (retriesLeft: number): Promise<PageNode> => {
    try {
      await page.loadAsync(); // loads in place; the resolved value is void
      return page;
    } catch (err) {
      if (retriesLeft > 0 && isConnectionError(err)) {
        await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_DELAY_MS));
        return attempt(retriesLeft - 1);
      }
      pageLoads.delete(page.id); // don't memoize failures — let the next call retry
      throw err;
    }
  };
  const promise = attempt(1);
  pageLoads.set(page.id, promise);
  return promise;
};

// --- whole-document loading: coalesced across concurrent callers ------------

let allPagesPromise: Promise<void> | null = null;

/**
 * Load every page (small documents). Coalesced: a burst of failing queries
 * triggers exactly one load, not one per query. `deadlineAt` bounds the
 * per-page fallback loop — with a fully-dead channel each page costs ~22s
 * (fail, 2s delay, retry-fail), which would otherwise run for many minutes.
 * Pages that miss the deadline stay unloaded; the page scan retries them
 * within its own budget, so a partial resolve is still useful. Rejects only
 * when every attempt failed, and resets its memo in that case so a later
 * call retries.
 */
const ensureAllPagesLoaded = (deadlineAt: number = Infinity): Promise<void> => {
  if (!allPagesPromise) {
    allPagesPromise = (async () => {
      try {
        await figma.loadAllPagesAsync();
        return;
      } catch {
        // Fall back to per-page loads through the established channel.
      }
      let loaded = 0;
      for (const page of figma.root.children) {
        if (Date.now() >= deadlineAt) break;
        try {
          await loadPageWithRetry(page);
          loaded++;
        } catch {
          // This page failed — others may still load.
        }
      }
      if (loaded === 0 && figma.root.children.length > 0) {
        allPagesPromise = null; // total failure — allow a later retry
        throw new Error("Failed to load any page via loadAsync");
      }
    })();
  }
  return allPagesPromise;
};

// --- in-memory matching ------------------------------------------------------

type TreeMatch = { hit: BaseNode | null; truncated: boolean };

/**
 * Depth-first id match over loaded trees. Instance sublayers are walked like
 * any other node: their derived children carry I-prefixed ids in memory, which
 * is exactly what the flaky by-id lookup fails to deliver. `truncated` reports
 * the visit cap being hit, so callers can treat "not found" as inconclusive
 * instead of authoritative.
 */
const findInMemoryTree = (root: BaseNode, id: string): TreeMatch => {
  const stack: BaseNode[] = [root];
  let visits = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return { hit: node, truncated: false };
    if (++visits > MAX_TREE_VISITS) return { hit: null, truncated: true };
    if ("children" in node) {
      for (const child of node.children) stack.push(child);
    }
  }
  return { hit: null, truncated: false };
};

/**
 * Resolve by loading pages one at a time, stopping at the first hit — memory
 * stays bounded by the pages actually visited. The current page is scanned
 * first: it is always loaded, and it is the most common home of the instance
 * sublayers whose by-id lookup triggered this fallback. Already-loaded pages
 * resolve instantly through the loadAsync memo, so only genuinely unloaded
 * pages ahead of the target cost anything.
 *
 * Throws the canonical `Node not found: <id>` when the scan could not be
 * completed (deadline, failed pages, visit caps) — the incident details go to
 * console.warn — so error-message contracts stay byte-identical for callers.
 */
const resolveViaPageScan = async (nodeId: string, deadlineAt: number): Promise<BaseNode | null> => {
  const current = figma.currentPage;
  const pages = [current, ...figma.root.children.filter((page) => page.id !== current.id)];
  const incomplete: string[] = [];
  for (const page of pages) {
    if (Date.now() >= deadlineAt) {
      incomplete.push("<time budget exhausted>");
      break;
    }
    let pageNode: PageNode;
    try {
      pageNode = await loadPageWithRetry(page);
    } catch {
      incomplete.push(page.name);
      continue;
    }
    const { hit, truncated } = findInMemoryTree(pageNode, nodeId);
    if (hit) return hit;
    if (truncated) incomplete.push(`${page.name} (visit cap)`);
  }
  if (incomplete.length > 0) {
    console.warn(
      `[figma-mcp-bridge] page scan for ${nodeId} was incomplete: ` +
        `${incomplete.slice(0, 5).join(", ")}${incomplete.length > 5 ? ", …" : ""}. ` +
        `The node may exist on a page that could not be loaded or fully scanned; ` +
        `retry once the connection recovers.`
    );
    throw new Error(`Node not found: ${nodeId}`);
  }
  return null;
};

// --- the resolver ------------------------------------------------------------

/**
 * Drop-in replacement for figma.getNodeByIdAsync with the same contract
 * (BaseNode | null; null means not found). Differences:
 *  - bounded wait on the on-demand fetch (which can hang for 10s or fail);
 *  - on timeout / connection error: explicit page loading, then in-memory
 *    matching (small docs load everything once, large docs scan hit-and-stop);
 *  - on small docs a fast null is double-checked against memory before being
 *    trusted (cheap once warmed); on large docs null is trusted as documented,
 *    so a typo never triggers a minute-long scan.
 */
export const resolveNodeReliably = async (nodeId: string): Promise<BaseNode | null> => {
  const smallDoc = isSmallDocument();
  let result: BaseNode | null = null;
  let fellBack = false; // fast path unusable (timeout / channel error)
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      figma.getNodeByIdAsync(nodeId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(FAST_PATH_TIMEOUT)),
          smallDoc ? FAST_PATH_TIMEOUT_MS : SLOW_PATH_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err) {
    const timedOut = err instanceof Error && err.message === FAST_PATH_TIMEOUT;
    if (!timedOut && !isConnectionError(err)) throw err;
    fellBack = true;
    console.warn(
      `[figma-mcp-bridge] on-demand lookup failed for ${nodeId}, falling back to explicit page loading`
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (result !== null) return result;
  // Fast path resolved null without an error: the runtime says this id does
  // not exist. Small docs still double-check memory (nearly free once warmed);
  // large docs trust the contract — a typo must not trigger a document-wide
  // scan. A timeout/connection error (fellBack) always scans, because the node
  // may exist behind the unusable channel.
  if (!fellBack && !smallDoc) return null;
  // The whole fallback — batched load + scan — shares one budget so a dead
  // channel fails in ~90s with a real error instead of hitting the bridge's
  // 3-minute request timeout.
  const deadlineAt = Date.now() + SCAN_BUDGET_MS;
  if (smallDoc) await ensureAllPagesLoaded(deadlineAt).catch(() => undefined);
  return resolveViaPageScan(nodeId, deadlineAt);
};

// --- startup warmup -----------------------------------------------------------

/**
 * Proactively load all pages for small documents so the first cross-page
 * query is a memory hit. Fire-and-forget; never blocks message handling.
 * The agent workflow (list_files → get_metadata → … → deep queries) leaves
 * a 30s+ window that comfortably covers the load. Trade-off: every page
 * stays resident for the session (tens of MB on typical kit files) — that is
 * why the size guard skips large documents. The per-page fallback loop is
 * bounded by WARMUP_BUDGET_MS so a dead channel can't leave a zombie loader
 * running for minutes.
 */
export const warmUpInBackground = (): void => {
  if (!isSmallDocument()) return;
  const run = (delayIndex: number): void => {
    ensureAllPagesLoaded(Date.now() + WARMUP_BUDGET_MS).catch(() => {
      const delay = WARMUP_RETRY_DELAYS_MS[delayIndex];
      if (delay !== undefined) setTimeout(() => run(delayIndex + 1), delay);
    });
  };
  run(0);
};
