# @sembl/compiler

Schema compiler for SEMBL. Walks decorated TypeScript classes and emits the
runtime schemas [`@sembl/core`](https://github.com/nickrunner/sembl/tree/main/packages/core)
coerces against.

Extraction reads the source AST with ts-morph. Decorators are no-ops at
runtime — nothing is reflected or evaluated — so a value that isn't written out
in source can't be read, and the compiler says so rather than guessing.

See the [project README](https://github.com/nickrunner/sembl#readme) for the
full walkthrough.

## Install

```sh
pnpm add -D @sembl/compiler
```

## Usage

```sh
sembl extract --input src/schemas --output src/generated
```

Emits one `<Name>.schema.ts` per decorated class plus an `index.ts` exporting a
`SchemaBundle`. Treat the output as a build artifact: gitignore it, and run
extraction before your build.

| Flag              | Notes                                                        |
| ----------------- | ------------------------------------------------------------ |
| `-i, --input`     | Directory of decorated schema classes. Required.              |
| `-o, --output`    | Directory for generated files. Required.                      |
| `--tsconfig`      | Path to a tsconfig, when type resolution needs your settings. |
| `--strict`        | Exit non-zero on warnings. Recommended in CI.                 |

## Warnings

Warnings print to stderr and are advisory by default. They are worth reading —
each one marks a place where the emitted schema is narrower or vaguer than the
type you wrote:

- a `@Constrain` entry that isn't a compile-time literal, so it can't be read
- `@ValuesFrom` on a field that isn't a string or `string[]`
- a type with no `FieldType` equivalent (a `Date`, a `Map`, an index-signature
  object), which falls back to a string so the rest of the schema still extracts

Inline anonymous object types don't warn — they get a synthesized nested schema
registered in the bundle, named after the class and property path.
