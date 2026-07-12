import { enrichQuery } from "./src/pipeline/enrich.js";
import { searchHSCodes } from "./src/pipeline/search-code.js";

const testCases = [
  { query: "SEAL;KT", expected: "848490" },
  { query: "All Export Packaging, Marking and Export", expected: "860400" },
  { query: "VALVE;NON-RETURN", expected: "848180" },
  { query: "CORD:PTCH;CAT 6 LEAD,LG 2.1 M,BLU", expected: "392690" },
  { query: "VALVE;CHRGG", expected: "848180" },
  { query: "28SL-008238-18-V2; Rubber Lined Pipe", expected: "730690" },
  { query: "BEARING;4-BOLT FLG,F4R-S2-207L", expected: "848280" },
  { query: "SWITCH:SLCTR;600 VAC/VDC,1.2 A AC", expected: "853650" },
  { query: "HARNESS:WIRNG;ASSY,SNSR", expected: "854430" },
  { query: "GEAR;BOOM TRNG PLNTY", expected: "848340" },
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

    const hs_codes = await searchHSCodes(enriched, [], { ignoreSuggestedCodes: false });
    console.log(`\nFINAL RESULTS:`);
    hs_codes.slice(0, 5).forEach((r: any, i) => {
      const match6 = r.hscode.slice(0, 6) === expected;
      console.log(`  ${i + 1}. ${r.hscode} (count: ${r.count ?? "?"})${match6 ? " <<< 6-DIGIT MATCH" : ""}`);
    });

    const matchFound = hs_codes.slice(0, 5).some((r: any) => r.hscode.slice(0, 6) === expected);
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
