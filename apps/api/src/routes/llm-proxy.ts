import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";
import { db } from "../db.js";

/**
 * LLM Key Proxy
 * 
 * Internal endpoint that sandboxes use to make LLM calls.
 * The platform API key is never exposed to the sandbox.
 * The proxy validates the task, checks rate limits, and forwards to the actual provider.
 */

interface LLMProxyRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | Array<{ type: string; text?: string; tool_calls?: unknown }>;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }>;
  tools?: unknown[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  usage_id?: string;
}

interface ProviderResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: unknown[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function llmProxyRoutes(app: FastifyInstance) {
  // POST /internal/llm-proxy - Sandbox makes LLM call through proxy
  app.post(
    "/internal/llm-proxy",
    async (request, reply) => {
      try {
        // Auth: X-Task-API-Key header (per-task, short-lived)
        const taskApiKey = request.headers["x-task-api-key"] as string;
        if (!taskApiKey) {
          reply.status(401).send({ error: "Missing X-Task-API-Key header" });
          return;
        }

        // Validate task API key and get task info
        const taskSandbox = await db
          .selectFrom("task_sandboxes")
          .select(["task_id", "organization_id", "project_id", "container_name", "session_api_key"])
          .where("session_api_key", "=", taskApiKey)
          .where("status", "=", "READY")
          .executeTakeFirst();

        if (!taskSandbox) {
          reply.status(401).send({ error: "Invalid or expired task API key" });
          return;
        }

        const body = z
          .object({
            model: z.string().min(1),
            messages: z.array(
              z.object({
                role: z.enum(["system", "user", "assistant", "tool"]),
                content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional(), tool_calls: z.unknown().optional() }))]),
                tool_calls: z.array(z.unknown()).optional(),
                tool_call_id: z.string().optional(),
              })
            ),
            tools: z.array(z.unknown()).optional(),
            max_tokens: z.number().int().positive().optional(),
            temperature: z.number().min(0).max(2).optional(),
            stream: z.boolean().optional(),
            usage_id: z.string().optional(),
          })
          .parse(request.body);

        // Get platform API key for the model
        const platformApiKey = getPlatformApiKey(body.model);
        if (!platformApiKey) {
          reply.status(500).send({ error: `No platform API key configured for model: ${body.model}` });
          return;
        }

        // Check rate limits for this task
        const rateLimitOk = await checkRateLimit(taskSandbox.task_id, body.model);
        if (!rateLimitOk) {
          reply.status(429).send({ error: "Rate limit exceeded for this task" });
          return;
        }

        // Forward to actual provider
        const response = await forwardToProvider(platformApiKey, body);

        // Log usage for audit trail
        await logUsage(taskSandbox.task_id, body.model, response.usage);

        reply.send(response);
      } catch (err) {
        if (sendHttpError(reply, err)) return;
        if (err instanceof z.ZodError) {
          reply.status(400).send({ error: err.message });
          return;
        }
        // Don't leak internal errors to sandbox
        console.error("[llm-proxy] Error:", err);
        reply.status(500).send({ error: "LLM proxy error" });
      }
    }
  );

  // GET /internal/llm-proxy/models - List available models (for sandbox discovery)
  app.get(
    "/internal/llm-proxy/models",
    async (request, reply) => {
      try {
        const taskApiKey = request.headers["x-task-api-key"] as string;
        if (!taskApiKey) {
          reply.status(401).send({ error: "Missing X-Task-API-Key header" });
          return;
        }

        const taskSandbox = await db
          .selectFrom("task_sandboxes")
          .select(["task_id"])
          .where("session_api_key", "=", taskApiKey)
          .where("status", "=", "READY")
          .executeTakeFirst();

        if (!taskSandbox) {
          reply.status(401).send({ error: "Invalid or expired task API key" });
          return;
        }

        // Return list of available models (in practice, this would come from provider configs)
        const models = [
          { id: "nvidia_nim/nvidia/nemotron-3-super-120b-a12b", owned_by: "nvidia" },
          { id: "anthropic/claude-sonnet-5", owned_by: "anthropic" },
          { id: "anthropic/claude-haiku-4-5-20251001", owned_by: "anthropic" },
        ];

        reply.send({ object: "list", data: models });
      } catch (err) {
        if (sendHttpError(reply, err)) return;
        reply.status(500).send({ error: "Failed to list models" });
      }
    }
  );
}

