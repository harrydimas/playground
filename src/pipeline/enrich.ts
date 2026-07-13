import { llmChat } from '../llm.js';
import type { EnrichedQuery } from '../types.js';

export function stripNoise(text: string): string {
  return text
    .replace(/\d+\s*[xX×]\s*\d+(\s*[xX×]\s*\d+)?\s*(MM|CM|M|IN)?/gi, '')
    .replace(/\b\d+(\.\d+)?\s*(KW|HP|W|MM|CM|M|KG|G|L|ML|V|A|HZ|RPM|KV|KVA|BAR|PSI|IN)\b/gi, '')
    .replace(/\b\d+(\.\d+)?\s*(OD|ID|THK|DIA|LG|OAH|MAX|MIN)\b/gi, '')
    .replace(/\b[A-Z]+\d+[-]?\d*[A-Z0-9]*[-]?\d*[A-Z0-9]*\b/g, '')
    .replace(/\b[A-Z]{2,6}\s+\d+[A-Z0-9-]+/g, '')
    .replace(/\b\d+\s*\/\s*\d+("|IN)?/g, '')
    .replace(/\b\d+(\.\d+)?\s*(IN|MM|CM|M|FT|KG|LB)\b/gi, '')
    .replace(/[;:,\/()]/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const hsKnowledgeBase = `You are a master of the Harmonized System (HS) tariff classification. You have deep knowledge of:

- All 21 sections and 99 chapters of the HS
- The General Rules of Interpretation (GIRs)
- Chapter notes, section notes, and legal notes
- How products are classified based on their composition, function, and intended use

Sections overview:
I (ch1-5): Live animals; animal products
II (ch6-14): Vegetable products
III (ch15): Animal or vegetable fats and oils
IV (ch16-24): Prepared foodstuffs; beverages; tobacco
V (ch25-27): Mineral products
VI (ch28-38): Chemicals and allied industries
VII (ch39-40): Plastics and rubber
VIII (ch41-43): Raw hides, leather, travel goods
IX (ch44-46): Wood, cork, basketware
X (ch47-49): Pulp, paper, paperboard
XI (ch50-63): Textiles and textile articles
XII (ch64-67): Footwear, headgear, umbrellas
XIII (ch68-70): Stone, plaster, ceramics, glass
XIV (ch71): Pearls, precious stones, metals, jewellery
XV (ch72-83): Base metals
XVI (ch84-85): Machinery, mechanical appliances, electrical equipment
XVII (ch86-89): Vehicles, aircraft, vessels
XVIII (ch90-92): Optical, medical, precision instruments; clocks; musical instruments
XIX (ch93): Arms and ammunition
XX (ch94-96): Miscellaneous manufactured articles
XXI (ch97): Works of art, collectors' pieces, antiques`;

const enrichPrompt = `${hsKnowledgeBase}

Given a product description, do the following IN ORDER. Return ONLY valid JSON — no extra text, no explanation outside the JSON.

First, strip any product specifications (dimensions, weights, power ratings, voltages, capacities, model numbers, technical parameters like KW, HP, MM, KG, RPM, etc.) from the description — focus on the core product identity.

1. Detect language. If NOT English, translate to English. If already English, keep as-is.
2. Identify the PRIMARY MATERIAL the product is made of (metal, rubber, plastic, textile, glass, paper, etc.). Then analyze what the product is, its composition, function, and how it's used — this will guide classification.
3. Based on your HS knowledge, suggest the top 5 most likely HS heading numbers (4-digit codes like "8414", "8474", "8433", "8501", "7318") that could classify this product. When uncertain about the exact machinery or application, prefer broader categories (e.g., 'parts of machinery' over specific machine types) and material-based headings.
4. Generate up to 3 synonyms or alternative search terms for this product — other names, related products, or broader terms that could help find this product in an HS code database.

IMPORTANT: Focus on identifying the MATERIAL first (metal, plastic, rubber, textile, etc.) and the CORE FUNCTION (fastening, sealing, filtering, conducting, etc.). Do not over-interpret vague descriptions as specific machinery.

Output format (exactly, as a JSON object):
{
  "translated": "<Short English translation with specs removed, then a dash and a brief 2-5 word product category, e.g. 'bag filter - filtration equipment' or 'electric motor - electrical machinery' or 'plain washer - steel fasteners'> Keep translated under 20 words total.",
  "explanation": "<HS master analysis: what the product is, its composition, function, and why it falls under certain chapters>",
  "suggestedCodes": ["<4-digit heading>", "<4-digit heading>", "<4-digit heading>", "<4-digit heading>", "<4-digit heading>"],
  "synonyms": ["<synonym1>", "<synonym2>", "<synonym3>"]
}`;

function parseEnrichResponse(resp: string) {
  try {
    const json = resp.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    return JSON.parse(json) as Record<string, any>;
  } catch {
    return {};
  }
}

export async function enrichQuery(query: string, option: number = 1): Promise<EnrichedQuery> {
  const cleaned = stripNoise(query);

  // Run enrichment N times in parallel and merge unique codes
  const runs = Math.max(option, 1);
  console.log(`Running ${runs}x enrichment`);
  const responses = await Promise.all(
    Array.from({ length: runs }, () => llmChat(cleaned, enrichPrompt))
  );

  let translated = cleaned;
  let explanation = '';
  let suggestedCodes: string[] = [];
  let synonyms: string[] = [];

  for (const resp of responses) {
    console.log(`Enrichment run response:`, resp);
    const p = parseEnrichResponse(resp);

    // Use first valid response for translated/explanation
    if (!translated && p.translated) translated = String(p.translated).trim();
    if (!explanation && p.explanation) explanation = String(p.explanation).trim();

    // Collect unique suggestedCodes from all runs
    if (Array.isArray(p.suggestedCodes)) {
      const codes = p.suggestedCodes
        .map((s: any) => String(s).trim())
        .filter((s: string) => /^\d{4}$/.test(s));
      for (const c of codes) {
        if (!suggestedCodes.includes(c)) suggestedCodes.push(c);
      }
    }

    // Collect unique synonyms from all runs
    if (Array.isArray(p.synonyms)) {
      const syn = p.synonyms.map((s: any) => String(s).trim()).filter(Boolean);
      for (const s of syn) {
        if (!synonyms.includes(s)) synonyms.push(s);
      }
    }
  }

  return { original: query, translated, explanation, suggestedCodes, synonyms };
}
