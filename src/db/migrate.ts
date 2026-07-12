import { query, close } from "./connection.js";
import { config } from "../config.js";

const dim = config.embeddingDim;

const sql = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sections (
    id          SERIAL PRIMARY KEY,
    section     VARCHAR(5) NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    embedding   vector(${dim})
);

CREATE TABLE IF NOT EXISTS harmonized_codes (
    id          SERIAL PRIMARY KEY,
    section     VARCHAR(5) NOT NULL,
    hscode      VARCHAR(12) NOT NULL,
    description TEXT NOT NULL,
    parent      VARCHAR(12),
    level       INTEGER,
    embedding   vector(${dim})
);

CREATE INDEX IF NOT EXISTS idx_harmonized_section ON harmonized_codes(section);
CREATE INDEX IF NOT EXISTS idx_harmonized_hscode ON harmonized_codes(hscode);

CREATE TABLE IF NOT EXISTS bps_master (
    id          SERIAL PRIMARY KEY,
    hs_code     VARCHAR(12) NOT NULL UNIQUE,
    description TEXT NOT NULL,
    embedding   vector(${dim})
);

CREATE INDEX IF NOT EXISTS idx_bps_hscode ON bps_master(hs_code);

-- HNSW indexes for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_sections_embedding_hnsw ON sections USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_harmonized_embedding_hnsw ON harmonized_codes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_bps_embedding_hnsw ON bps_master USING hnsw (embedding vector_cosine_ops);
`;

async function main() {
  console.log("Running migration...");
  await query(sql);
  console.log("Migration complete.");
  await close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
