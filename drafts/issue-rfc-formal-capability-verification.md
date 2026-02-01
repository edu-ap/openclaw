# RFC: Formal Capability Verification for OpenClaw

## Summary

This RFC proposes adding formal capability verification (FCV) as a complementary security layer to OpenClaw's existing runtime controls. The goal is to provide mathematical guarantees about what agents and skills can do, regardless of what they might want to do.

## Motivation

OpenClaw has made significant progress on security fundamentals: exec approvals with allowlists, sandboxing options, DM pairing, and per-agent isolation. These runtime controls are valuable and address real threats.

However, the broader AI agent ecosystem has shown that runtime controls alone face inherent limitations:

1. **Supply chain attacks bypass runtime checks.** A malicious skill that passes initial review can include instructions that exploit the agent's granted capabilities. The attack doesn't require corrupting the agent's values; it simply uses the architecture as designed.

2. **Prompt injection exploits helpfulness.** Hidden instructions in emails, documents, or web pages can trigger unintended actions. The agent isn't misaligned; it's trying to help based on injected context.

3. **Capability accumulation in persistent memory.** Instructions stored in memory can trigger actions later, when context has shifted. Memory that makes agents useful also becomes an attack surface.

4. **Configuration errors expose capabilities.** Even well-designed systems can be misconfigured, exposing capabilities to unintended contexts.

Formal capability verification addresses these limitations by proving mathematical bounds on what code can do, independent of runtime decisions. This complements alignment and runtime controls rather than replacing them.

## Proposal

### Core Concept

Every action an agent takes would be verified against a formally specified capability envelope. Skills would declare their required capabilities in metadata, and a verifier would check that the skill's code stays within those bounds before installation.

This follows patterns established in other domains:
- **seL4** proves integrity and authority confinement for OS kernels
- **CHERI** proves capability monotonicity at the hardware level
- **Effect systems** (Koka, etc.) enforce capability bounds at compile time
- **ARIA Safeguarded AI** separates generation from verification using proof certificates

### What Exists Today vs What Doesn't Exist Yet

Let's be direct about the current state:

**What exists and works in production:**
- seL4's capability proofs run on real hardware in safety-critical systems
- CHERI's hardware capability checks are implemented in working silicon (Arm Morello)
- Linux container primitives (namespaces, seccomp, AppArmor) are battle-tested
- OpenClaw's exec approvals and sandboxing infrastructure is functional

**What exists as research but isn't production-ready:**
- ARIA Safeguarded AI is a funded research programme, not shipped software
- CaMeL is a published paper demonstrating the approach, not a deployable system
- Harmonic Aristotle proves mathematical theorems, not AI agent capability bounds

**What doesn't exist yet:**
- A capability specification language designed specifically for AI agents
- A runtime that enforces formal capability bounds during agent execution
- Integration of formal verification with any existing agent framework
- Machine-checkable proofs that agent skills stay within declared bounds

This RFC proposes building toward the third category incrementally, starting with the deployable primitives from the first category.

### How This Builds on Existing OpenClaw Patterns

OpenClaw already has the conceptual foundations:

| Existing Pattern | Code Location | FCV Extension |
|------------------|---------------|---------------|
| `exec-approvals.json` allowlists | `src/infra/exec-approvals.ts` | Capability declarations verified at install time |
| `SKILL.md` metadata gating (`requires.bins`, `requires.env`, `requires.config`) | `src/agents/skills/config.ts` | Capability requirements with verification |
| `tools.exec.security: allowlist` | `src/config/types.tools.ts` | Formal proof that actions match declared capabilities |
| Sandbox tool allow/deny lists (`sandbox.tools.allow`, `sandbox.tools.deny`) | `src/agents/sandbox/tool-policy.ts` | Resource-level capability bounds (not just tool-level) |
| Sandbox Docker profiles (`--cap-drop ALL`, seccomp, AppArmor) | `src/agents/sandbox/docker.ts` | Capability-based profile selection |
| Per-agent isolation | `src/agents/sandbox/context.ts` | Per-agent capability envelopes |

The goal is to extend these patterns toward formal verification incrementally, not to replace them.

### Proposed Layers

**Layer 1: Capability Declarations (Immediate)**

Extend `SKILL.md` frontmatter to declare required capabilities:

```yaml
---
name: research-assistant
description: Research topics and draft summaries
capabilities:
  - read: [web, workspace/drafts/*]
  - write: [workspace/drafts/*]
  deny:
  - execute: [shell]
  - network: [exfiltrate]
---
```

This is not yet formal verification, but it makes capabilities explicit and auditable. Runtime checks verify actions match declarations.

**Layer 2: Container Capability Enforcement (Near-term)**

Map capability declarations to container security profiles:
- Linux namespaces for isolation
- seccomp-bpf for syscall filtering
- AppArmor/SELinux for mandatory access control

This provides enforcement without requiring full formal proofs. Container escapes exist, but the blast radius is meaningfully reduced.

**Layer 3: Proof Certificates (Future)**

Skills would include machine-checkable proofs that their code stays within declared capabilities. A lightweight verifier checks the proof before installation.

This is the full FCV vision, but it requires significant research and engineering. The earlier layers provide value while this matures.

### Capability Negotiation

Agents could request expanded capabilities through an auditable process:

```
AGENT research_assistant {
  # Baseline capabilities
  READ(web, scientific_databases)
  WRITE(filesystem, /projects/current/drafts/*)

  # Explicitly denied
  DENY(shell.execute)
  DENY(network.exfiltrate)

  # Negotiable expansions
  REQUESTABLE(WRITE, /projects/archive/*)
  REQUESTABLE(SEND, approved_collaborators)
}
```

