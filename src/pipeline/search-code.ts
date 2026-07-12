import { query } from "../db/connection.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { HSCodeResult, EnrichedQuery } from "../types.js";

const embedder = createEmbeddingProvider();

/** Count how many words from the original query appear in the description */
function keywordOverlap(queryWords: Set<string>, description: string): number {
  const descWords = description.toLowerCase().split(/[\s,;.\-()]+/).filter(Boolean);
  return descWords.filter(w => queryWords.has(w)).length;
}

export async function searchHSCodes(enriched: EnrichedQuery, sections: string[], options?: { ignoreSuggestedCodes?: boolean; scoreThreshold?: number }): Promise<HSCodeResult[]> {
  // Build query words for keyword overlap
  const queryWords = new Set(
    (enriched.original + " " + enriched.translated)
      .toLowerCase().split(/[\s,;.\-()/]+/).filter(w => w.length > 2)
  );

  // Generate separate embeddings for translated and explanation (core texts)
  const coreTexts: string[] = [];
  if (enriched.translated) coreTexts.push(enriched.translated);
  if (enriched.explanation) coreTexts.push(enriched.explanation);

  const coreEmbeddings = coreTexts.length > 0
    ? await Promise.all(coreTexts.map(t => embedder.embed(t)))
    : [];

  // Generate separate embeddings for each synonym
  const synonymEmbeddings = enriched.synonyms?.length > 0
    ? await Promise.all(enriched.synonyms.map(t => embedder.embed(t)))
    : [];

  if (coreEmbeddings.length === 0 && synonymEmbeddings.length === 0) return [];

  // Build level-6 query with optional suggestedCodes and section filters
  const codes = options?.ignoreSuggestedCodes ? [] : enriched.suggestedCodes;
  let paramIdx = 2;
  const conditions: string[] = [];
  const baseParams: any[] = [];

  if (codes.length > 0) {
    const codeConditions = codes.map(code => {
      const pattern = `${code}%`;
      baseParams.push(pattern);
      return `hscode LIKE $${paramIdx++}`;
    });
    conditions.push(`(${codeConditions.join(" OR ")})`);
  }

  if (sections.length > 0) {
    const secConditions = sections.map(sec => {
      baseParams.push(sec);
      return `$${paramIdx++}`;
    });
    conditions.push(`section IN (${secConditions.join(", ")})`);
  }

  const scoreThreshold = options?.scoreThreshold ?? 0.5;
  const thresholdParam = `$${paramIdx++}`;

  const extraFilter = conditions.length > 0
    ? `AND ${conditions.join(" AND ")} AND (1 - (embedding <=> $1::vector)) >= ${thresholdParam}`
    : `AND (1 - (embedding <=> $1::vector)) >= ${thresholdParam}`;

  // Synonym filter: same code/section filter but NO score threshold
  const synonymFilter = conditions.length > 0
    ? `AND ${conditions.join(" AND ")}`
    : "";

  // ========== Run core queries (translated + explanation) with weight ×2 ==========
  const allRows: Array<{ hscode: string; description: string; rank: number; weight: number }> = [];

  if (coreEmbeddings.length > 0) {
    const coreLabels = ["translated", "explanation"];
    const coreQueries = coreEmbeddings.map((emb, i) => {
      const vec = `[${emb.join(",")}]`;
      const params = [vec, ...baseParams, scoreThreshold];

      console.log(`[search] core query "${coreLabels[i] || i}" for "${enriched.original}"`);
      return query<HSCodeResult>(
        `SELECT hscode, description, 1 - (embedding <=> $1::vector) AS score
         FROM harmonized_codes
         WHERE level = 6
           ${extraFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT 10`,
        params
      );
    });

    const coreQueryResults = await Promise.all(coreQueries);
    // Log per-embedding results
    coreQueryResults.forEach((qr, i) => {
      const top3 = qr.rows.slice(0, 3).map(r => `${r.hscode}(${r.score.toFixed(3)})`).join(", ");
      console.log(`  [embed] ${coreLabels[i]}: ${top3}`);
    });
    // Flatten core results with weight ×2 (each occurrence counted twice)
    for (const qr of coreQueryResults) {
      qr.rows.forEach((r, rank) => {
        allRows.push({ hscode: r.hscode, description: r.description, rank: rank + 1, weight: 2 });
      });
    }
  }

  // ========== Run synonym queries (weight ×1) ==========
  if (synonymEmbeddings.length > 0) {
    const synQueries = synonymEmbeddings.map((emb, i) => {
      const vec = `[${emb.join(",")}]`;
      // No threshold value in params for synonyms
      const params = [vec, ...baseParams];

      console.log(`[search] synonym query "${enriched.synonyms[i]}" for "${enriched.original}"`);
      return query<HSCodeResult>(
        `SELECT hscode, description, 1 - (embedding <=> $1::vector) AS score
         FROM harmonized_codes
         WHERE level = 6
           ${synonymFilter}
         ORDER BY embedding <=> $1::vector
         LIMIT 10`,
        params
      );
    });

    const synQueryResults = await Promise.all(synQueries);
    synQueryResults.forEach((qr, i) => {
      const top3 = qr.rows.slice(0, 3).map(r => `${r.hscode}(${r.score.toFixed(3)})`).join(", ");
      console.log(`  [embed] synonym "${enriched.synonyms[i]}": ${top3}`);
    });
    for (const qr of synQueryResults) {
      qr.rows.forEach((r, rank) => {
        allRows.push({ hscode: r.hscode, description: r.description, rank: rank + 1, weight: 1 });
      });
    }
  }

  // ========== Aggregate: count (weighted) + best rank + keyword overlap + heading boost ==========
  const aggMap = new Map<string, { description: string; count: number; bestRank: number }>();
  // Track 4-digit heading frequency for boost
  const headingCount = new Map<string, number>();

  for (const r of allRows) {
    // Track heading frequency
    const head4 = r.hscode.substring(0, 4);
    headingCount.set(head4, (headingCount.get(head4) || 0) + r.weight);

    const entry = aggMap.get(r.hscode);
    if (entry) {
      entry.count += r.weight;
      if (r.rank < entry.bestRank) entry.bestRank = r.rank;
    } else {
      aggMap.set(r.hscode, { description: r.description, count: r.weight, bestRank: r.rank });
    }
  }

  // Compute max heading count for normalization
  const maxHeadingCount = Math.max(...headingCount.values(), 1);

  // Sort by weighted score
  const results = Array.from(aggMap.entries())
    .map(([hscode, v]) => {
      // Keyword overlap bonus (0-3)
      const kwBonus = Math.min(keywordOverlap(queryWords, v.description), 3);
      // 4-digit heading boost: how many times this heading appeared across all queries
      const head4 = hscode.substring(0, 4);
      const hBoost = (headingCount.get(head4) || 0) / maxHeadingCount; // 0-1
      // Weighted score: count is primary, rank is secondary, bonuses are tertiary
      const score = v.count * 1000 - v.bestRank * 10 + kwBonus * 5 + hBoost * 2;
      return { hscode, description: v.description, count: v.count, score };
    })
    .sort((a, b) => b.score - a.score || a.hscode.localeCompare(b.hscode));

  // Fallback: if results are empty or top score is low, retry without suggestedCodes filter
  if ((results.length === 0 || (results[0]?.score < 1000)) && enriched.suggestedCodes.length > 0 && !options?.ignoreSuggestedCodes) {
    console.log("Fallback: retrying without suggestedCodes filter...");
    return searchHSCodes(enriched, sections, { ...options, ignoreSuggestedCodes: true });
  }

  if (results.length > 0) {
    console.log(`Found ${results.length} level 6 codes for "${enriched.original}": ${results.slice(0, 5).map(r => `${r.hscode}(${r.count}x)`).join(", ")}`);
  }
  return results;
}
