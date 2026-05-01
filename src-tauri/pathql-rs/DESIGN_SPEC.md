# PathQL Design Specification

Status: draft

This document defines the design contract of PathQL as a small provider query
language. It is more stable than implementation notes and more conceptual than
`cocs/provider-dsl/RULES.md`.

`RULES.md` remains the day-to-day authoring guide for provider DSL files. This
spec defines why PathQL exists, how it should behave, where its trust boundaries
are, and how future changes should fit into the language.

## 1. Purpose

PathQL is a composable query description language for KabeGame providers.

It sits between route/provider intent and executable storage queries. A PathQL
provider describes query fragments, dynamic routing behavior, metadata, and
template-bound values. The host application loads providers, injects runtime
context, validates definitions, folds provider chains, and finally renders SQL
for the selected storage backend.

PathQL is intentionally SQL-shaped. It does not hide SQL where SQL is already
the clearest expression of the query.

## 2. Design Philosophy

### 2.1 SQL-shaped, not SQL-hidden

PathQL is not an ORM and not a general SQL replacement. SQL fragments remain
visible in provider definitions because provider authors often need to express
joins, predicates, projections, and ordering directly.

PathQL adds structure around those fragments so they can be composed, validated,
templated, and tested consistently.

### 2.2 Composition over string rewriting

Providers contribute structured query fragments. A provider chain is folded into
a final query by predictable composition rules.

Provider code should not rewrite opaque SQL strings when the same result can be
represented as fields, joins, filters, ordering, or pagination atoms.

### 2.3 Explicit namespaces

Template values must come from explicit namespaces. This keeps request input,
provider configuration, host-injected constants, metadata, provider references,
and composed SQL separate.

### 2.4 Validate early, render late

Provider definitions should be checked before execution wherever the engine can
prove useful invariants: names, namespaces, template scopes, SQL shape, metadata
types, references, and dynamic route constraints.

SQL rendering happens after provider composition, template evaluation, and
dialect selection.

### 2.5 Small language, strong conventions

PathQL should stay small. A new feature should earn its place by improving
provider composition, validation, or host integration. Authoring convenience is
valuable, but shorthand syntax must always normalize into a precise semantic
form.

### 2.6 Trusted authors, untrusted callers

PathQL provider authors are trusted project code authors. Request callers are
not trusted.

Raw SQL fragments in provider definitions are trusted code. Caller-provided
values must enter through typed inputs, captures, properties, or other
template-bound values that render as bind parameters unless the specific atom is
defined to inline a trusted query fragment such as `ref` or `composed`.

## 3. Mental Model

PathQL is easiest to understand as a pipeline:

```text
provider DSL files
  -> loader
  -> ProviderRegistry
  -> ProviderRuntime
  -> provider resolution
  -> provider chain
  -> folded ProviderQuery
  -> SQL + bind params
  -> host SqlExecutor
  -> host domain objects
```

The important point is that PathQL does not start by producing one SQL string.
It keeps provider intent as structured query fragments for as long as possible.
Only the final folded query is rendered into SQL.

This model keeps three responsibilities separate:

- DSL files describe provider intent.
- PathQL composes and renders query structure.
- The host owns loading, execution, storage mapping, and runtime constants.

## 4. Core Concepts

### 4.1 Provider

A provider is a named unit of behavior. It can declare route matching,
properties, metadata, dynamic resolution behavior, and query contributions.

The host registers provider definitions in a `ProviderRegistry`, then
instantiates providers through the runtime when a path or provider reference is
resolved.

### 4.2 Provider Runtime

The runtime owns host-level execution context:

- Provider registry.
- Provider root.
- SQL executor bridge.
- Runtime globals.

Runtime globals are read-only constants injected by the host when constructing
the runtime.

### 4.3 Query Fragment

A query fragment is a partial query contribution. It may add projection,
source, joins, predicates, ordering, or pagination.

Fragments are not complete SQL statements by default. They are pieces that can
be folded into a final `SELECT`.

### 4.4 Chain

A chain is an ordered composition of provider fragments. Chain semantics must be
deterministic: the same providers and inputs must produce the same folded query.

### 4.5 Host

