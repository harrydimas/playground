import OpenAI from "openai";
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

let _altClient: OpenAI | null = null;
function getAltClient(): OpenAI {
  if (!_altClient) {
    _altClient = new OpenAI({
      apiKey: config.llmAltApiKey,
      baseURL: config.llmAltBaseUrl,
    });
  }
  return _altClient;
}

export class AltEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const client = getAltClient();
    const resp = await client.embeddings.create({
      model: config.llmAltEmbedModel,
      input: text,
    });
    const emb = resp.data?.[0]?.embedding;
    if (!emb || emb.length === 0) {
      throw new Error(
        `Alt embedding returned empty vector for model="${config.llmAltEmbedModel}"`
      );
    }
    return emb;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const client = getAltClient();
    const resp = await client.embeddings.create({
      model: config.llmAltEmbedModel,
      input: texts,
    });
    const byIndex = new Map(resp.data.map(d => [d.index, d.embedding]));
    return texts.map((_, i) => {
      const emb = byIndex.get(i);
      if (!emb || emb.length === 0) {
        throw new Error(
          `Alt embedding returned empty vector at index ${i} for model="${config.llmAltEmbedModel}"`
        );
      }
      return emb;
    });
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  if (config.llmAltEmbedModel) {
    return new AltEmbeddingProvider();
  }
  return new OllamaEmbeddingProvider();
}
