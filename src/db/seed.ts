import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { query, close, getClient } from "./connection.js";
import { createEmbeddingProvider } from "../embedding/provider.js";
import type { SectionRow, HarmonizedRow, BpsRow } from "../types.js";

const embedder = createEmbeddingProvider();

function loadCSV<T>(filePath: string): T[] {
  let content = readFileSync(filePath, "utf-8");
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const normalizedKey = key
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_|_$/g, "");
      if (normalizedKey !== key) {
        row[normalizedKey] = row[key];
        delete row[key];
      }
    }
    if (row.po_item_description && !row.description) row.description = row.po_item_description;
  }
  return rows as T[];
}

async function seedSections() {
  console.log("Seeding sections...");
  const rows = loadCSV<SectionRow>("knowledge/sections.csv");
  const texts = rows.map((r) => r.name);
  const embeddings = await embedder.embedBatch(texts);

  const client = await getClient();
  try {
    await client.query("DELETE FROM sections");
    for (let i = 0; i < rows.length; i++) {
      await client.query(
        "INSERT INTO sections (section, name, embedding) VALUES ($1, $2, $3::vector)",
        [rows[i].section, rows[i].name, `[${embeddings[i].join(",")}]`]
      );
    }
  } finally {
    client.release();
  }
  console.log(`  Inserted ${rows.length} sections.`);
}

async function seedHarmonized(levelFilter?: number | number[]) {
  console.log("Seeding harmonized codes...");
  let rows = loadCSV<HarmonizedRow>("knowledge/harmonized-system.csv");

  // Filter by level(s) if specified
  if (levelFilter !== undefined) {
    const levels = Array.isArray(levelFilter) ? levelFilter : [levelFilter];
    rows = rows.filter((r) => levels.includes(Number(r.level)));
    console.log(`  Filtering to level(s): ${levels.join(", ")}`);
  }
  const exampleMap2 = buildExampleMap(2);
  const exampleMap4 = buildExampleMap(4);
  const exampleMap6 = buildExampleMap(6);

  const texts = rows.map((r) => {
    const level = Number(r.level);
    const map = level === 2 ? exampleMap2 : level === 4 ? exampleMap4 : exampleMap6;
    return buildEnrichedText(r.description, r.hscode, map, level);
  });
  const embeddings = await embedder.embedBatch(texts);

  const client = await getClient();
  try {
    if (levelFilter === undefined) {
      await client.query("DELETE FROM harmonized_codes");
    }
    for (let i = 0; i < rows.length; i++) {
      await client.query(
        "INSERT INTO harmonized_codes (section, hscode, description, parent, level, embedding) VALUES ($1, $2, $3, $4, $5, $6::vector)",
        [rows[i].section, rows[i].hscode, texts[i], rows[i].parent, rows[i].level, `[${embeddings[i].join(",")}]`]
      );
    }
  } finally {
    client.release();
  }
  console.log(`  Inserted ${rows.length} harmonized codes.`);
}

async function seedBps() {
  console.log("Seeding BPS master...");
  const rows = loadCSV<BpsRow>("knowledge/HSCode_Master_BPS.csv");
  const texts = rows.map((r) => r.description);
  const embeddings = await embedder.embedBatch(texts);

  const client = await getClient();
  try {
    await client.query("DELETE FROM bps_master");
    for (let i = 0; i < rows.length; i++) {
      await client.query(
        "INSERT INTO bps_master (hs_code, description, embedding) VALUES ($1, $2, $3::vector)",
        [rows[i].hs_code, rows[i].description, `[${embeddings[i].join(",")}]`]
      );
    }
  } finally {
    client.release();
  }
  console.log(`  Inserted ${rows.length} BPS codes.`);
}

function buildExampleMap(digits: number): Record<string, string[]> {
  const exRows = loadCSV("knowledge/example.csv") as Record<string, string>[];
  const map: Record<string, string[]> = {};
  for (const r of exRows) {
    const hsCode = (r.hs_code || "").trim();
    const desc = (r.description || "").trim();
    if (!hsCode || !desc) continue;
    const prefix = hsCode.slice(0, digits);
    const short = desc.split(";")[0].trim();
    if (short.length < 3) continue;
    if (!map[prefix]) map[prefix] = [];
    if (!map[prefix].includes(short)) map[prefix].push(short);
  }
  return map;
}

function buildEnrichedText(desc: string, hscode: string, exampleMap: Record<string, string[]>, level: number): string {
  const key = hscode.slice(0, level);
  const keywords = exampleMap[key];
  if (keywords && keywords.length > 0) {
    return `Description: ${desc}\nKeywords: ${keywords.join(" | ")}`;
  }
  return desc;
}

async function updateHarmonizedLevel(level: number) {
  console.log(`Updating level ${level} harmonized codes...`);
  const rows = loadCSV<HarmonizedRow>("knowledge/harmonized-system.csv").filter((r) => Number(r.level) === level);
  const exampleMap = buildExampleMap(level);
  const texts = rows.map((r) => buildEnrichedText(r.description, r.hscode, exampleMap, level));

  console.log(`  Embedding ${texts.length} level ${level} descriptions...`);
  const embeddings = await embedder.embedBatch(texts);

  const client = await getClient();
  try {
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const res = await client.query(
        "UPDATE harmonized_codes SET description = $1, embedding = $2::vector WHERE hscode = $3 AND level = $4",
        [texts[i], `[${embeddings[i].join(",")}]`, rows[i].hscode, level]
      );
      if (res.rowCount && res.rowCount > 0) updated++;
    }
    console.log(`  Updated ${updated} / ${rows.length} level ${level} codes.`);
  } finally {
    client.release();
  }
}

async function main() {
  const mode = process.argv[2];
  const levelArg = process.argv[3];

  // Parse level argument (e.g., "2" or "2,4" for multiple levels)
  let level: number | number[] | undefined;
  if (levelArg) {
    level = levelArg.includes(",")
      ? levelArg.split(",").map((l) => Number(l.trim()))
      : Number(levelArg);
  }

  // If mode is a number (not a flag), treat it as a level argument
  if (mode && !mode.startsWith("-")) {
    level = levelArg
      ? [Number(mode), ...levelArg.split(",").map((l) => Number(l.trim()))]
      : Number(mode);
  }

  if (mode === "--update-level2") {
    await updateHarmonizedLevel(2);
  } else if (mode === "--update-level4") {
    await updateHarmonizedLevel(4);
  } else if (mode === "--update-level6") {
    await updateHarmonizedLevel(6);
  } else if (mode === "--harmonized") {
    await seedHarmonized(level);
  } else {
    await seedSections();
    await seedHarmonized(level);
    await seedBps();
  }
  await close();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
