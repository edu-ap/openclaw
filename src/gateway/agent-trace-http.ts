import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { type AgentEventPayload, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";

// EDU_ASSIST teacher trace endpoint.
//
// Contract (the elan DualRun harness calls this as EDU_ASSIST_TEACHER_URL):
//
//   POST {EDU_ASSIST_TEACHER_URL}            (e.g. http://host:18789/v1/agent/run)
//   Authorization: Bearer <gateway token>     (same auth as /v1/chat/completions)
//   Content-Type: application/json
//   { "question": "<the prompt>",
//     "sessionKey"?: "<stable key to reuse a session; omit for a fresh run>",
//     "agentId"?: "<agent id; defaults to gateway default agent>",
//     "model"?: "<model ref/alias; informational, routing is config-driven>" }
//
// Response 200:
//   { "runId": string,
//     "answer": string,                       // final assistant text
//     "model": string,                        // echoed model label
//     "sessionKey": string,
//     "trace": AgentEventPayload[] }          // ordered (by seq) reasoning/tool/
//                                             // lifecycle/assistant events for runId
//
// Why a dedicated endpoint rather than /v1/chat/completions: the OpenAI-compat
// route only surfaces the final text (non-stream) or assistant deltas (stream),
// discarding the tool-call and lifecycle events. The DualRun harness needs the
// full {answer, trace} pair in ONE synchronous JSON call (no SSE parsing, no
// fire-and-forget /agent hook that returns only a runId). This handler runs the
// agent, captures every AgentEventPayload emitted for its runId via onAgentEvent,
// and returns answer + trace together. It reuses the same gateway bearer auth,
// rate limiter, and agent machinery as the OpenAI route.

type AgentTraceHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type AgentRunRequest = {
  question?: unknown;
  prompt?: unknown;
  message?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
  model?: unknown;
};

function coerceRequest(val: unknown): AgentRunRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as AgentRunRequest;
}

function resolveQuestion(payload: AgentRunRequest): string {
  // Accept `question` (canonical), or `prompt`/`message` as ergonomic aliases.
  for (const candidate of [payload.question, payload.prompt, payload.message]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function resolveAnswerText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "";
  }
  return payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

export async function handleAgentTraceHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AgentTraceHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/agent/run",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? 1024 * 1024,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const question = resolveQuestion(payload);
  if (!question) {
    sendJson(res, 400, {
      error: {
        message: "Missing `question` (or `prompt`/`message`) in request body.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const agentId = resolveAgentIdForRequest({ req, model });
  // A stable sessionKey reuses one session across runs; omit for an isolated run.
  const requestedSessionKey =
    typeof payload.sessionKey === "string" && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : undefined;
  const sessionKey =
    requestedSessionKey ??
    resolveSessionKey({ req, agentId, user: undefined, prefix: "agent-run" });

  const runId = `agentrun_${randomUUID()}`;
  const deps = createDefaultDeps();

  // Capture every event emitted for THIS runId; this is the reasoning/tool trace.
  const trace: AgentEventPayload[] = [];
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId === runId) {
      trace.push(evt);
    }
  });

  try {
    const result = await agentCommand(
      {
        message: question,
        sessionKey,
        runId,
        deliver: false as const,
        messageChannel: "webchat" as const,
        bestEffortDeliver: false as const,
      },
      defaultRuntime,
      deps,
    );

    const answer = resolveAnswerText(result) || "No response from OpenClaw.";

    // Keep the trace strictly ordered by emission sequence per runId.
    trace.sort((a, b) => a.seq - b.seq);

    sendJson(res, 200, {
      runId,
      answer,
      model,
      sessionKey,
      trace,
    });
  } catch (err) {
    logWarn(`agent-trace: run failed: ${String(err)}`);
    sendJson(res, 500, {
      error: { message: "internal error", type: "api_error" },
      runId,
      trace,
    });
  } finally {
    unsubscribe();
  }

  return true;
}
