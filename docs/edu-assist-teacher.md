# EDU_ASSIST teacher contract

This OpenClaw deployment acts as the **teacher** in the elan DualRun
teacher-student harness. The harness sends a question, then compares the
teacher's `{answer, trace}` against the student's. Two pieces wire this up:

1. a **model repoint** so the teacher runs the same model as the verified
   student (apples-to-apples comparison), and
2. a **trace endpoint** so the harness can fetch the final answer plus the
   reasoning/tool trace as structured JSON over HTTP in one call.

## 1. Model repoint (Gemini 3.1 Pro on Vertex EU multi-region)

The verified student runs `gemini-3.1-pro-preview` on Vertex AI's EU
multi-region endpoint. The teacher is aliased to the same provider+model.

- Alias added in `src/config/defaults.ts` (`DEFAULT_MODEL_ALIASES`):
  `edu-assist-teacher` -> `google-vertex/gemini-3.1-pro-preview`.
- Set the default agent model in the gateway config:

  ```jsonc
  {
    "agents": {
      "defaults": {
        // either the alias...
        "model": "edu-assist-teacher",
        // ...or the explicit ref: "google-vertex/gemini-3.1-pro-preview"
      },
    },
  }
  ```

- Vertex routing (project / location / baseUrl) is supplied at runtime via the
  gcloud-ADC environment that the `google-vertex` provider reads (the provider
  authenticates via gcloud Application Default Credentials, see
  `src/agents/model-auth.ts`):

  ```sh
  export GOOGLE_CLOUD_PROJECT=le-product2
  export GOOGLE_CLOUD_LOCATION=eu
  export GOOGLE_VERTEX_BASE_URL=https://aiplatform.googleapis.com
  ```

This change is **additive**: it does not alter any other provider default or
the bare `gemini` alias, so existing deployments are unaffected.

## 2. Trace endpoint: `POST /v1/agent/run`

Enable the endpoint (it shares the OpenAI-compat enable flag):

```jsonc
{ "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }
```

### Why a dedicated endpoint

`POST /v1/chat/completions` only returns the final text (non-stream) or
assistant deltas (stream); it discards tool-call and lifecycle events. The
`POST /hooks/agent` route is fire-and-forget (returns a `runId`, not the
answer). The DualRun harness needs the full `{answer, trace}` pair in one
synchronous JSON call, so this endpoint runs the agent and captures every
`AgentEventPayload` emitted for the run's `runId`
(`src/infra/agent-events.ts`).

### Request

`EDU_ASSIST_TEACHER_URL` is the full URL of this endpoint, e.g.
`http://<gateway-host>:18789/v1/agent/run`.

```http
POST {EDU_ASSIST_TEACHER_URL}
Authorization: Bearer <gateway token>     # same auth as /v1/chat/completions
Content-Type: application/json
```

```jsonc
{
  "question": "<the prompt>", // required (aliases: "prompt", "message")
  "sessionKey": "<key>", // optional; reuse to continue a session,
  //   omit for an isolated fresh run
  "agentId": "<id>", // optional; defaults to the gateway default agent
  "model": "<ref-or-alias>", // optional; informational only — routing is
  //   config-driven (agents.defaults.model)
}
```

### Response `200`

```jsonc
{
  "runId": "agentrun_<uuid>",
  "answer": "<final assistant text>",
  "model": "<echoed model label>",
  "sessionKey": "<resolved session key>",
  "trace": [
    // ordered by seq; each is an AgentEventPayload:
    {
      "runId": "agentrun_<uuid>",
      "seq": 1,
      "stream": "lifecycle", // "lifecycle" | "tool" | "assistant" | "error"
      "ts": 1750000000000,
      "data": { "phase": "start" },
      "sessionKey": "<key>",
    },
    // ...tool calls, assistant deltas, lifecycle end, etc.
  ],
}
```

- `answer` is the concatenated final assistant text (from the agent result
  payloads).
- `trace` is the complete ordered event stream for the run: `tool` events
  carry tool-call inputs/outputs, `assistant` events carry reasoning/text
  deltas, `lifecycle` events bracket the run (`start`/`end`/`error`).

### Errors

- `400` `{ "error": { "message": "Missing `question`...", "type": "invalid_request_error" } }`
  when no question is supplied.
- `500` `{ "error": { "message": "internal error", "type": "api_error" }, "runId", "trace" }`
  on run failure; any partial trace captured so far is included.

### elan side

The elan DualRun harness reads `EDU_ASSIST_TEACHER_URL` from its environment,
POSTs `{ question }` with the bearer token, and consumes `{ answer, trace }`
from the JSON response.