Requests would be:
- Explicit and specific (not vague "file access")
- Time-bounded and revocable
- Logged and auditable
- Enforced by the architecture, not just by the agent's compliance

This extends OpenClaw's existing exec approval pattern to general capabilities.

## Relationship to External Work

This proposal draws on established research:

- **ARIA Safeguarded AI Programme**: UK government programme combining frontier AI with formal verification
- **Google DeepMind CaMeL**: Addresses prompt injection through architectural constraints
- **Harmonic Aristotle**: Demonstrates AI generating formal proofs that simple verifiers can check
- **Google A2A Protocol**: Agent communication standard that could be extended with capability proofs
- **seL4/CHERI**: Proven capability systems for kernels and hardware

OpenClaw could become a reference implementation for capability-verified AI agents, contributing back to this ecosystem.

## Implementation Path

### Phase 1: Capability Declarations

- Add `capabilities` field to `SKILL.md` frontmatter
- Define capability vocabulary
- Runtime verification that actions match declarations
- Warning/blocking for capability mismatches

**Tracking issue:** [Capability declarations for skills](#)

### Phase 2: Enhanced Sandbox Enforcement

- Extend Docker configuration with capability profiles
- Map declarations to seccomp/AppArmor profiles
- Audit logging of capability usage

**Tracking issue:** [Enhanced sandbox capability enforcement](#)

### Phase 3: Capability Negotiation Protocol

- Extend exec approvals pattern to general capabilities
- Time-bounded, revocable grants
- Audit trail of capability escalations

**Tracking issue:** [Capability negotiation protocol](#)

### Phase 4: ClawdHub Integration (Optional)

- Skills declare capabilities in registry
- Community review signals for high-capability skills
- Verification status badges

**Tracking issue:** [ClawdHub capability verification](#)

## Open Questions

We'd welcome community input on:

1. **Capability vocabulary**: What's the right granularity? Too coarse loses precision; too fine becomes unmanageable.

2. **Backwards compatibility**: How do we handle existing skills without capability declarations?

3. **Performance**: What's the acceptable overhead for capability checking?

4. **User experience**: How do we make capability information useful to users without overwhelming them?

5. **Alternative approaches**: Are there other formal methods approaches that might work better for AI agents?

## Counterarguments and Responses

We anticipate several objections to this proposal:

### "Formal verification is too slow and expensive for practical use"

This is a fair concern. Full formal proofs are computationally expensive. Our response:
- Layers 1 and 2 don't require formal proofs; they use runtime checks and container enforcement
- Layer 3 is explicitly marked as future work, dependent on research progress
- The incremental approach provides value at each stage without waiting for full verification

### "This will kill useful functionality by restricting capabilities too much"

Capability restrictions sound limiting, but:
- Capability negotiation allows agents to request expanded capabilities through auditable channels
- Most tasks don't need unlimited capabilities; a research assistant doesn't need shell access
- Paradoxically, formal bounds enable *more* autonomy: you can trust agents to run unsupervised when you know their limits

### "Prompt injection is a fundamentally unsolved problem; capabilities won't help"

Prompt injection *is* unsolved for preventing the agent from wanting to do harmful things. But capability bounds ensure that even if an agent is manipulated into wanting something harmful, it *cannot execute* actions outside its envelope. The attack surface shifts from "any action the agent can take" to "any action within declared capabilities."

### "The existing security mechanisms are already sufficient"

OpenClaw's current mechanisms are valuable, but they're policy-based, not proof-based. Policies can be misconfigured, overridden, or bypassed. Formal capability bounds provide guarantees that policy controls cannot: mathematical impossibility of certain actions, not just administrative prohibition.

## What This Doesn't Replace

To be clear, formal capability verification is **complementary** to existing approaches:

- **It doesn't replace alignment research.** Anthropic's Constitutional AI, interpretability research, and RLHF are addressing how to make agents *want* good things. That work remains valuable; FCV addresses what agents *can do* regardless of what they want.
- **It doesn't replace interpretability.** Understanding what models are doing internally is valuable for debugging, trust, and improvement. FCV provides external bounds; interpretability provides internal visibility. Both matter.
- **It doesn't replace runtime monitoring.** Observing actual behaviour catches drift and unexpected interactions that static verification might miss.
- **It doesn't replace existing security controls.** Exec approvals, sandboxing, and allowlists remain important first lines of defence.

FCV adds a layer that provides guarantees the other approaches cannot: mathematical bounds on what code can do, regardless of what it wants to do. This is defense in depth.

## Call to Action

We're proposing this RFC to start a conversation. The linked tracking issues provide specific implementation proposals, but we're open to alternative approaches and prioritisation feedback.

If you're interested in:
- **Implementing capability declarations**: See [Capability declarations for skills](#)
- **Strengthening sandbox enforcement**: See [Enhanced sandbox capability enforcement](#)
- **Building capability negotiation**: See [Capability negotiation protocol](#)
- **Discussing the overall approach**: Comment on this RFC

Thank you to the OpenClaw maintainers and community for building a project worth securing.

---

## References

- [ARIA Safeguarded AI Programme](https://www.aria.org.uk/media/3nhijno4/aria-safeguarded-ai-programme-thesis-v1.pdf)
- [seL4 Capability Proofs](https://opensrc.critical.com/data/CTIseL4-2019v5.pdf)
- [CHERI Capability Hardware](https://www.cl.cam.ac.uk/techreports/UCAM-CL-TR-963.pdf)
- [Google A2A Protocol](https://a2a-protocol.org/latest/specification/)
- [Semgrep: Security Like It's 1977](https://semgrep.dev/blog/2026/security-like-its-1977-capabilities-for-the-modern-agentic-web)
