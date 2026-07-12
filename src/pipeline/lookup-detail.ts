import { query } from "../db/connection.js";
import type { DetailResult, HSCodeResult } from "../types.js";

/**
 * Look up 8-digit details from bps_master using the 6-digit hsCodes as LIKE prefixes.
 */
export async function lookupDetails(
  hsCodes: HSCodeResult[]
): Promise<DetailResult[]> {
  if (hsCodes.length === 0) return [];

  const patterns = hsCodes.map((c) => `${c.hscode}%`);
  const conditions = patterns.map((_, i) => `hs_code LIKE $${i + 1}`).join(" OR ");

  const result = await query<DetailResult>(
    `SELECT hs_code, description FROM bps_master WHERE ${conditions} ORDER BY hs_code`,
    patterns
  );

  const scoreMap = new Map(hsCodes.map((c) => [c.hscode, c.score]));

  return result.rows.sort((a, b) => {
    const aPrefix = hsCodes.find((c) => a.hs_code.startsWith(c.hscode))?.hscode || "";
    const bPrefix = hsCodes.find((c) => b.hs_code.startsWith(c.hscode))?.hscode || "";
    const aScore = scoreMap.get(aPrefix) ?? 0;
    const bScore = scoreMap.get(bPrefix) ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    return a.hs_code.localeCompare(b.hs_code);
  });
}
