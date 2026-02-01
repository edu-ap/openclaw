# Feature: Enhanced Sandbox Capability Enforcement

**Parent RFC:** [RFC: Formal Capability Verification for OpenClaw](#)

## Summary

Extend OpenClaw's existing sandbox infrastructure to enforce capability bounds using Linux container security primitives (namespaces, seccomp-bpf, AppArmor/SELinux). This provides enforcement without requiring full formal proofs.

## Motivation

OpenClaw already supports sandboxing via `tools.exec.host=sandbox` and Docker containers. However, the current sandbox provides isolation without capability-specific enforcement. A sandboxed agent can still:

- Make arbitrary network connections (within container network)
- Read/write any file in the container filesystem
- Execute any binary available in the container

Capability enforcement adds granular control: the sandbox restricts actions based on the agent's or skill's declared capabilities, not just container boundaries.

## Current State

OpenClaw's sandbox already has substantial security infrastructure (from `src/agents/sandbox/`):

**Container Security (already implemented in `src/agents/sandbox/docker.ts`):**
- `--cap-drop ALL` drops all Linux capabilities by default
- `--security-opt no-new-privileges` prevents privilege escalation
- `--network none` provides network isolation by default
- Read-only root filesystem with tmpfs for `/tmp`, `/var/tmp`, `/run`
- seccomp and AppArmor profiles are configurable via `docker.seccompProfile` and `docker.apparmorProfile`
- Memory, CPU, and PID limits configurable

**Tool Policy (already implemented in `src/agents/sandbox/tool-policy.ts`):**
- `agents.defaults.sandbox.tools.allow` - allowlist of permitted tools
- `agents.defaults.sandbox.tools.deny` - denylist of blocked tools
- Default allows: `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `image`, `sessions_*`
- Default denies: `browser`, `canvas`, `nodes`, `cron`, `gateway`, channel tools
- Pattern matching with wildcards supported

**Workspace Access (from `src/agents/sandbox/config.ts`):**
- `workspaceAccess: "none"` - isolated sandbox workspace (default)
- `workspaceAccess: "ro"` - agent workspace mounted read-only
- `workspaceAccess: "rw"` - agent workspace mounted read-write

**What's missing:** Resource-level capability bounds. The current tool policy controls *which tools* can be used, but not *what resources* those tools can access. A skill with `write` tool access can write anywhere in the sandbox.

## Proposal

This proposal extends the existing sandbox infrastructure with **resource-level capability bounds**. The current tool policy answers "can this skill use the `write` tool?"; capability enforcement answers "can this skill write to `/workspace/config/`?"

### Extending Tool Policy with Resource Bounds

Build on the existing `sandbox.tools.allow/deny` pattern by adding resource patterns:

```typescript
// Current: tool-level only
tools: {
  allow: ["read", "write", "exec"],
  deny: ["browser", "channel.*"]
}

// Proposed: tool + resource level
tools: {
  allow: ["read", "write", "exec"],
  deny: ["browser", "channel.*"],
  resources: {
    read: ["workspace/**", "web:*.wikipedia.org"],
    write: ["workspace/output/**"],
    exec: ["/usr/bin/python3", "/usr/bin/curl"],
    deny: {
      read: ["workspace/secrets/**"],
      write: ["workspace/config/**"],
      network: ["*", "!api.openai.com"]
    }
  }
}
```

### Capability-Based Container Profiles

Map capability declarations to container security profiles:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        enabled: true,
        docker: {
          image: "openclaw-sandbox:latest",
          capabilities: {
            // Maps to seccomp/AppArmor profiles
            network: ["api.openai.com", "api.anthropic.com"],
            filesystem: ["read:/workspace/**", "write:/workspace/output/**"],
            syscalls: "restricted"  // or "permissive", "minimal"
          }
        }
      }
    }
  }
}
```

### Security Primitives

**Linux Namespaces (already used by Docker):**
- Network namespace for isolation
- Mount namespace for filesystem views
- PID namespace for process isolation

**Seccomp-BPF Profiles:**
```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["read", "write", "open", "close", "stat", "fstat"],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["execve"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {"index": 0, "value": "/usr/bin/python3", "op": "SCMP_CMP_EQ"}
      ]
    }
  ]
}
```

**AppArmor Profiles:**
```
profile openclaw-sandbox flags=(attach_disconnected) {
  # Network
  network inet stream,
  deny network inet dgram,

  # Filesystem
  /workspace/** r,
  /workspace/output/** rw,
  deny /etc/passwd r,
  deny /etc/shadow r,

  # Execution
  /usr/bin/python3 ix,
  deny /bin/sh x,
}
```

### Profile Templates

Provide pre-built profiles for common capability levels:

| Profile | Network | Filesystem | Execution | Use Case |
|---------|---------|------------|-----------|----------|
| `minimal` | None | Read workspace only | Python only | Data analysis |
| `research` | Allow list | Read workspace, write output | Python, curl | Research tasks |
| `development` | Unrestricted | Full workspace | Most binaries | Development |
| `custom` | Per-capability | Per-capability | Per-capability | Custom needs |

### Capability-to-Profile Mapping

When a skill has capability declarations, the sandbox automatically applies corresponding restrictions:

```typescript
function buildSecurityProfile(capabilities: CapabilitySpec): SecurityProfile {
  const seccomp = buildSeccompProfile(capabilities);
  const apparmor = buildApparmorProfile(capabilities);
  const networkPolicy = buildNetworkPolicy(capabilities.network);

  return { seccomp, apparmor, networkPolicy };
}
```

### Audit Logging

All capability-relevant actions logged:

```json
{
  "timestamp": "2026-02-01T13:00:00Z",
  "agent": "main",
  "skill": "research-assistant",
  "action": "network.connect",
  "resource": "api.openai.com:443",
  "declared": true,
  "allowed": true
}
```

Violations (attempts blocked by enforcement):

```json
{
  "timestamp": "2026-02-01T13:01:00Z",
  "agent": "main",
  "skill": "research-assistant",
  "action": "network.connect",
  "resource": "malicious.example.com:443",
  "declared": false,
  "allowed": false,
  "enforcement": "blocked"
}
```

## Implementation

### Phase 1: Profile Infrastructure

1. Create seccomp profile templates
2. Create AppArmor profile templates
3. Add profile selection to sandbox configuration

### Phase 2: Capability Mapping

1. Implement capability-to-profile translation
2. Integrate with skill capability declarations
3. Dynamic profile generation based on active skills

### Phase 3: Runtime Integration

1. Apply profiles when starting sandbox containers
2. Audit logging for capability-relevant actions
3. Violation alerting

### Phase 4: Tooling

1. `openclaw sandbox audit` - Review applied profiles
2. `openclaw sandbox test` - Verify profile enforcement
3. Profile debugging/troubleshooting tools

## Platform Support

| Platform | Seccomp | AppArmor | SELinux | Network Policy |
|----------|---------|----------|---------|----------------|
| Linux | Yes | Ubuntu/Debian | RHEL/Fedora | iptables/nftables |
| macOS | Limited | No | No | pf |
| Windows (WSL2) | Yes | Limited | No | Limited |

Primary target is Linux. macOS and Windows provide reduced capability enforcement.

## Scope

**In scope:**
- Seccomp profile generation from capabilities
- AppArmor profile generation from capabilities
- Network policy enforcement
- Audit logging
- Profile templates

**Out of scope:**
- Full mandatory access control
- Hardware capability enforcement (CHERI)
- Formal proof certificates

## Open Questions

1. **Profile granularity**: How fine-grained should syscall filtering be?

2. **Performance impact**: What's the overhead of seccomp/AppArmor enforcement?

3. **Profile updates**: How do we handle capability changes during a session?

4. **Cross-platform**: What's the minimal enforcement for macOS/Windows?

## Acceptance Criteria

- [ ] Seccomp profile templates for `minimal`, `research`, `development` levels
- [ ] AppArmor profile templates (Ubuntu/Debian)
- [ ] Capability-to-profile mapping implemented
- [ ] Audit logging for sandbox actions
- [ ] `openclaw sandbox audit` command available
- [ ] Documentation updated with sandbox capability enforcement guide
- [ ] Integration tests verifying profile enforcement

## References

**OpenClaw Implementation:**
- Container creation: `src/agents/sandbox/docker.ts` (`buildSandboxCreateArgs()`)
- Tool policy: `src/agents/sandbox/tool-policy.ts` (`isToolAllowed()`)
- Default tool lists: `src/agents/sandbox/constants.ts`
- Config types: `src/config/types.sandbox.ts`
- Documentation: `docs/gateway/sandboxing.md`

**External:**
- Docker seccomp: [Docker security documentation](https://docs.docker.com/engine/security/seccomp/)
- AppArmor: [Ubuntu AppArmor](https://ubuntu.com/server/docs/security-apparmor)
- Canonical LTS Docker Images: [Blog post](https://canonical.com/blog/canonical-publishes-lts-docker-image-portfolio-on-docker-hub)
