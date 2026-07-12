import { query } from "../db/connection.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { EnrichedQuery } from "../types.js";

const embedder = createEmbeddingProvider();

export interface BPSResult {
  hs_code: string;
  description: string;
  count: number;
  bestRank: number;
  score: number;
}

/** Count how many words from the original query appear in the description */
function keywordOverlap(queryWords: Set<string>, description: string): number {
  const descWords = description.toLowerCase().split(/[\s,;.\-()]+/).filter(Boolean);
  return descWords.filter(w => queryWords.has(w)).length;
}

export async function searchBPS(enriched: EnrichedQuery, options?: { ignoreSuggestedCodes?: boolean; scoreThreshold?: number }): Promise<BPSResult[]> {
  // Build query words for keyword overlap
  const queryWords = new Set(
    (enriched.original + " " + enriched.translated)
      .toLowerCase().split(/[\s,;.\-()/]+/).filter(w => w.length > 2)
  );

  // Build separate text sources
  const texts: string[] = [];
  if (enriched.translated) texts.push(enriched.translated);
  if (enriched.explanation) texts.push(enriched.explanation);
  if (enriched.synonyms) texts.push(...enriched.synonyms);

  if (texts.length === 0) return [];

  // Generate embeddings in parallel
  const embeddings = await Promise.all(texts.map(t => embedder.embed(t)));

  const scoreThreshold = options?.scoreThreshold ?? 0.5;

  // Build filter for suggestedCodes on first 4 digits of hs_code
  const codes = options?.ignoreSuggestedCodes ? [] : enriched.suggestedCodes;
  let paramIdx = 2;
  const conditions: string[] = [];
  const baseParams: any[] = [];

  if (codes.length > 0) {
    const codeConditions = codes.map(code => {
      const pattern = `${code}%`;
      baseParams.push(pattern);
      return `hs_code LIKE $${paramIdx++}`;
    });
    conditions.push(`(${codeConditions.join(" OR ")})`);
  }

  const extraFilter = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const thresholdParam = paramIdx;

  // Separate core queries (with threshold) and synonym queries (no threshold)
  const coreCount = Math.min(2, embeddings.length);

  // Core queries (first 2: translated + explanation) with score threshold
  const coreQueries = embeddings.slice(0, coreCount).map(emb => {
    const vec = `[${emb.join(",")}]`;
    const params = [vec, ...baseParams, scoreThreshold];
    return query<{ hs_code: string; description: string; score: number }>(
      `SELECT hs_code, description, 1 - (embedding <=> $1::vector) AS score
       FROM bps_master
       WHERE (1 - (embedding <=> $1::vector)) >= $${thresholdParam}
         ${extraFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT 10`,
      params
    );
  });

  // Synonym queries (rest) — NO score threshold
  const synQueries = embeddings.slice(coreCount).map(emb => {
    const vec = `[${emb.join(",")}]`;
    const params = [vec, ...baseParams];
    return query<{ hs_code: string; description: string; score: number }>(
      `SELECT hs_code, description, 1 - (embedding <=> $1::vector) AS score
       FROM bps_master
       WHERE 1=1
         ${extraFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT 10`,
      params
    );
  });

  // Run all queries in parallel, maintain order
  const allQueryResults = await Promise.all([...coreQueries, ...synQueries]);

  // Log per-embedding results
  const labels = ["translated", "explanation", ...(enriched.synonyms || []).map(s => `synonym "${s}"`)];
  allQueryResults.forEach((qr, i) => {
    const top3 = qr.rows.slice(0, 3).map(r => `${r.hs_code}(${r.score.toFixed(3)})`).join(", ");
    console.log(`  [bps] ${labels[i]}: ${top3}`);
  });

  // Flatten with weight: core (index 0,1) get ×2, synonyms get ×1
  const allRows: Array<{ hs_code: string; description: string; rank: number; weight: number }> = [];
  allQueryResults.forEach((qr, embedIdx) => {
    const weight = embedIdx < 2 ? 2 : 1; // translated/explanation = core
    qr.rows.forEach((r, rank) => {
      allRows.push({ hs_code: r.hs_code, description: r.description, rank: rank + 1, weight });
    });
  });

  // Aggregate: count (weighted) + best rank + keyword overlap + heading boost
  const aggMap = new Map<string, { description: string; count: number; bestRank: number }>();
  const headingCount = new Map<string, number>();

  for (const r of allRows) {
    const head4 = r.hs_code.substring(0, 4);
    headingCount.set(head4, (headingCount.get(head4) || 0) + r.weight);

    const entry = aggMap.get(r.hs_code);
    if (entry) {
      entry.count += r.weight;
      if (r.rank < entry.bestRank) entry.bestRank = r.rank;
    } else {
      aggMap.set(r.hs_code, { description: r.description, count: r.weight, bestRank: r.rank });
    }
  }

  const maxHeadingCount = Math.max(...headingCount.values(), 1);

  // Sort by weighted score
  const results = Array.from(aggMap.entries())
    .map(([hs_code, v]) => {
      const kwBonus = Math.min(keywordOverlap(queryWords, v.description), 3);
      const head4 = hs_code.substring(0, 4);
      const hBoost = (headingCount.get(head4) || 0) / maxHeadingCount;
      const score = v.count * 1000 - v.bestRank * 10 + kwBonus * 5 + hBoost * 2;
      return { hs_code, description: v.description, count: v.count, bestRank: v.bestRank, score };
    })
    .sort((a, b) => b.score - a.score || a.hs_code.localeCompare(b.hs_code));

  // Fallback: if results are empty or top score is low, retry without suggestedCodes filter
  if ((results.length === 0 || results[0]?.score < 1000) && codes.length > 0 && !options?.ignoreSuggestedCodes) {
    console.log("[bps] Fallback: retrying without suggestedCodes filter...");
    return searchBPS(enriched, { ...options, ignoreSuggestedCodes: true });
  }

  if (results.length > 0) {
    console.log(`[bps] Found ${results.length} codes for "${enriched.original}": ${results.slice(0, 5).map(r => `${r.hs_code}(${r.count}x)`).join(", ")}`);
  }
  return results;
}
