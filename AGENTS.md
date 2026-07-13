# AGENTS.md — HS Code Classification & Search

## Project

HS code search engine. Natural language product description → vector search against harmonized system codes + BPS Indonesian customs data → ranked HS code candidates.

## Pipeline

```
Query → stripNoise() → LLM Enrichment (×2 ensemble) → Vector Search → Aggregation → Ranked Results
```

Key steps in `src/pipeline/`:
1. `stripNoise()` — strip specs, dimensions, model numbers, standards, fractions
2. `enrichQuery()` — 2 parallel LLM calls, merge up to 10 unique 4-digit `suggestedCodes`, produce `translated` + `explanation` + `synonyms`
3. `searchHSCodes()` — vector search on `harmonized_codes` (level 6)
4. `searchBPS()` — vector search on `bps_master` (8-digit)
5. Score: `count*1000 - bestRank*10 + keywordBonus*5 + headingBoost*2`

## Src Layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | Express server (`POST /search`, `POST /search/v2`, `GET /health`) |
| `src/pipeline/` | Search pipeline: enrich, embed, search, aggregate |
| `src/embedding/` | Embedding generation (Ollama or alt provider) |
| `src/llm.ts` | LLM chat completion (Ollama or alt provider) |
| `src/db/` | DB queries (`query.ts`), migration (`migrate.ts`), seed (`seed.ts`) |
| `src/config.ts` | Env-based config |
| `src/types.ts` | Shared TS interfaces |

## Data Files (knowledge/)

- `knowledge/harmonized-system.csv` — HS codes level 2/4/6 with sections
- `knowledge/bps_master_2025_05.csv` — Indonesian BPS 8-digit codes
- `knowledge/example.csv` — Query→HS code mappings
- `knowledge/sections.csv` — HS section names

## Embeddings

5 per query: `translated`×2, `explanation`×2, `synonym1`, `synonym2`, `synonym3`. Synonyms query has no score threshold (catches low-similarity but relevant codes). Model: `nomic-embed-text-v2-moe` (768 dim).

## Conventions

- TypeScript, ESM (`"type": "module"` in package.json)
- Use `tsx` for running TS scripts (`npx tsx src/...`)
- No explicit lint/typecheck config (tsconfig.json exists)
- Prefer `pg` raw SQL with vector similarity (`<=>` operator, pgvector)
- LLM prompt: material-first classification, short translated descriptions (<20 words)
- Fallback: if results empty or top score <1000, retry with `ignoreSuggestedCodes: true`

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | `tsx watch src/index.ts` |
| `npm run build` | `tsc` |
| `npm run seed` | Full DB seed |
| `npm run seed -- --harmonized` | Seed only harmonized codes |
| `npm run migrate` | Create DB tables with vector columns |
| `npm run test-harmonized` | `tsx test_queries.ts` (20 queries, top-5) |
| `npm run test-bps` | `tsx test_bps.ts` (5 queries, top-5) |
| `npm run update-level<N>` | Update embeddings for specific level |

## Env

See `.env.example`. Required: `DATABASE_URL`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `CHAT_MODEL`, `EMBEDDING_DIM`. Optional alt provider (`LLM_ALT_*`) overrides Ollama.

## DB

PostgreSQL + pgvector. Tables: `sections`, `harmonized_codes` (vector col `embedding`), `bps_master` (vector col `embedding`).
