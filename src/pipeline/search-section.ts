import { query } from "../db/connection.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { SectionResult, EnrichedQuery } from "../types.js";

const embedder = createEmbeddingProvider();

export async function searchSections(enriched: EnrichedQuery): Promise<SectionResult[]> {
  const vector = await embedder.embed(enriched.translated);

  const result = await query<SectionResult>(
    `SELECT section, name, 1 - (embedding <=> $1::vector) AS score
     FROM sections
     ORDER BY embedding <=> $1::vector
     LIMIT 3`,
    [`[${vector.join(",")}]`]
  );

  return result.rows;
}