The host is the application using PathQL. For KabeGame, `kabegame-core` is the
host. The host loads DSL files, registers providers, constructs the runtime,
injects globals, supplies the SQL executor, and maps rows into domain types.

## 5. Provider Model

A provider definition can contain several kinds of information:

- Identity: provider name and namespace.
- Routing: how a path segment or dynamic route selects the provider.
- Properties: provider configuration, optionally with defaults.
- Metadata: typed descriptive data exposed by the provider.
- Query: structured query fragments.
- Dynamic behavior: resolution through child providers, data bindings, or route
  captures.

Provider properties are not global state. They are provider-local configuration
values. Defaults are applied when a DSL provider is instantiated, and caller
values override defaults.

Runtime constants that are shared across providers should use `global`, not
provider properties.

## 6. Query IR

PathQL's central intermediate representation is a structured `ProviderQuery`.

The IR is SQL-shaped but not a SQL string. It contains these atoms:

| Atom | Meaning | Composition shape |
|---|---|---|
| `from` | Primary query source | One effective source |
| `fields` | Projection list | Accumulates |
| `joins` | Joined sources | Accumulates in order |
| `where` | Predicates | Conjoins unless specified otherwise |
| `order_by` | Result ordering | See section 8 |
| `limit` | Maximum row count | See section 8 |
| `offset` | Pagination offset | See section 8 |

The IR should stay close enough to SQL that provider authors can predict the
final query, while still being structured enough for folding, validation, and
template binding.

## 7. Field Semantics

Fields support two equivalent authoring forms.

Full object form:

```json5
{ "sql": "images.url" }
```

Shorthand form:

```json5
"images.url"
```

The shorthand is equivalent to a full field object with no alias and no
`in_need` sharing marker.

Authors must use the full object form when they need an alias, sharing marker,
or other field metadata.

When a query has no declared fields, the renderer emits a default projection:

- If `from` is a simple ASCII identifier, render `SELECT <from>.*`.
- Otherwise, render `SELECT *`.

This default belongs in PathQL composition/rendering, not in storage-layer caller
workarounds.

## 8. Composition Semantics

This section is the semantic law for folding provider query fragments. Keep it
precise as the implementation evolves.

### 8.1 Summary

| Atom | Current expected behavior | Notes |
|---|---|---|
| `from` | One effective source | Override/inheritance policy must remain explicit |
| `fields` | Append in chain order | Empty list uses default projection |
| `joins` | Append in chain order | Join SQL is trusted DSL code |
| `where` | Combine with `AND` | Prefer table-qualified predicates |
| `order_by` | Design-sensitive | Must be specified before extending behavior |
| `limit` | Design-sensitive | Must define override vs single-owner semantics |
| `offset` | Design-sensitive | Should be considered with `limit` |

### 8.2 `from`

The folded query has one effective `from` clause.

Open questions to keep explicit:

- Whether later providers may override an earlier `from`.
- Whether providers without `from` inherit the current folded `from`.
- Whether dynamic providers may contribute `from` only through delegated chains.

### 8.3 `fields`

Fields accumulate in chain order.

Field aliases are part of the exposed result contract. If two fields expose the
same alias, the intended behavior must be explicit in tests and docs.

Empty fields trigger the default projection described in section 7.

### 8.4 `joins`

Joins accumulate in chain order.

Join conditions are trusted SQL fragments authored by provider definitions.
Template values inside join conditions must follow normal template namespace and
binding rules.

### 8.5 `where`

Where fragments compose as logical conjunctions unless a provider atom declares a
more specific behavior.

Provider authors should prefer table-qualified predicates when the folded query
may include joins.

### 8.6 `order_by`

Ordering semantics must define whether fragments accumulate, override, or use a
priority rule. Until the rule is documented here, new ordering behavior should
be treated as a design change.

### 8.7 `limit` and `offset`

Pagination semantics must define whether later providers override earlier
providers or whether only one pagination contributor is valid.

Provider tests should cover both default pagination and explicit caller-provided
pagination.

## 9. Template Semantics

Templates are evaluated only in fields that the AST defines as template-capable.
Unbound values are errors.

`${properties.X}` reads a provider property. Provider property defaults are
applied during DSL provider instantiation. Caller-supplied properties override
defaults.

