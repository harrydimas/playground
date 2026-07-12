import { enrichQuery } from "./src/pipeline/enrich.js";
import { searchBPS } from "./src/pipeline/search-bps.js";

// Only first 6 digits are compared (e.g. 848410 for 84841000)
const testCases = [
  { query: "GASKET:FLG;PLTE", expected: "848410" },
  { query: "FIBER:CONCRT REINFMNT;SYNTH,BARCHIP", expected: "391690" },
  { query: "28SL-0145-18-R1; Rubber Lined Pipe", expected: "730690" },
  { query: "HOSE:HYD", expected: "400922" },
  { query: "LANYARD;ASSY,BARR, CNTRL", expected: "843149" },
];

async function main() {
  let passed = 0;
  let failed = 0;

  for (const { query, expected } of testCases) {
    const startTime = Date.now();

    console.log(`\n${"=".repeat(70)}`);
    console.log(`QUERY: "${query}"`);
    console.log(`EXPECTED (6-digit): ${expected}`);
    console.log(`${"=".repeat(70)}`);

    const enriched = await enrichQuery(query);
    console.log(`\nENRICHED:`);
    console.log(`  translated: "${enriched.translated}"`);
    console.log(`  suggestedCodes: ${JSON.stringify(enriched.suggestedCodes)}`);
    console.log(`  synonyms: ${JSON.stringify(enriched.synonyms)}`);

    const results = await searchBPS(enriched);
    console.log(`\nBPS RESULTS:`);
    results.slice(0, 5).forEach((r, i) => {
      const match6 = r.hs_code.slice(0, 6) === expected;
      console.log(`  ${i + 1}. ${r.hs_code} (count: ${r.count}, bestRank: ${r.bestRank})${match6 ? " <<< 6-DIGIT MATCH" : ""}`);
    });

    const matchFound = results.slice(0, 5).some(r => r.hs_code.slice(0, 6) === expected);
    if (matchFound) passed++;
    else failed++;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const icon = matchFound ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${icon} | expected ${expected} | time: ${elapsed}s`);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`SUMMARY: ${passed}/${testCases.length} passed, ${failed} failed`);
  console.log(`${"=".repeat(70)}`);
}

main().catch(console.error);
