# Feature: Capability Negotiation Protocol

**Parent RFC:** [RFC: Formal Capability Verification for OpenClaw](#)

## Summary

Extend OpenClaw's exec approval pattern to support general capability negotiation. Agents can request expanded capabilities through an auditable, user-approved process with time-bounded grants.

## Motivation

OpenClaw's exec approval system (`docs/tools/exec-approvals.md`) provides a solid pattern:
- Allowlists define permitted commands
- Users can approve requests on-demand
- Approvals can be "allow once" or "always allow"
- Actions are logged

This pattern should generalise to all capabilities, not just command execution. An agent researching a topic might need to:
1. Start with `read: [web, workspace/drafts]`
2. Request `write: [workspace/archive]` to save findings
3. Request `channel.send: [slack:#research]` to share results

Currently, this requires either granting broad capabilities upfront or manual configuration changes. Capability negotiation provides a middle path: baseline capabilities with auditable escalation.

## Current State

The exec approval system is implemented in `src/infra/exec-approvals.ts` with this structure:

```typescript
// From src/infra/exec-approvals.ts
type ExecApprovalsFile = {
  version: 1;
  socket?: { path?: string; token?: string };
  defaults?: {
    security?: "deny" | "allowlist" | "full";
    ask?: "off" | "on-miss" | "always";
    askFallback?: "deny" | "allowlist" | "full";
    autoAllowSkills?: boolean;
  };
  agents?: Record<string, {
    security?: "deny" | "allowlist" | "full";
    ask?: "off" | "on-miss" | "always";
    allowlist?: Array<{
      id?: string;
      pattern: string;
      lastUsedAt?: number;
      lastUsedCommand?: string;
      lastResolvedPath?: string;
    }>;
  }>;
};
```

**Key implementation details:**
- File location: `~/.openclaw/exec-approvals.json`
- Approval manager: `src/gateway/exec-approval-manager.ts` (handles pending requests with 120s timeout)
- RPC handlers: `src/gateway/server-methods/exec-approval.ts`
- Chat forwarding: `src/infra/exec-approval-forwarder.ts`

This is command-focused. We propose extending this pattern to all capability types.

## Proposal

### Generalised Capability Grants

```json
{
  "version": 2,
  "defaults": {
    "security": "baseline",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "main": {
      "baseline": {
        "read": ["web", "workspace/**"],
        "write": ["workspace/output/**"],
        "execute": [],
        "network": ["api.openai.com", "api.anthropic.com"],
        "channel": []
      },
      "grants": [
        {
          "id": "grant-001",
          "capability": "write",
          "resource": "workspace/archive/**",
          "grantedAt": "2026-02-01T12:00:00Z",
          "expiresAt": "2026-02-01T18:00:00Z",
          "reason": "Research task: save findings",
          "approvedBy": "user-interactive"
        }
      ],
      "requestable": {
        "write": ["workspace/archive/**", "workspace/exports/**"],
        "channel.send": ["slack:*", "telegram:*"],
        "execute": ["~/bin/*"]
      }
    }
  }
}
```

### Capability Request Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   CAPABILITY REQUEST FLOW                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Agent     │────▶│   Gateway   │────▶│    User     │
│  requests   │     │   checks    │     │  approves   │
│ capability  │     │  baseline   │     │  or denies  │
└─────────────┘     └──────┬──────┘     └──────┬──────┘
                           │                    │
              ┌────────────┴────────────┐       │
              │                         │       │
       ┌──────▼──────┐           ┌──────▼──────┐│
       │  In baseline │           │ Not in     ││
       │  ALLOW       │           │ baseline   │▼
       └─────────────┘           │ check      │
                                  │ requestable│
                                  └──────┬─────┘
                                         │
                        ┌────────────────┴────────────────┐
                        │                                 │
                 ┌──────▼──────┐                   ┌──────▼──────┐
                 │ Requestable │                   │    Not      │
                 │ prompt user │                   │ requestable │
                 └──────┬──────┘                   │    DENY     │
                        │                          └─────────────┘
           ┌────────────┴────────────┐
           │                         │
    ┌──────▼──────┐           ┌──────▼──────┐
    │   Approve   │           │    Deny     │
    │ add grant   │           │   log       │
    └─────────────┘           └─────────────┘
```

### Request API

Agent requests capability expansion:

```typescript
interface CapabilityRequest {
  capability: string;      // "write", "execute", "network", etc.
  resource: string;        // "workspace/archive/**"
  reason: string;          // Human-readable justification
  duration?: number;       // Requested duration in seconds
  skillContext?: string;   // Which skill triggered this
}

interface CapabilityGrant {
  id: string;
  request: CapabilityRequest;
  grantedAt: Date;
  expiresAt: Date;
  approvedBy: string;      // "user-interactive", "auto-policy", etc.
}
```

### User Approval Interface

**Control UI:**
```
┌────────────────────────────────────────────────────────┐
│ Capability Request                                      │
├────────────────────────────────────────────────────────┤
│ Agent: main                                             │
│ Skill: research-assistant                               │
│                                                         │
│ Requesting: write                                       │
│ Resource:   workspace/archive/**                        │
│ Reason:     Save research findings for later reference  │
│                                                         │
│ ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│ │ Allow Once   │  │ Allow 1 hour │  │ Always Allow   │ │
│ └──────────────┘  └──────────────┘  └────────────────┘ │
│                                                         │
│ ┌──────────────┐                                        │
│ │    Deny      │                                        │
│ └──────────────┘                                        │
└────────────────────────────────────────────────────────┘
```

**Chat channel approval (extending existing `/approve`):**
```
🔐 Capability Request

Agent: main
Skill: research-assistant
Capability: write
Resource: workspace/archive/**
Reason: Save research findings for later reference

Reply:
/capability approve <id> once
/capability approve <id> 1h
/capability approve <id> always
/capability deny <id>
```

### Grant Lifecycle

**Time-bounded grants:**
- All grants have an expiration (default: session end, max: 24 hours)
- Grants auto-expire and are cleaned up
- Long-term grants require explicit "always allow" approval

**Revocation:**
- Users can revoke grants via UI or `/capability revoke <id>`
- Revocation is immediate
- Active operations using the capability are terminated

**Audit trail:**
```json
{
  "timestamp": "2026-02-01T12:00:00Z",
  "event": "capability.granted",
  "agent": "main",
  "capability": "write",
  "resource": "workspace/archive/**",
  "grantId": "grant-001",
  "expiresAt": "2026-02-01T18:00:00Z",
  "approvedBy": "user-interactive"
}
```

### Configuration

```json5
{
  capabilities: {
    negotiation: {
      enabled: true,
      defaultDuration: 3600,        // 1 hour
      maxDuration: 86400,           // 24 hours
      requireReason: true,
      askChannel: "control-ui",     // or "session", "targets"
      autoApprove: {
        // Auto-approve certain patterns without prompting
        patterns: [
          { capability: "read", resource: "web:*.wikipedia.org" }
        ]
      }
    }
  }
}
```

## Implementation

### Phase 1: Data Model

1. Extend `exec-approvals.json` schema to `capability-grants.json`
2. Define capability types and resource patterns
3. Implement grant storage and lifecycle

### Phase 2: Request Flow

1. Capability checking at action dispatch
2. Request generation when capability missing
3. Approval routing (Control UI, chat channels)

### Phase 3: User Interface

1. Control UI capability request panel
2. `/capability` slash command
3. macOS app integration

### Phase 4: Integration

1. Integration with skill capability declarations
2. Integration with sandbox enforcement
3. Audit logging and reporting

## Migration from Exec Approvals

The existing exec approval system becomes a special case:

| Current | New |
|---------|-----|
| `exec-approvals.json` | `capability-grants.json` |
| `allowlist[].pattern` | `grants[].capability: "execute"` |
| `ask: "on-miss"` | Same |
| `/approve <id>` | `/capability approve <id>` |

Backwards compatibility: `exec-approvals.json` is migrated automatically on first load.

## Scope

**In scope:**
- Generalised capability grant model
- Request/approval flow
- Time-bounded grants with expiration
- Revocation
- Audit logging
- Control UI and chat approval interfaces

**Out of scope:**
- Multi-user approval workflows
- Capability delegation between agents
- External approval services (OAuth, etc.)

## Open Questions

1. **Grant inheritance**: Should child processes/skills inherit grants from the parent agent?

2. **Capability composition**: How do multiple grants for the same capability type combine?

3. **Offline approval**: What happens when no approval channel is available?

4. **Grant persistence**: Should grants survive gateway restarts? (Currently: yes, with expiration)

## Acceptance Criteria

- [ ] `capability-grants.json` schema defined and documented
- [ ] Capability request generation at action dispatch
- [ ] Control UI approval panel implemented
- [ ] `/capability` slash command for chat approval
- [ ] Time-bounded grants with automatic expiration
- [ ] Grant revocation via UI and command
- [ ] Audit logging for all grant lifecycle events
- [ ] Migration from `exec-approvals.json`
- [ ] Documentation updated

## References

**OpenClaw Implementation:**
- Exec approvals core: `src/infra/exec-approvals.ts`
- Approval manager: `src/gateway/exec-approval-manager.ts`
- RPC handlers: `src/gateway/server-methods/exec-approval.ts`
- Chat forwarding: `src/infra/exec-approval-forwarder.ts`
- Config types: `src/config/types.approvals.ts`
- Documentation: `docs/tools/exec-approvals.md`

**External:**
- OAuth capability patterns: [RFC 6749](https://tools.ietf.org/html/rfc6749)
