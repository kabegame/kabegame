# PathQL Design Specification

Status: stable contract

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

| Atom | Behavior | Notes |
|---|---|---|
| `from` | Cascading replace | Later declarations replace the effective source |
| `fields` | Additive with alias sharing | Empty list uses default projection |
| `joins` | Additive with alias sharing | Join SQL is trusted DSL code |
| `where` | Additive `AND` | Prefer table-qualified predicates |
| `order_by` | Ordered upsert plus global direction directive | See section 8.6 |
| `limit` | Last-wins | `0` keeps normal SQL empty-result semantics |
| `offset` | Additive `+` | Multiple offsets compose in chain order |

### 8.2 `from`

The folded query has one effective `from` clause. A provider that declares
`from` replaces the effective source for itself and downstream providers. A
provider without `from` inherits the already folded source.

### 8.3 `fields`

Fields accumulate in chain order. A literal alias must be unique unless the
incoming field marks `in_need: true`; in that case an existing alias satisfies
the need and the duplicate contribution is skipped.

Empty fields trigger the default projection described in section 7.

### 8.4 `joins`

Joins accumulate in chain order. A literal join alias must be unique unless the
incoming join marks `in_need: true`; in that case an existing alias satisfies
the need and the duplicate contribution is skipped.

Join conditions are trusted SQL fragments authored by provider definitions.
Template values inside join conditions must follow normal template namespace and
binding rules.

### 8.5 `where`

Where fragments compose as logical conjunctions unless a provider atom declares a
more specific behavior.

Provider authors should prefer table-qualified predicates when the folded query
may include joins.

### 8.6 `order_by`

Array-form ordering is an ordered upsert list. Earlier positions have higher
priority; later declarations of the same field update its direction while
preserving the original position. `revert` flips an existing direction and
defaults to `asc` when the field is new.

Object-form ordering with `{ "all": "revert" | "asc" | "desc" }` is a global
direction directive. It applies to the accumulated order chain and is itself
last-wins across the provider chain.

### 8.7 `limit` and `offset`

`limit` is last-wins. A later provider may intentionally replace an earlier
limit, including replacing it with `0`.

`offset` is additive. Each offset atom is parenthesized and combined with `+` in
chain order, so nested pagination composes predictably.

### 8.8 Delegate scope chain

Delegation is a first-class provider reference, not a DSL-local shortcut.
Whenever a path segment or listed child is produced through `delegate`, the
runtime owns following the reference, folding the delegate target's query
contribution, and caching the final visible path state.

This rule is the same for `resolve` and `list`:

List is usually used to discover all available services, and resolve is used for known services and dynamic services.

- The DSL layer may return a typed reference instead of a direct child.
- For `resolve`, the runtime recursively follows the delegate chain and folds
  each `target.apply_query(composed)` contribution before applying the final
  child provider.
- The runtime stores the normal resolved path state: the final provider, if any,
  the composed query, and the provider keys used for invalidation.
- There is no wrapper-provider cache entry and no separate terminal-provider
  concept.

#### 8.8.1 `resolve` delegation

`Provider::resolve` returns `ResolveRef`.

`ResolveRef::Terminal(None)` means the provider's explicit routing rules found
nothing. The runtime then proceeds to the list fallback described below.

`ResolveRef::Terminal(Some(child))` means the segment was found directly. The
runtime continues with `child.provider`. A child with `provider: None` is a
valid no-provider node.

`ResolveRef::Delegate { target, transform }` means this provider routed the
segment through a delegate. The runtime owns the recursion:

1. Accumulate query with `seg_composed = target.apply_query(seg_composed)`.
2. Call `target.resolve(name, seg_composed)`.
3. If the target also returns `Delegate`, repeat the process.
4. When the chain bottoms out at `Terminal`, unwind transforms from innermost
   to outermost. The final `ChildEntry` comes from the outermost transform.

`transform` has the shape
`Fn(Option<&ChildEntry>, &ProviderContext) -> Option<ChildEntry>`. It receives
the child resolved by the target chain, or `None` if the target chain found
nothing, and returns this delegation level's visible child. `None` means this
level is also a miss. Template evaluation or instantiation failures inside a
transform are treated as misses.

The DSL layer creates the transform closure at resolve-call time, capturing
template fields such as `child_var`, `provider`, `properties`, and `meta`. It
does not call `target.resolve()` internally.

If the resolve chain bottoms out at `Terminal(None)`, regardless of delegate
depth, the runtime searches `resolve_provider.list(seg_composed)`, where
`resolve_provider` is the deepest target in the chain. With no delegation this
is the current provider. In an explicit chain such as `A -> B -> C`, only `C` is
the correct fallback scope: `B.resolve()` already routed this name to `C`, so
backtracking to `B.list()` would search unrelated siblings.

The same transform-stack unwind is applied to children found through the list
fallback. Items found in the deepest target's list are converted into the
outermost visible `ChildEntry` before the final provider's query contribution is
applied.

Child caching during fallback depends on whether transforms are pending:

- If the transform stack is empty, listed siblings are already at the visible
  level. `expand_list_refs` may pre-cache them, and the outer segment loop reads
  the authoritative cache entry back instead of overwriting it.
- If the transform stack is non-empty, raw list items belong to the deepest
  target. They must not be pre-cached at `path_before_seg/<name>`. The normal
  cache write happens only after transforms are applied.

