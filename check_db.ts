import { query, close } from './src/db/connection.js';

async function main() {
  const r = await query('SELECT level, COUNT(*)::int as cnt FROM harmonized_codes GROUP BY level ORDER BY level');
  console.log('levels:', JSON.stringify(r.rows));

  const r2 = await query('SELECT hscode, description, level FROM harmonized_codes WHERE level = 4 LIMIT 3');
  console.log('level 4:', JSON.stringify(r2.rows));

  const r3 = await query('SELECT hscode, description, level FROM harmonized_codes WHERE level = 6 LIMIT 3');
  console.log('level 6:', JSON.stringify(r3.rows));

  const r4 = await query("SELECT hscode FROM harmonized_codes WHERE level = 6 AND hscode LIKE '0101%' LIMIT 5");
  console.log('level 6 like 0101%:', JSON.stringify(r4.rows));

  const r5 = await query("SELECT hscode FROM harmonized_codes WHERE level = 4 AND hscode = '0101'");
  console.log('level 4 exact 0101:', JSON.stringify(r5.rows));

  const r6 = await query('SELECT hscode FROM harmonized_codes WHERE level = 4');
  console.log('all level 4 codes count:', r6.rows.length, 'first 5:', r6.rows.slice(0,5).map(r => r.hscode));

  await close();
}
main();
