# Workflow reference

Workflows are declarative, deterministic pipelines of tool calls, run by
`@mcp-orchestrator/workflow`. This page is the complete reference for the
definition format, the expression language and runtime semantics.

## Definition

```ts
engine.define({
  id: "release-notes",              // required, unique
  description: "optional text",
  inputs: {
    tag:   { required: true, description: "git tag" },
    limit: { default: 20 },
  },
  steps: [                          // required, at least one
    {
      id: "fetch",                  // required, unique within the workflow
      tool: "vcs.list_commits",     // required: a registered tool id
      params: { tag: "${input.tag}", limit: "${input.limit}" },
      when: "${input.limit} > 0",   // optional gate
      stop_when: undefined,         // optional early exit
      on_failure: "retry",          // "fail" (default) | "skip" | "retry"
      retry: { max: 3, delayMs: 500 },
    },
  ],
  outputs: { commits: "${steps.fetch.output}" },
});
```

Definitions are validated with Zod on `define()` (which throws on invalid input)
or `validate()` (which returns a `Result` with `{ path, message }` errors).
Definitions are plain objects. To keep them in YAML or JSON files, parse the file
with any YAML/JSON library and pass the result to `define()`.

### Inputs

| Field | Effect |
|-------|--------|
| `required` | Missing at execution → `execute()` **rejects** with `WorkflowInputError`. |
| `default` | Applied when the caller omits the input. |
| `type`, `description` | Documentation only. **`type` is not enforced at runtime.** |

Inputs not declared in `inputs` are still passed through and can be referenced.

## Expressions

### References

| Syntax | Resolves to |
|--------|-------------|
| `${input.name}` | A workflow input |
| `${steps.<id>.output}` | The output of a completed step |
| `${steps.<id>.output.a.b}` | A nested field of that output |

Unknown paths resolve to `undefined`.

### Interpolation (in `params` and `outputs`)

- A string that is **exactly** one reference keeps the referenced value's type:
  `"${input.limit}"` → `20` (a number).
- A string with **embedded** references is stringified:
  `"v${input.tag}"` → `"v1.2.0"`. `null` and `undefined` become `""`.
- Objects and arrays are interpolated recursively. Other values pass through.

### Conditions (in `when` and `stop_when`)

Conditions are evaluated by a small built-in evaluator. They are never passed to
`eval`. A condition is either:

- **A single operand**, tested for truthiness. An empty array is falsy.
- **One binary comparison**: `<operand> <op> <operand>` with `op` in
  `==  !=  >  <  >=  <=`.

An operand is a `${...}` reference or a literal: a number, `"double"` or
`'single'` quoted string, `true`, `false`, `null`, or a bare word, which is
treated as a string.

`==` and `!=` are strict: `"${input.limit} == 20"` is true for the number `20`
and false for the string `"20"`. Ordering operators convert both sides with
`Number()`.

**Not supported:** `&&`, `||`, `!`, parentheses, or more than one comparison.
The expression is split at its **first** operator, so string literals that
contain `<`, `>`, `=` or `!` do not work. Compute complex conditions in a
tool step and gate on its output instead.

## Runtime semantics

Steps run sequentially in declaration order.

| Situation | Result |
|-----------|--------|
| `when` is false | Step recorded as `skipped` (`attempts: 0`); later references to its output resolve to `undefined`. |
| Step succeeds | Output stored under `steps.<id>.output`; then `stop_when` is checked, and if true the run ends successfully. |
| Step fails, `on_failure: "fail"` | Run stops with `ok: false` and `error: 'Step "<id>" failed: …'`. |
| Step fails, `on_failure: "retry"` | Re-run up to `retry.max` **total attempts** (default 1), waiting `retry.delayMs` between them; if all fail, behaves like `fail`. |
| Step fails, `on_failure: "skip"` | Step recorded as `failed`, run continues; its output is not stored. |
| Step fails, `on_failure: "continue"` | Run continues and ends with `ok: false`; `steps.<id>.error` holds the error (and `steps.<id>.output` any partial output) for later steps. |
| Unknown tool id | The step fails like any other failure (it does not throw). |

With a `checkpointStore` in the execution context, checkpoints are saved per
run (`workflowId` + `runId`) and removed when the run completes.
`executor.resume(definition, store, { runId })` resumes a specific run; without
`runId` it resumes the most recently checkpointed run of that workflow.

On success, `outputs` are interpolated against the final scope. When the run
fails, `outputs` is `{}`. `execute()` only rejects for an unknown workflow id
(`WorkflowNotFoundError`) or a missing required input (`WorkflowInputError`).
Every other failure is reported in the returned `WorkflowResult`.

Each step attempt calls the tool with `callId` = `<runId>:<stepId>:<attempt>`
and the run's `caller`. That means orchestrator hooks, agent allowlists and the
tool audit all apply to workflow steps.

## Audit trail

Pass `auditSinks` to the engine to receive `run-start`, `step-start`,
`step-complete` (including skipped steps) and `run-complete` events.
`JsonlWorkflowAuditSink` writes one JSON object per line.

Auditing is best-effort, as with tool audit sinks: a sink that throws or
rejects is ignored and never changes the run's outcome.