`DslProvider::resolve` no longer inspects dynamic list entries. It returns
`Terminal(None)` when explicit resolve rules and static list keys both miss,
allowing the runtime list fallback to handle dynamic list entries uniformly.

#### 8.8.2 `list` delegation

`Provider::list` returns `Vec<ListRef>`.

`ListRef::Direct(child)` is an already materialized visible child. The runtime
returns it as part of the list result.

`ListRef::DelegateExpand { target, expand }` is a delegated child source. The
runtime handles it in four steps:

1. Fold `target.apply_query(composed)` into the parent composed query.
2. Call `target.list(target_composed)` and recursively expand any nested
   `ListRef` values.
3. For each target child, call the DSL-provided `expand(child, ctx)` closure to
   materialize the visible outer `ChildEntry`.
4. Cache the visible child path using the composed query that contains the
   target contribution and, when present, the visible child's own provider
   contribution.

The `expand` closure is created by the DSL layer. It captures the list key
template, child variable name, provider selection rule, properties, metadata,
provider instance properties, and current namespace. It does not receive or own
the runtime cache; it only converts a target child into an optional visible
outer child.

Nested delegate-list expansion is flattened before returning to the caller.
Intermediate target children used only as expansion input are not cached at the
outer parent path. Only the final visible child paths are eligible for cache
insertion.

If the visible child provider is `None`, the child path is cached as a
no-provider node. If the visible child provider is an `EmptyDslProvider`, the
child is returned in the list result but the path is not cached.

Direct list children are enumeration results. They do not by themselves imply a
child-path cache write; child-path cache population is a runtime responsibility
for delegated expansion because only the runtime has the composed state that
includes the delegate target contribution.

## 9. Template Semantics

Templates are evaluated only in fields that the AST defines as template-capable.
Unbound values are errors.

`${properties.X}` reads a provider property. Provider property defaults are
applied during DSL provider instantiation. Caller-supplied properties override
defaults.

`${global.X}` reads a runtime global. Globals are injected by the host and are
read-only for the lifetime of the runtime.

`${global:prefix|selector}` is a string-template method for runtime global
maps. The renderer evaluates `selector` in the current template context, builds
the lookup key `prefix + "." + selector_value`, reads that key from runtime
globals, and returns the global value as a string. This method is for path
segments, labels, note text, properties, and object/array metadata templates. It
is not an SQL inlining mechanism; SQL templates use `${global.X}` so the value
is rendered as a bind parameter.

If a list key uses `${global:prefix|selector}` and `selector` reads a dynamic
row or child binding, the key is a dynamic list key and follows the same
`data_var` or `child_var` ownership rules as `${row.name}` or
`${child.name}`.

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

`global` also exposes the `${global:prefix|selector}` method in string-template
rendering. The method performs a host-global lookup and returns display text or
another host-provided string value; it does not create a new namespace.

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
let runtime = ProviderRuntime::new(executor, globals);
runtime.register_provider(provider_def)?;
runtime.set_root(namespace, simple_name)?;
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

Use `${global:prefix|selector}` when a host-owned map should translate a stable
runtime value into a path/display string. Example: a host may inject
`vd_en_US_month.01 = "January"` and a provider may render
`${global:vd_en_US_month|root.name}` while delegating to a shared month provider
that still returns canonical month numbers.

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

For directory-based DSL assets, the host loader recursively scans provider
files with supported provider extensions and applies an explicit exclusion list
for non-provider assets such as schemas and intentionally retired compatibility
shims. The root provider is registered first; all remaining provider files are
registered deterministically. Duplicate provider names are loader errors, not
override points.

Provider names that contain template expressions are runtime-dynamic references.
They are resolved when instantiated, after the provider's properties/captures
have been rendered. Strict cross-reference validation checks only static
provider names; templated names are validated by syntax and scope rules, then
left to runtime registration.

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

### 19.3 Runtime global map for display labels

```json5
{
  "list": {
    "${global:vd_en_US_month|root.name}": {
      "delegate": {
        "provider": "year_provider",
        "properties": { "year": "${properties.year}" }
      },
      "child_var": "root",
      "provider": "vd_month_en_US_provider",
      "properties": {
        "year_month": "${properties.year}-${root.name}"
      },
      "meta": {
        "month": "${root.name}",
        "label": "${global:vd_en_US_month|root.name}"
      }
    }
  }
}
```

The host injects keys such as `vd_en_US_month.01 = "January"`. The shared
provider keeps canonical month ids, while the visible path segment and metadata
label use the host-owned display map.

### 19.4 Full field object with alias

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

### 19.5 Empty fields default projection

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

## 20. Final Invariants

These invariants define compatibility for provider authors and host
integrations:

- Untrusted caller values render as bind parameters in SQL templates.
- Trusted query fragments are the only template forms that inline SQL.
- Provider chain folding is deterministic and follows section 8.
- Runtime globals are host-owned read-only values.
- Directory loaders must exclude non-provider assets explicitly.
- Static provider references are validated eagerly in strict mode.
- Templated provider references are runtime-dynamic and resolve at
  instantiation time.
- `Provider::resolve` returns routing intent only. `ResolveRef::Delegate`
  carries a deferred `transform` closure, not pre-computed provider or metadata.
- The runtime owns recursive delegate-chain traversal for path segment
  resolution.