function getPlatformApiKey(model: string): string | null {
  // In production, this would come from a secure key management system
  // For now, use environment variables
  if (model.startsWith("nvidia_nim/") || model.startsWith("nvidia/")) {
    return process.env.NVIDIA_NIM_API_KEY ?? null;
  }
  if (model.startsWith("anthropic/")) {
    return process.env.ANTHROPIC_API_KEY ?? null;
  }
  if (model.startsWith("openai/")) {
    return process.env.OPENAI_API_KEY ?? null;
  }
  return null;
}

async function forwardToProvider(apiKey: string, request: LLMProxyRequest): Promise<ProviderResponse> {
  let providerUrl: string;
  let headers: Record<string, string>;

  const model = request.model;

  if (model.startsWith("nvidia_nim/") || model.startsWith("nvidia/")) {
    // NVIDIA NIM / OpenAI-compatible
    providerUrl = process.env.NVIDIA_NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1/chat/completions";
    headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  } else if (model.startsWith("anthropic/")) {
    // Anthropic
    providerUrl = "https://api.anthropic.com/v1/messages";
    headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
    // Convert to Anthropic format
    const anthropicRequest = convertToAnthropic(request);
    const res = await fetch(providerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(anthropicRequest),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }
    const data = await res.json();
    return convertFromAnthropic(data);
  } else if (model.startsWith("openai/")) {
    // OpenAI
    providerUrl = "https://api.openai.com/v1/chat/completions";
    headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  } else {
    throw new Error(`Unsupported model provider: ${model}`);
  }

  // For OpenAI-compatible providers
  if (providerUrl !== "https://api.anthropic.com/v1/messages") {
    const res = await fetch(providerUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.replace(/^(nvidia_nim\/|nvidia\/|openai\/)/, ""), // Strip prefix
        messages: request.messages,
        tools: request.tools,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        stream: request.stream ?? false,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Provider API error: ${res.status} ${text}`);
    }
    const providerResponse = await res.json();
    return providerResponse as ProviderResponse;
  }

  throw new Error("Unexpected provider");
}

function convertToAnthropic(request: LLMProxyRequest): any {
  const systemMessage = request.messages.find(m => m.role === "system");
  const messages = request.messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "assistant" : m.role,
      content: typeof m.content === "string" ? m.content : 
        m.content.map(c => c.type === "text" ? { type: "text", text: c.text } : c).filter(Boolean),
    }));

  return {
    model: request.model.replace("anthropic/", ""),
    system: systemMessage ? (typeof systemMessage.content === "string" ? systemMessage.content : "") : undefined,
    messages,
    max_tokens: request.max_tokens ?? 4096,
    temperature: request.temperature,
    tools: request.tools,
    stream: request.stream,
  };
}

function convertFromAnthropic(response: any): ProviderResponse {
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: response.content?.[0]?.text ?? "",
        tool_calls: response.content?.filter((c: any) => c.type === "tool_use").map((c: any) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })) ?? [],
      },
      finish_reason: response.stop_reason === "end_turn" ? "stop" : response.stop_reason === "tool_use" ? "tool_calls" : "stop",
    }],
    usage: response.usage ? {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    } : undefined,
  };
}

async function checkRateLimit(taskId: string, model: string): Promise<boolean> {
  // Simple rate limiting: max 100 requests per minute per task
  // In production, use Redis or a proper rate limiter
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window
  
  const count = await db
    .selectFrom("llm_usage_log")
    .select((eb) => eb.fn.countAll<string>().as("cnt"))
    .where("task_id", "=", taskId)
    .where("model", "=", model)
    .where("created_at", ">=", new Date(windowStart))
    .executeTakeFirstOrThrow();

  return Number(count.cnt) < 100;
}

async function logUsage(taskId: string, model: string, usage?: ProviderResponse["usage"]): Promise<void> {
  if (!usage) return;
  
  await db
    .insertInto("llm_usage_log")
    .values({
      task_id: taskId,
      model,
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      created_at: new Date(),
    })
    .execute();
}