export type ChunkAccessMeta = {
  access_count: number;
  last_accessed_at: number;
  success_count: number;
  failure_count: number;
};

export type HybridSource = string;

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  chunkMeta?: Map<string, ChunkAccessMeta>;
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
}> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  const now = Date.now();
  const merged = Array.from(byId.values()).map((entry) => {
    const baseScore = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    const meta = params.chunkMeta?.get(entry.id);
    let finalScore = baseScore;
    if (meta) {
      const accessBoost = 1 + 0.05 * Math.min(meta.access_count, 10);
      let recencyFactor = 1.0;
      if (meta.last_accessed_at > 0) {
        const ageDays = (now - meta.last_accessed_at) / (1000 * 60 * 60 * 24);
        if (ageDays >= 7) {
          recencyFactor = Math.max(0.7, 1 - (ageDays - 7) / 180);
        }
      }
      const outcomeBoost =
        meta.success_count > 0 && meta.failure_count === 0
          ? 1.2
          : meta.failure_count >= 3 && meta.success_count === 0
            ? 0.5
            : 1.0;
      finalScore = baseScore * accessBoost * recencyFactor * outcomeBoost;
    }
    return {
      id: entry.id,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: finalScore,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  return merged.toSorted((a, b) => b.score - a.score);
}
