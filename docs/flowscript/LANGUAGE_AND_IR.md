# FlowScript language and IR contract

## Current source format

The current implementation parses YAML from .flow files. Example:

```yaml
flow: hello-world
version: 1
description: Minimal manual FlowScript flow
trigger:
  kind: manual
inputSchema:
  name:
    type: string
steps:
  - id: greeting
    kind: transform
    config:
      value:
        message: Hello
        name:
          $ref: input.name
    dependsOn: []
output:
  greeting:
    $ref: steps.greeting
```

Current trigger shapes are manual, schedule (cron/timezone), webhook (method/path), integration-event and polling. Schema support does not mean every trigger is wired: schedule and token-webhook foundations exist; integration event registration and polling still need implementation.

Current step kinds are integration, transform and filter. The runner supports pure transform/reference resolution and a boolean filter. It fails closed when an integration executor is missing.

## References and static validation

- `{$ref: input.name}` resolves an input property. Validated at compile time against `inputSchema`. Referencing undeclared input keys returns `FLOW_INVALID_REFERENCE`. If `inputSchema` is empty or omitted (`inputSchema: {}`), inputs are treated as dynamic/untyped, and reference checks for `input.*` are exempted.
- `{$ref: trigger.body.id}` resolves a trigger property. Validated at compile time against `trigger.kind`. Manual triggers do not provide payload data; attempting to reference manual trigger payloads in step configs or output mappings returns `FLOW_INVALID_REFERENCE`.
- `{$ref: steps.fetch.output.id}` resolves prior step output. Validated at compile time: the target step must exist in the workflow and must be an ancestor declared in `dependsOn` (or an output mapping). Step dependencies must appear prior to the declaring step in the flow's step array (`depIndex < index`); forward dependencies are rejected with `FLOW_INVALID_REFERENCE` to ensure reliable array-order execution. Referencing steps without declaring dependencies returns `FLOW_INVALID_REFERENCE`, and self-references return `FLOW_SELF_DEPENDENCY`.
- `{$env: MY_VARIABLE}` resolves a runtime environment variable.

References must be explicit objects. Plain strings are not interpolated.

## Compiler pipeline

1. Parse YAML with duplicate-key and alias restrictions (`maxAliasCount: 0`).
2. Validate source schema and produce path-addressed diagnostics.
3. Validate unique step IDs (`FLOW_DUPLICATE_STEP`).
4. Validate step dependencies, enforce array-index ordering (`depIndex < index`), reject self-references, and detect cycles (`FLOW_DEPENDENCY_CYCLE`).
5. Traverse all `$ref` expressions and statically validate input, trigger, and step dependencies (`FLOW_INVALID_REFERENCE`).
6. Normalize source into canonical IR with pinned `irVersion` (1) and `compilerVersion` (`1.0.0`).
7. Serialize semantic IR with canonical key-sorted JSON (`canonicalizeJson`) and compute deterministic SHA-256 artifact hash.
8. Store raw `sourceHash` on the IR and version record for provenance.

## Diagnostic codes

| Code | Description |
|---|---|
| `FLOW_PARSE_ERROR` | Malformed YAML syntax or unparseable source. |
| `FLOW_SCHEMA_ERROR` | Missing or invalid top-level fields / step shapes. |
| `FLOW_DUPLICATE_STEP` | Multiple steps share the same `id`. |
| `FLOW_UNKNOWN_DEPENDENCY` | A step depends on a step ID that does not exist. |
| `FLOW_SELF_DEPENDENCY` | A step lists itself in `dependsOn` or references its own output. |
| `FLOW_DEPENDENCY_CYCLE` | Step dependencies form a directed cycle. |
| `FLOW_INVALID_REFERENCE` | A `$ref` references an undeclared input, invalid trigger payload, undeclared step dependency, forward dependency, or unknown step. |
| `FLOW_INPUT_SCHEMA_MISMATCH` | Runtime execution inputs fail required field or primitive type checks. |
| `FLOW_UNSUPPORTED_IR_VERSION` | IR version is not supported by this compiler/runtime release. |
| `FLOW_UNKNOWN_STEP_KIND` | An unrecognized step kind was declared. |

## Canonical serialization and artifact hashes

Artifact hashes are computed over canonicalized JSON (`canonicalizeJson`), which recursively sorts all object keys lexicographically and normalizes primitives. This ensures that any two sources producing identical semantic IR generate the exact same 64-character SHA-256 hash regardless of YAML key order, formatting, or operating system. Because `compilerVersion` participates in the canonical IR hash, bumping the compiler version re-hashes all compiled sources, providing explicit immutability and version provenance across compiler releases.

## Input schema validation

`validateRunInput(inputSchema, input)` enforces input boundaries before queuing or executing runs (wired in both `POST /v1/flows/:name/run` and `flow run` CLI). If an input property declares `required: true` and is missing, or if declared primitive types (`string`, `number`, `boolean`) do not match, validation fails closed with `FLOW_INPUT_SCHEMA_MISMATCH`.

## Compatibility rules

- Never silently reinterpret an unknown IR version.
- Published IR is immutable.
- Run records pin version ID and artifact hash.
- Incompatible semantics require a new IR version.
- Record compiler version and source hash alongside IR.