`${global.X}` reads a runtime global. Globals are injected by the host and are
read-only for the lifetime of the runtime.

`${ref:X}` and `${composed}` are query-fragment mechanisms. They are not ordinary
caller values and must only inline trusted provider-composed SQL.

Values from `input`, `properties`, `global`, `capture`, `data_var`, and
`child_var` should render as bind parameters in SQL templates unless a specific
template field defines different behavior.

Template rendering must be dialect-aware at the placeholder layer. The same
provider definition should render bind placeholders according to the selected
SQL dialect.

## 10. Namespace Model

Namespaces are part of the language's safety and readability model. A value's
namespace should make its ownership and trust boundary obvious.

| Namespace | Owner | Lifetime | SQL render behavior | Trust level |
|---|---|---|---|---|
| `input` | Request caller | Request | Bind parameter | Untrusted |
| `properties` | Provider/caller | Provider instance | Bind parameter | Caller-influenced |
| `global` | Host runtime | Runtime | Bind parameter | Host-trusted value |
| `capture` | Route matching | Request | Bind parameter | Untrusted |
| `data_var` | Runtime data binding | Provider execution | Bind parameter | Runtime-derived |
| `child_var` | Child provider | Provider execution | Bind parameter | Runtime-derived |
| `meta` | Provider definition | Provider definition | Context-specific | Trusted DSL metadata |
| `ref` | Provider registry | Runtime | Inline trusted query fragment | Trusted DSL code |
| `composed` | PathQL composer | Composition step | Inline folded query fragment | Trusted DSL code |

Adding a namespace is a language change. It requires validation, template
evaluation, render behavior, tests, `RULES.md`, and this spec to be updated
together.

## 11. Type And Value Model

PathQL values are represented as template values at render time. The core value
model should stay small and predictable:

- Text values.
- Integer values.
- Real number values.
- Boolean values.
- Null values, where supported by the relevant atom.

Provider property defaults must be converted into this value model before
template evaluation. Numeric defaults should preserve integer values when the
declared default is an integer.

Type information exists in several layers:

- DSL property declarations describe accepted configuration values.
- Metadata declarations describe provider-facing typed information.
- Runtime template values carry concrete values into rendering.
- The SQL executor and host storage layer map returned rows into domain types.

PathQL should avoid inventing a broad static type system unless composition or
validation genuinely needs it.

## 12. Validation Model

Validation is layered. Each layer proves a different kind of invariant.

- Schema validation checks shape.
- Config validation checks reserved identifiers and allowed namespaces.
- Dynamic validation checks route and dynamic binding scope.
- SQL validation checks allowed SQL shape where possible.
- Metadata validation checks typed meta declarations and references.
- Real-provider tests check the project DSL corpus as loaded by the host.

Validation does not prove full runtime SQL correctness. It is a guardrail, not a
database engine.

Any new language feature should update validation before it is considered part
of the stable design.

## 13. Runtime Model

The runtime is the bridge between pure provider definitions and host execution.

Runtime responsibilities:

- Resolve providers from the registry.
- Carry the provider root.
- Expose runtime globals to template contexts.
- Hold the SQL executor bridge.
- Preserve host/application decoupling.

The PathQL crate stays decoupled from `kabegame-core`. It should not assume
where provider files live, how they are embedded, which database driver is used,
or how result rows become application objects.

Example runtime shape:

```rust
ProviderRuntime::new(registry, root, executor, globals)
```

Project-specific globals such as `favorite_album_id` and `hidden_album_id`
belong to the host, not the language core.

## 14. Security And Trust Model

PathQL separates trusted and untrusted material.

Trusted:

- Provider DSL files committed with the application.
- Raw SQL fragments authored inside provider definitions.
- Host-injected globals.
- Provider references and composed query fragments.

Untrusted or request-scoped:

- Route captures.
- User input.
- Caller-supplied property values.
- Data values flowing from runtime providers.

Untrusted values should be rendered as bind parameters. New features that inline
untrusted values into SQL must be rejected unless they come with a clear,
validated escaping and typing model.

Important rule:

```text
Trusted query fragments may be inlined.
Untrusted values must be bound.
```

## 15. Authoring Conventions

Provider DSL files should prefer the smallest form that preserves meaning.

