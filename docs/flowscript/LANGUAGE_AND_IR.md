# FlowScript language and IR contract

## Current source format

The current implementation parses YAML from .flow files. Example:

    flow: hello-world
    version: 1
    description: Minimal manual flow
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

Current trigger shapes are manual, schedule (cron/timezone), webhook (method/path), integration-event and polling. Schema support does not mean every trigger is wired: schedule and token-webhook foundations exist; integration event registration and polling still need implementation.

Current step kinds are integration, transform and filter. The current runner supports pure transform/reference resolution and a minimal literal boolean filter. It intentionally fails closed when an integration executor is missing.

## References

- {$ref: input.name} resolves an input property.
- {$ref: trigger.body.id} resolves a trigger property.
- {$ref: steps.fetch.output.id} resolves prior step output.
- {$env: MY_VARIABLE} resolves a runtime environment variable.

References must be explicit objects. Plain strings are not interpolated. A future expression language should be a small typed AST with bounded evaluation, not JavaScript evaluation.

## Compiler pipeline

1. Parse YAML with duplicate-key/alias restrictions.
2. Validate source schema and produce path-addressed diagnostics.
3. Validate unique step IDs and dependency references.
4. Detect self-dependencies and dependency cycles.
5. Normalize source into canonical IR.
6. Hash the canonical representation.
7. Persist source and immutable compiled artifact on publish.

The current compiler validates structure and dependencies but does not type-check integration action inputs/outputs against piece metadata. That is a required milestone.

## IR v1

IR contains irVersion, name, version, optional description, trigger, input schema, ordered steps with id/kind/config/dependsOn, and optional output mapping. Only IR produced by the compiler should be accepted for production execution. Publishing must compile source server-side.

## Compatibility rules

- Never silently reinterpret an unknown IR version.
- Published IR is immutable.
- Run records pin version ID and artifact hash.
- New incompatible semantics require a new IR version.
- Record compiler version and source hash alongside IR before production.
- Canonical serialization must be deterministic. Define key ordering and number/string normalization before treating hashes as portable artifacts.
- Validate inputs against inputSchema before enqueueing execution.
- Type-check references and outputs at compile time when metadata is available.

## Language evolution

The proposed block syntax in the high-level design document is not implemented. Stabilize YAML + IR before deciding whether a custom grammar is worth the maintenance cost. Keep compiler interfaces stable so the parser can be swapped without changing execution semantics.
