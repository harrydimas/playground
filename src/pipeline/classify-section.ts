import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { fileURLToPath } from "url";
import { llmChat } from "../llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sectionMap = `I (ch1-5): live animals; animal products
II (ch6-14): Vegetable products
III (ch15): Animal or vegetable fats and oils and their cleavage products; prepared edible fats; animal or vegetable waxes
IV (ch16-24): Prepared foodstuffs; beverages, spirits and vinegar; tobacco and manufactured tobacco substitutes
V (ch25-27): Mineral products
VI (ch28-38): Products of the chemical or allied industries
VII (ch39-40): Plastics and articles thereof; rubber and articles thereof
VIII (ch41-43): Raw hides and skins, leather, furskins and articles thereof; saddlery and harness; travel goods, handbags and similar containers; articles of animal gut (other than silk-worm gut)
IX (ch44-46): Wood and articles of wood; wood charcoal; cork and articles of cork; manufactures of straw, of esparto or of other plaiting materials; basketware and wickerwork
X (ch47-49): Pulp of wood or of other fibrous cellulosic material; recovered (waste and scrap) paper or paperboard; paper and paperboard and articles thereof
XI (ch50-63): Textiles and textile articles
XII (ch64-67): Footwear, headgear, umbrellas, sun umbrellas, walking-sticks, seat-sticks, whips, riding-crops and parts thereof; prepared feathers and articles made therewith; artificial flowers; articles of human hair
XIII (ch68-70): Articles of stone, plaster, cement, asbestos, mica or similar materials; ceramic products; glass and glassware
XIV (ch71): Natural or cultured pearls, precious or semi-precious stones, precious metals, metals clad with precious metal and articles thereof; imitation jewellery; coin
XV (ch72-83): Base metals and articles of base metal
XVI (ch84-85): Machinery and mechanical appliances; electrical equipment; parts thereof; sound recorders and reproducers, television image and sound recorders and reproducers, and parts and accessories of such articles
XVII (ch86-89): Vehicles, aircraft, vessels and associated transport equipment
XVIII (ch90-92): Optical, photographic, cinematographic, measuring, checking, precision, medical or surgical instruments and apparatus; clocks and watches; musical instruments; parts and accessories thereof
XIX (ch93): Arms and ammunition; parts and accessories thereof
XX (ch94-96): Miscellaneous manufactured articles
XXI (ch97): Works of art, collectors' pieces and antiques`;

const chapterRanges: [number, number, string][] = [
  [1, 5, "I"], [6, 14, "II"], [15, 15, "III"], [16, 24, "IV"],
  [25, 27, "V"], [28, 38, "VI"], [39, 40, "VII"], [41, 43, "VIII"],
  [44, 46, "IX"], [47, 49, "X"], [50, 63, "XI"], [64, 67, "XII"],
  [68, 70, "XIII"], [71, 71, "XIV"], [72, 83, "XV"], [84, 85, "XVI"],
  [86, 89, "XVII"], [90, 92, "XVIII"], [93, 93, "XIX"], [94, 96, "XX"],
  [97, 97, "XXI"],
];

const chapterToSection: Record<string, string> = {};
for (const [start, end, section] of chapterRanges) {
  for (let ch = start; ch <= end; ch++) {
    chapterToSection[String(ch).padStart(2, "0")] = section;
  }
}

function hsCodeToSection(hsCode: string): string | null {
  const prefix = hsCode.slice(0, 2).padStart(2, "0");
  return chapterToSection[prefix] || null;
}

const sectionHeaderMap: Record<string, string> = {};
for (const line of sectionMap.split("\n")) {
  const match = line.match(/^([IVXLCDM]+)\s+(.+)$/);
  if (match) {
    sectionHeaderMap[match[1]] = match[0];
  }
}

let fewShotExamples = "";

function normalizeRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(row)) {
    const nk = key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "");
    out[nk] = row[key];
  }
  if (out.po_item_description && !out.description) out.description = out.po_item_description;
  return out;
}

function loadKnowledge() {
  try {
    const csvPath = path.resolve(__dirname, "../../knowledge/example.csv");
    const content = fs.readFileSync(csvPath, "utf-8");
    let records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Record<string, string>[];

    records = records.map(normalizeRow);

    const sectionEntries: Record<string, Set<string>> = {};
    for (const row of records) {
      const desc = (row.description || "").trim();
      const hsCode = (row.hs_code || "").trim();
      if (!desc || !hsCode) continue;
      const section = hsCodeToSection(hsCode);
      if (!section) continue;
      if (!sectionEntries[section]) sectionEntries[section] = new Set();
      const short = desc.split(";")[0].trim();
      if (short.length >= 3) sectionEntries[section].add(short);
    }

    const lines: string[] = ["Examples by section:"];
    const sectionOrder = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV","XVI","XVII","XVIII","XIX","XX","XXI"];
    for (const section of sectionOrder) {
      const set = sectionEntries[section];
      if (!set || set.size === 0) continue;
      const examples = Array.from(set).sort().slice(0, 5);
      const header = sectionHeaderMap[section] || section;
      lines.push(`\n${header}:`);
      for (const ex of examples) {
        lines.push(`- ${ex} → ${section}`);
      }
    }
    fewShotExamples = lines.join("\n");
  } catch (err) {
    console.warn("Failed to load knowledge CSV:", err);
  }
}

loadKnowledge();

export async function classifySection(query: string, enrichedQuery: string): Promise<string[]> {
  const system = `You are an HS code classification assistant.

Sections with chapter ranges:
${sectionMap}

${fewShotExamples}

Rules:
- Return only the Roman numerals of the top 3 most relevant sections
- One per line, ordered by relevance
- No explanations, no numbering`;

  const prompt = `Product description: ${query}`;

  const resp = await llmChat(prompt, system);
  const sections = resp
    .split("\n")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[IVXLCDM]+$/.test(s))
    .slice(0, 3);

  return sections;
}