Use field shorthand for plain projections:

```json5
"images.width"
```

Use full field objects for aliases or shared fields:

```json5
{ "sql": "images.id", "alias": "id" }
```

Use `${global.X}` for host constants that are not true provider configuration.

Use `${properties.X}` for provider parameters that callers may intentionally
override.

Avoid storage-layer patches for query shape. If a behavior is generally true for
PathQL queries, it belongs in the PathQL engine and this spec.

Prefer table-qualified SQL fragments in shared providers:

```sql
images.deleted_at IS NULL
```

Instead of:

```sql
deleted_at IS NULL
```

## 16. Host Integration

The host is responsible for:

- Loading provider definitions.
- Registering providers.
- Choosing validation config.
- Constructing `ProviderRuntime`.
- Supplying SQL execution through the executor trait.
- Injecting runtime globals.
- Mapping SQL result rows into host domain types.

The host may choose its own loading strategy. Examples include embedded bytes,
development paths, generated provider registries, or test literals.

PathQL should expose stable engine primitives instead of requiring the host to
depend on crate-internal file layout.

## 17. Compatibility And Evolution

Language changes should update all relevant layers:

- AST types.
- Serialization and deserialization.
- Composition/folding behavior.
- SQL rendering.
- Template evaluation.
- Validation.
- Real-provider fixtures.
- `RULES.md`.
- This design spec.

### 17.1 Adding a namespace

Adding a namespace requires:

- Ownership and lifetime definition.
- Trust classification.
- Template evaluation behavior.
- SQL render behavior.
- Validation scope updates.
- Tests for bound, unbound, and invalid usage.
- Documentation in `RULES.md` and this spec.

### 17.2 Adding a query atom

Adding a query atom requires:

- AST representation.
- Normalized semantic form.
- Fold/composition rule.
- SQL render rule.
- Validation behavior.
- Real-provider fixture coverage if used by project DSL.
- Canonical examples.

### 17.3 Adding shorthand syntax

Adding shorthand syntax requires:

- Exact equivalence to a full form.
- Round-trip expectations.
- Validation compatibility.
- Tests proving the shorthand and full form behave the same.

### 17.4 Changing composition behavior

Changing composition behavior is a compatibility-sensitive language change.

Such a change should update:

- This spec's composition table.
- Existing real-provider expectations.
- Tests that show old and new behavior where relevant.
- Migration notes for provider authors.

## 18. Non-goals

PathQL is not:

- A public end-user query language.
- A full SQL dialect abstraction layer.
- A query optimizer.
- A replacement for Rust-side domain logic.
- A scripting language.
- A generic database driver API.

## 19. Canonical Examples

### 19.1 Simple projection

```json5
{
  "name": "gallery_route",
  "query": {
    "from": "images",
    "fields": [
      "images.id",
      "images.url",
      "images.width",
      "images.height",
    ],
  },
}
```

### 19.2 Runtime global in a join

```json5
{
  "query": {
    "from": "images",
    "joins": [
      {
        "kind": "left",
        "table": "album_images",
        "as": "fav_ai",
        "on": "fav_ai.image_id = images.id AND fav_ai.album_id = ${global.favorite_album_id}",
      },
    ],
  },
}
```

### 19.3 Full field object with alias

```json5
{
  "query": {
    "fields": [
      { "sql": "images.id", "alias": "id" },
      { "sql": "CASE WHEN fav_ai.image_id IS NULL THEN 0 ELSE 1 END", "alias": "is_favorite" },
    ],
  },
}
```

### 19.4 Empty fields default projection

```json5
{
  "query": {
    "from": "images",
    "where": "images.deleted_at IS NULL",
  },
}
```

The rendered projection is:

```sql
SELECT images.*
```

If `from` is not a simple table identifier, the rendered projection is:

```sql
SELECT *
```

## 20. Open Design Questions

These are intentionally tracked in the spec instead of being hidden in code
comments.

- Should `order_by` accumulate or override?
- Should `limit` and `offset` be last-writer-wins or single-owner atoms?
- Should field alias collisions be validation errors?
- Should globals be validated against a host-declared schema?
- Should join declarations eventually gain a shorthand form?
- Should provider references expose typed result contracts?
