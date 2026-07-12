import "dotenv/config";

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/hscode",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  embeddingModel: process.env.EMBEDDING_MODEL || "nomic-embed-text-v2-moe",
  chatModel: process.env.CHAT_MODEL || "llama3.2",
  embeddingDim: parseInt(process.env.EMBEDDING_DIM || "768", 10),
  port: parseInt(process.env.PORT || "3000", 10),
  // Alternative LLM provider (OpenAI-compatible API)
  llmAltBaseUrl: process.env.LLM_ALT_BASE_URL || "",
  llmAltApiKey: process.env.LLM_ALT_API_KEY || "",
  llmAltModel: process.env.LLM_ALT_MODEL || "gpt-4o-mini",
};
