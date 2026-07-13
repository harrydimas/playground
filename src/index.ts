import { createServer, IncomingMessage, ServerResponse } from 'http';
import { config } from './config.js';
import { enrichQuery } from './pipeline/enrich.js';
import { classifySection } from './pipeline/classify-section.js';
import { searchHSCodes } from './pipeline/search-code.js';
import { lookupDetails } from './pipeline/lookup-detail.js';
import { summarizeResults } from './pipeline/summarize.js';
import type { SearchResponse } from './types.js';

async function handleSearch(queryText: string, option: number = 1): Promise<SearchResponse> {
  console.log(`Handling search for query: "${queryText}"`);
  const enriched = await enrichQuery(queryText, option);
  const hs_codes = await searchHSCodes(enriched, []);
  const details = await lookupDetails(hs_codes);
  const topDetails = await summarizeResults(queryText, enriched.translated, hs_codes, details);

  return {
    original_query: queryText,
    enriched_query: enriched,
    sections: [],
    hs_codes,
    details: topDetails,
  };
}

async function handleSearchV2(queryText: string, option: number = 1): Promise<SearchResponse> {
  console.log(`Handling search v2 for query: "${queryText}"`);
  const enriched = await enrichQuery(queryText, option);
  const sections = await classifySection(queryText, enriched.translated);
  const hs_codes = await searchHSCodes(enriched, sections);
  const details = await lookupDetails(hs_codes);
  const topDetails = await summarizeResults(queryText, enriched.translated, hs_codes, details);

  return {
    original_query: queryText,
    enriched_query: enriched,
    sections,
    hs_codes,
    details: topDetails,
  };
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'POST' && req.url === '/search') {
      const body = await parseBody(req);
      const queryText = body.query?.trim();
      if (!queryText) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing 'query' field" }));
        return;
      }
      const result = await handleSearch(queryText);
      res.end(JSON.stringify(result, null, 2));
    } else if (req.method === 'POST' && req.url === '/search/v2') {
      const body = await parseBody(req);
      const queryText = body.query?.trim();
      if (!queryText) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing 'query' field" }));
        return;
      }
      const result = await handleSearchV2(queryText);
      res.end(JSON.stringify(result, null, 2));
    } else if (req.method === 'GET' && req.url === '/hello') {
      res.end(JSON.stringify({ message: 'Hello, World!' }));
    } else if (req.method === 'GET' && req.url === '/health') {
      res.end(
        JSON.stringify({
          status: 'ok',
        })
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(config.port, () => {
  console.log(`HS Code Search API running on http://localhost:${config.port}`);
});
