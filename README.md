# HS Code Classification & Search

Harmonized System (HS) code search engine using vector embeddings and LLM enrichment. Given a product description in natural language, it enriches the query via LLM, searches against harmonized system codes and BPS (Indonesian customs) master data using vector similarity, and returns ranked HS code candidates.

## Architecture

```
User Query → stripNoise() → LLM Enrichment (×2 ensemble) → Vector Search → Aggregation → Ranked Results
```

### Pipeline

1. **`stripNoise()`** — Removes specifications, dimensions, model numbers, standards, fractions
2. **`enrichQuery()`** — Runs LLM enrichment twice in parallel, merges `suggestedCodes` (up to 10 unique 4-digit headings), generates short translated description + synonyms
3. **`searchHSCodes()`** — Searches `harmonized_codes` table (level 6, 6-digit) using vector embeddings
4. **`searchBPS()`** — Searches `bps_master` table (8-digit) using same logic
5. **Aggregation** — Count-weighted ranking with keyword overlap bonus, 4-digit heading boost, and fallback without suggestedCodes filter

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL with pgvector extension
- Ollama (or alternative OpenAI-compatible API)

### Install

```bash
npm install
```

### Configuration

Copy `.env` and adjust:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/hscode
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text-v2-moe
CHAT_MODEL=llama3.2:latest
EMBEDDING_DIM=768
PORT=3000
```

Optional: use alternative LLM provider (OpenAI-compatible):

```env
LLM_ALT_BASE_URL=https://api.example.com
LLM_ALT_API_KEY=sk-xxx
LLM_ALT_MODEL=gpt-4o-mini
```

### Database Migration & Seeding

```bash
# Create tables with vector columns
npx tsx src/db/migrate.ts

# Seed all data (sections + harmonized codes + BPS)
npx tsx src/db/seed.ts

# Seed only specific levels
npx tsx src/db/seed.ts --harmonized 6
npx tsx src/db/seed.ts --harmonized 2,4

# Update embeddings for a specific level
npx tsx src/db/seed.ts --update-level6
```

### Run Server

```bash
npx tsx src/index.ts
```

API endpoints:
- `POST /search` — Basic search (no section classification)
- `POST /search/v2` — Search with section classification
- `GET /health` — Health check

## Search Logic

### Embedding Sources

Each query generates **5 separate embeddings**:
| Source | Weight | Count |
|--------|--------|-------|
| `translated` (core) | ×2 | Appears twice per query |
| `explanation` (core) | ×2 | Appears twice per query |
| `synonym 1` | ×1 | |
| `synonym 2` | ×1 | |
| `synonym 3` | ×1 | |

### Scoring Formula

```
score = count * 1000 - bestRank * 10 + keywordBonus * 5 + headingBoost * 2
```

Where:
- `count` = weighted appearances across all embeddings
- `bestRank` = best rank position (1=best) across all embeddings
- `keywordBonus` = 0-3, words from query matching description
- `headingBoost` = 0-1, 4-digit heading frequency normalized

### Fallback

If results are empty or top score < 1000, automatically retries with `ignoreSuggestedCodes: true` (no 4-digit heading filter).

## Data Sources

- `knowledge/harmonized-system.csv` — HS codes (level 2, 4, 6) with sections
- `knowledge/bps_master_2025_05.csv` — Indonesian BPS 8-digit codes
- `knowledge/example.csv` — Example query → HS code mappings for keyword enrichment
- `knowledge/sections.csv` — HS section names

## Testing

```bash
# Test harmonized codes search (20 queries, top-5 comparison)
npx tsx test_queries.ts

# Test BPS search (5 queries, top-5 comparison)
npx tsx test_bps.ts
```

## Notes

- Embedding model: `nomic-embed-text-v2-moe` (768 dim) produces cleaner vectors than the previous `qwen3-embedding:0.6b`
- Synonyms queries have **no score threshold** (to capture lower-similarity but relevant codes)
- The LLM prompt instructs material-first classification and short translated descriptions (< 20 words)
