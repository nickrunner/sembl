import type { RuntimeSchema, SchemaBundle } from "./types.js";

/**
 * Registry for looking up compiled RuntimeSchemas by ID.
 */
export class SchemaRegistry {
  private schemas = new Map<string, RuntimeSchema>();

  /**
   * Register a single schema.
   */
  register(schema: RuntimeSchema): void {
    this.schemas.set(schema.id, schema);
  }

  /**
   * Register all schemas from a bundle.
   */
  registerBundle(bundle: SchemaBundle): void {
    for (const schema of Object.values(bundle.schemas)) {
      this.register(schema);
    }
  }

  /**
   * Look up a schema by ID.
   */
  get(id: string): RuntimeSchema | undefined {
    return this.schemas.get(id);
  }

  /**
   * Get a schema by ID, throwing if not found.
   */
  require(id: string): RuntimeSchema {
    const schema = this.schemas.get(id);
    if (!schema) {
      throw new Error(`Schema "${id}" not found in registry`);
    }
    return schema;
  }

  /**
   * Get a SchemaBundle of all registered schemas.
   */
  toBundle(): SchemaBundle {
    const schemas: Record<string, RuntimeSchema> = {};
    for (const [id, schema] of this.schemas) {
      schemas[id] = schema;
    }
    return { schemas };
  }

  /**
   * Get all registered schema IDs.
   */
  ids(): string[] {
    return [...this.schemas.keys()];
  }
}
