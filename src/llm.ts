import OpenAI from "openai";
import { config } from "./config.js";

async function ollamaChat(prompt: string, system: string): Promise<string> {
  const resp = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.chatModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Ollama chat error: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() || "";
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

async function altChat(prompt: string, system: string): Promise<string> {
  const client = getAltClient();
  const completion = await client.chat.completions.create({
    model: config.llmAltModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  });
  return completion.choices?.[0]?.message?.content?.trim() || "";
}

export async function llmChat(prompt: string, system: string): Promise<string> {
  // If alternative provider is configured, use it
  if (config.llmAltBaseUrl && config.llmAltApiKey) {
    return altChat(prompt, system);
  }
  // Otherwise fall back to local Ollama
  return ollamaChat(prompt, system);
}
