# Feature: Capability Declarations for Skills

**Parent RFC:** [RFC: Formal Capability Verification for OpenClaw](#)

## Summary

Add a `capabilities` field to `SKILL.md` frontmatter that declares what resources and actions a skill requires. This makes capability requirements explicit, auditable, and verifiable at runtime.

## Motivation

Currently, `SKILL.md` supports gating via `metadata.openclaw.requires`, which controls **prerequisites** for loading:

```typescript
// From src/agents/skills/types.ts
requires?: {
  bins?: string[];      // ALL binaries must exist
  anyBins?: string[];   // AT LEAST ONE must exist
  env?: string[];       // ALL env vars must be set
  config?: string[];    // Config paths must be truthy
}
```

This answers "can this skill run?" but not "what will this skill do once running?"

This creates several issues:

1. **Opaque behaviour**: Users can't easily understand what a skill might do without reading the full instructions and any associated scripts.

2. **No runtime verification**: A skill that claims to only "summarise documents" could include instructions that exfiltrate data or execute shell commands.

3. **Trust-based security**: The current guidance is "treat third-party skills as trusted code" (docs/tools/skills.md), which is reasonable but doesn't scale.

Capability declarations address this by making the contract explicit: the skill declares what it needs, and the runtime verifies it stays within bounds.

## Proposal

### Extended SKILL.md Frontmatter

```yaml
---
name: research-assistant
description: Research topics and draft summaries
metadata: {"openclaw":{"requires":{"bins":["curl"],"env":["OPENAI_API_KEY"]}}}
capabilities:
  allow:
    - read: [web]
    - read: [workspace/drafts/**]
    - write: [workspace/drafts/**]
  deny:
    - execute: [shell, *]
    - write: [workspace/config/**]
    - network: [*, !api.openai.com, !*.wikipedia.org]
---
```

### Capability Vocabulary

| Capability | Scope | Description |
|------------|-------|-------------|
| `read` | resource pattern | Read access to files, web, APIs |
| `write` | resource pattern | Write access to files |
| `execute` | command pattern | Execute shell commands or binaries |
| `network` | endpoint pattern | Network access (outbound) |
| `memory` | scope | Access to persistent memory |
| `channel` | channel pattern | Send messages to channels |
| `tool` | tool pattern | Invoke specific tools |

Patterns support globs (`*`, `**`) and negation (`!pattern`).

### Runtime Verification

When a skill triggers an action, the runtime checks:

1. Does the action match an `allow` pattern?
2. Does the action match a `deny` pattern?
3. If neither, what's the default policy?

```typescript
interface CapabilityCheck {
  action: string;           // e.g., "write"
  resource: string;         // e.g., "workspace/drafts/summary.md"
  skillName: string;
  declared: CapabilitySpec;
  result: 'allowed' | 'denied' | 'undeclared';
  reason?: string;
}
```

### Enforcement Modes

Configuration in `openclaw.json`:

```json5
{
  skills: {
    capabilities: {
      enforcement: "warn" | "block" | "off",
      undeclaredDefault: "allow" | "deny",
      logViolations: true
    }
  }
}
```

- **off**: No capability checking (current behaviour)
- **warn**: Log violations but allow actions (migration path)
- **block**: Deny actions that violate declared capabilities

### Backwards Compatibility

Skills without `capabilities` declarations continue to work:
- In `enforcement: "off"` or `enforcement: "warn"` mode, they run unrestricted
- In `enforcement: "block"` mode with `undeclaredDefault: "allow"`, they run unrestricted
- In `enforcement: "block"` mode with `undeclaredDefault: "deny"`, they require declarations

This allows gradual adoption: start with `warn` to audit existing skills, then move to `block` as declarations are added.

## Implementation

### Phase 1: Schema and Parsing

1. Extend `SKILL.md` parser to recognise `capabilities` field
2. Define TypeScript types for capability specifications
3. Validate capability declarations at skill load time

### Phase 2: Runtime Checking

1. Add capability checking hooks to tool dispatch
2. Implement pattern matching for resources
3. Add enforcement mode configuration

### Phase 3: Tooling

1. `openclaw skills audit` - Report capability usage vs declarations
2. `openclaw skills generate-capabilities` - Suggest declarations based on observed usage
3. macOS app Skills UI - Display capability requirements

### Phase 4: Documentation

1. Update `docs/tools/skills.md` with capability declaration guide
2. Add capability vocabulary reference
3. Provide example skills with declarations

## Scope

**In scope:**
- Capability declaration schema
- Runtime verification for declared capabilities
- Enforcement modes and configuration
- Audit tooling

**Out of scope (future work):**
- Formal proofs that code matches declarations
- ClawdHub integration
- Container enforcement (separate issue)

## Open Questions

1. **Capability inheritance**: Should skills inherit capabilities from the agent's baseline?

2. **Dynamic capabilities**: How do we handle skills that need different capabilities based on user input?

3. **Capability composition**: When multiple skills are active, how do their capabilities interact?

4. **Performance**: What's the overhead of checking every action against capability declarations?

## Acceptance Criteria

- [ ] `capabilities` field parsed from `SKILL.md` frontmatter
- [ ] Capability vocabulary documented
- [ ] Runtime checking implemented for enforcement modes
- [ ] `openclaw skills audit` command available
- [ ] Existing skills continue to work in `enforcement: "warn"` mode
- [ ] At least 3 bundled skills updated with capability declarations as examples

## References

**OpenClaw Implementation:**
- Skill types: `src/agents/skills/types.ts` (OpenClawSkillMetadata)
- Skill frontmatter parsing: `src/agents/skills/frontmatter.ts`
- Eligibility checking: `src/agents/skills/config.ts` (shouldIncludeSkill)
- Skill loading: `src/agents/skills/workspace.ts`
- Documentation: `docs/tools/skills.md`

**Patterns to Follow:**
- Exec approvals pattern: `src/infra/exec-approvals.ts`, `docs/tools/exec-approvals.md`
- Sandbox tool policy: `src/agents/sandbox/tool-policy.ts`

**External:**
- Effect systems for capability typing: [Koka](https://koka-lang.github.io/koka/doc/index.html)
