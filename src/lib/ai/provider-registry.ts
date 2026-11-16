import "server-only";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ProviderId } from "./providers";

/**
 * Server-side details per provider: how to list models, how to rank them, how to build a model,
 * and the free-tier token budget (prompt + requested max output) where one applies.
 */
export interface ProviderSpec {
  /** GET endpoint returning the models a key can use (OpenAI-style `data[].id` unless Google). */
  modelsUrl: string;
  /** Best-first patterns; the first matches win. */
  preference: RegExp[];
  /** Used when discovery fails. */
  staticModels: string[];
  /** Some free tiers count prompt + max_tokens against a per-request/minute cap. */
  tokenBudget?: number;
  create: (modelId: string, apiKey: string) => LanguageModelV4;
}

const compatible = (name: string, baseURL: string) => (modelId: string, apiKey: string) =>
  createOpenAICompatible({ name, baseURL, apiKey })(modelId) as unknown as LanguageModelV4;

export const REGISTRY: Record<ProviderId, ProviderSpec> = {
  google: {
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    preference: [], // ranked by version in model-catalog (newest Flash first)
    staticModels: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"],
    create: (id, apiKey) => createGoogleGenerativeAI({ apiKey })(id) as unknown as LanguageModelV4,
  },
  groq: {
    modelsUrl: "https://api.groq.com/openai/v1/models",
    preference: [/^openai\/gpt-oss-120b$/, /^openai\/gpt-oss-20b$/, /^qwen\/qwen3[\w.-]*$/, /^moonshotai\/kimi-k2[\w.-]*$/, /^llama-3\.3-70b-versatile$/],
    staticModels: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
    tokenBudget: 7_500,
    create: (id, apiKey) => createGroq({ apiKey })(id) as unknown as LanguageModelV4,
  },
  cerebras: {
    modelsUrl: "https://api.cerebras.ai/v1/models",
    preference: [/^gpt-oss-120b$/, /^qwen-3-235b[\w.-]*instruct[\w.-]*$/, /^qwen-3[\w.-]*$/, /^llama-3\.3-70b$/, /^llama[\w.-]*$/],
    staticModels: ["gpt-oss-120b", "llama-3.3-70b"],
    tokenBudget: 7_800, // ~8K context on the free tier
    create: compatible("cerebras", "https://api.cerebras.ai/v1"),
  },
  mistral: {
    modelsUrl: "https://api.mistral.ai/v1/models",
    preference: [/^mistral-medium-latest$/, /^mistral-small-latest$/, /^mistral-large-latest$/, /^ministral-8b-latest$/],
    staticModels: ["mistral-medium-latest", "mistral-small-latest"],
    create: compatible("mistral", "https://api.mistral.ai/v1"),
  },
  openrouter: {
    modelsUrl: "https://openrouter.ai/api/v1/models",
    // Free variants only (":free" suffix): no credits are ever spent.
    preference: [
      /^openai\/gpt-oss-120b:free$/,
      /^deepseek\/deepseek-(chat|v3)[\w.-]*:free$/,
      /^qwen\/qwen3[\w.-]*:free$/,
      /^meta-llama\/llama-3\.3-70b[\w.-]*:free$/,
      /^google\/gemini[\w.-]*flash[\w.-]*:free$/,
      /:free$/,
    ],
    staticModels: ["openai/gpt-oss-120b:free", "meta-llama/llama-3.3-70b-instruct:free"],
    create: compatible("openrouter", "https://openrouter.ai/api/v1"),
  },
};
