# HS Code Search System — Specification

## Overview

A semantic search engine for Harmonized System (HS) codes that accepts natural-language product descriptions in any language, enriches them with synonyms, and retrieves the most relevant HS codes through a cascading search across three data layers.

## Data Sources

| File | Rows | Content |
|------|------|---------|
| `sections.csv` | 21 | Roman-numeral sections (I–XXI) with broad category names |
| `harmonized-system.csv` | ~6,900 | Hierarchical HS codes (2/4/6 digit) with section, parent, level |
| `HSCode_Master_BPS.csv` | ~11,500 | BPS Indonesia 8-digit codes with descriptions |

## Pipeline

```
User Input (any language)
    │
    ▼
┌──────────────────────────────────────┐
│ 1. Enrich                            │
│    • Parse TYPE;SPECS format:        │
│      core term before ; or :         │
│    • Strip noise (dimensions,        │
│      model numbers, units)           │
│    • LLM: expand abbreviations       │
│      (FLTR→filter, RDCR→reducer,     │
│       LNR→liner, WO→without, ...)    │
│    • LLM: extract CORE product type  │
│    • LLM: list CATEGORIES            │
│    • If specs mention spare/part/     │
│      assembly → inject parts-of-     │
│      <core> synonyms                 │
└──────────┬───────────────────────────┘
           ▼
┌──────────────────────────────────────┐
│ 2. Section Search                    │
│    • Embed enriched query            │
│    • Cosine-similarity on sections   │
│    • Return top 3 sections           │
│      (used as boost ONLY)            │
└──────────┬───────────────────────────┘
           ▼
┌──────────────────────────────────────┐
│ 3. HS Code Search                    │
│    • Search ALL level-6 codes        │
│      globally → top 10               │
│    • Also search within top          │
│      sections → top 5                │
│    • Merge: prefer section-          │
│      filtered, deduplicate           │
│    • Return top 5                    │
└──────────┬───────────────────────────┘
           ▼
┌──────────────────────────────────────┐
│ 4. Detail Lookup                     │
│    • Prefix-match 6-digit codes      │
│      in BPS Master                   │
│    • Return all matching 8-digit     │
│      codes with descriptions         │
└──────────┬───────────────────────────┘
           ▼
      JSON Result
```

## Sample Classification Mapping

| Input Description | HS Code | Core Product | Chapter |
|---|---|---|---|
| `BAG:FLTR;600 X 592 X 592 MM` | 84212990 | bag filter | 8421 filtering machinery |
| `PUMP;SPARE,WO MOT` | 84138113 | pump spare | 8413 liquid pumps |
| `ASSEMBLY;FAN` | 84149029 | fan assembly | 8414 fans |
| `GEARBOX;RDCR,F/ AG-7102` | 84834090 | gearbox reducer | 8483 gears/gearboxes |
| `MOTOR;LV,2.2 KW,100L,4P,SIMOTICS,155F` | 85015229 | electric motor | 8501 motors |
| `PLATE;TAIL LNR M1500,...` (all PLATE; entries) | 84749000 | plate liner (mining equip.) | 8474 mineral processing machinery |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Parse `TYPE;SPECS` format | Industrial catalogs use `MAIN_ITEM;SPECIFICATIONS` — core classification term is before `;` or `:` |
| Expand abbreviations via LLM | `FLTR→filter`, `LNR→liner`, `RDCR→reducer` — embedding space operates on full words |
| Strip dimensions/model numbers | `600 X 592 X 592 MM`, `M1500`, `2.2 KW` add noise to embeddings |
| Section is a **boost**, not a hard filter | Generic terms like "plate" can match wrong section; global search finds correct code |
| Detect spare/assembly → parts-of-X synonyms | "PUMP;SPARE,WO MOT" needs to match pump (8413), not general "parts" |
| Search globally + merge with section-filtered | Ensures correct code isn't dropped by early section misclassification |
| Return **5 HS codes** (not 2) | Industrial queries often have multiple plausible classifications |

## Technology Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js 20+ (TypeScript) |
| Database | PostgreSQL 15+ with pgvector |
| Embeddings | Ollama `qwen3-embedding:0.6b` (1024-dim) |
| Text Generation | Ollama `qwen3:4b` for translation & synonyms |
| CSV Parsing | `csv-parse` |
| DB Driver | `pg` (node-postgres) |

## Database Schema

### `sections`
```sql
CREATE TABLE sections (
    id          SERIAL PRIMARY KEY,
    section     VARCHAR(5) NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    embedding   vector(768)
);
```

### `harmonized_codes`
```sql
CREATE TABLE harmonized_codes (
    id          SERIAL PRIMARY KEY,
    section     VARCHAR(5) NOT NULL,
    hscode      VARCHAR(12) NOT NULL,
    description TEXT NOT NULL,
    parent      VARCHAR(12),
    level       INTEGER,
    embedding   vector(768)
);
```

### `bps_master`
```sql
CREATE TABLE bps_master (
    id          SERIAL PRIMARY KEY,
    hs_code     VARCHAR(12) NOT NULL UNIQUE,
    description TEXT NOT NULL,
    embedding   vector(768)
);
```

## API Design

### `POST /search`
**Request:**
```json
{
  "query": "sapi hidup untuk breeding"
}
```

**Response:**
```json
{
  "original_query": "sapi hidup untuk breeding",
  "enriched_query": {
    "original": "sapi hidup untuk breeding",
    "translated": "live cattle for breeding",
    "synonyms": ["live bovine", "breeding cattle", "livestock"]
  },
  "sections": [
    { "section": "I", "name": "live animals; animal products", "score": 0.92 },
    { "section": "IV", "name": "...", "score": 0.45 },
    { "section": "II", "name": "...", "score": 0.30 }
  ],
  "hs_codes": [
    {
      "hscode": "010221",
      "description": "Cattle; live, pure-bred breeding animals",
      "score": 0.89
    },
    {
      "hscode": "010229",
      "description": "Cattle; live, other than pure-bred breeding animals",
      "score": 0.72
    }
  ],
  "details": [
    {
      "hs_code": "01022100",
      "description": "live cattle, pure-bred breeding animals"
    }
  ]
}
```

## Project Structure

```
src/
├── index.ts                 # Entry point / HTTP server
├── config.ts                # Environment config
├── db/
│   ├── connection.ts        # PostgreSQL connection pool
│   ├── migrate.ts           # Schema creation
│   └── seed.ts              # Load CSVs → generate embeddings → insert
├── pipeline/
│   ├── enrich.ts            # Synonym + translation step
│   ├── search-section.ts    # Section search
│   ├── search-code.ts       # HS code search
│   └── lookup-detail.ts     # BPS master detail
├── embedding/
│   └── provider.ts          # Ollama embedding provider
└── types.ts                 # Shared types
```

## Installation & Usage

```bash
# Prerequisites: PostgreSQL with pgvector, Node.js 20+, Ollama

# Start services
docker compose up -d
ollama serve

# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Initialize DB and seed data
npm run migrate
npm run seed

# Start server
npm run dev

# Query
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{"query": "ASSEMBLY;FAN"}'
```

## Embedding Provider

Default: Ollama `qwen3-embedding:0.6b` (1024 dimensions).  
To swap: implement the `EmbeddingProvider` interface:

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

## Notes

- Translation is only applied when input language is detected as non-English.
- Semicolons in queries are converted to spaces to avoid tokenization issues.
- Synonym expansion includes manual injection of "parts of X" when "assembly" is detected.
- Sections act as a ranking boost, not a hard filter — context-level codes can still appear even if their section has lower similarity.
