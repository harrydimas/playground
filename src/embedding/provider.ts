import { config } from "../config.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

async function ollamaEmbed(input: string): Promise<number[]> {
  const resp = await fetch(`${config.ollamaBaseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.embeddingModel, prompt: input }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Ollama embedding error: ${resp.status} ${err}`);
  }
  const data = await resp.json() as { embedding: number[] };
  return data.embedding;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    return ollamaEmbed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await ollamaEmbed(t));
    }
    return results;
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  return new OllamaEmbeddingProvider();
}
