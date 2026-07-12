import { llmChat } from "../llm.js";
import type { HSCodeResult, DetailResult } from "../types.js";

export async function summarizeResults(
  originalQuery: string,
  enrichedQuery: string,
  hsCodes: HSCodeResult[],
  details: DetailResult[]
): Promise<DetailResult[]> {
  if (details.length <= 5) return details;

  // Build a score map from the 6-digit HS codes to sort details by relevance
  const scoreMap = new Map(hsCodes.map((c) => [c.hscode, c.score]));
  const sortedDetails = [...details].sort((a, b) => {
    const aPrefix = hsCodes.find((c) => a.hs_code.startsWith(c.hscode))?.hscode || "";
    const bPrefix = hsCodes.find((c) => b.hs_code.startsWith(c.hscode))?.hscode || "";
    const aScore = scoreMap.get(aPrefix) ?? 0;
    const bScore = scoreMap.get(bPrefix) ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    return a.hs_code.localeCompare(b.hs_code);
  });

  const codesBlock = hsCodes
    .map((c) => `${c.hscode} (score: ${c.score.toFixed(3)}) — ${c.description}`)
    .join("\n");

  const detailsBlock = sortedDetails
    .map((d) => `${d.hs_code} — ${d.description}`)
    .join("\n");

  const system = `You are an HS code classification assistant. Given a product description, pick the 5 most relevant 8-digit HS codes from the list.

Top matching 6-digit codes (with similarity scores):
${codesBlock}

Available 8-digit details:
${detailsBlock}

Return exactly 5 HS codes, one per line. Only the 8-digit code, nothing else. Order by relevance (most relevant first).`;

  const prompt = `Original product: ${originalQuery}
Enriched description: ${enrichedQuery}

Which 5 eight-digit HS codes are most relevant?`;

  const resp = await llmChat(prompt, system);
  const selected = resp
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^\d{8}$/.test(s))
    .slice(0, 5);

  const detailMap = new Map(details.map((d) => [d.hs_code, d]));
  const result: DetailResult[] = [];
  for (const code of selected) {
    const d = detailMap.get(code);
    if (d) result.push(d);
  }

  // Pad with top-ranked (score-sorted) unmatched if LLM returns fewer than 5 valid codes
  if (result.length < 5) {
    for (const d of sortedDetails) {
      if (!selected.includes(d.hs_code) && result.length < 5) {
        result.push(d);
      }
    }
  }

  return result;
}
