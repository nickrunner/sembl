import { describe, it, expect } from "vitest";
import {
  collectEnumSources,
  resolveEnumSources,
} from "../schema/resolve-enum-sources.js";
import type { EnumResolver } from "../schema/enum-source.js";
import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";

const listingSchema: RuntimeSchema = {
  id: "Listing",
  description: "A rental listing.",
  fields: [
    {
      name: "propertyType",
      description: "Kind of property",
      type: { kind: "dynamicEnum", sourceId: "propertyTypes" },
      required: true,
    },
    {
      name: "amenities",
      description: "Amenity slugs",
      type: { kind: "array", items: { kind: "dynamicEnum", sourceId: "amenities" } },
      required: false,
    },
    {
      name: "location",
      description: "Where it is",
      type: { kind: "object", nestedSchemaId: "Location" },
      required: true,
    },
  ],
};

const locationSchema: RuntimeSchema = {
  id: "Location",
  description: "A place.",
  fields: [
    {
      name: "region",
      description: "Region slug",
      type: { kind: "dynamicEnum", sourceId: "regions" },
      required: true,
    },
  ],
};

const bundle: SchemaBundle = {
  schemas: { Listing: listingSchema, Location: locationSchema },
};

/** Resolver returning one synthetic value per source. */
const echoResolver: EnumResolver = (sourceId) => [`${sourceId}-a`, `${sourceId}-b`];

describe("collectEnumSources", () => {
  it("finds sources through nested objects and array item types", () => {
    const usages = collectEnumSources(listingSchema, bundle);

    expect([...usages.keys()].sort()).toEqual([
      "amenities",
      "propertyTypes",
      "regions",
    ]);
    expect(usages.get("amenities")!.paths).toEqual(["amenities[]"]);
    expect(usages.get("regions")!.paths).toEqual(["location.region"]);
  });

  it("marks a source required only when every field on the path is required", () => {
    const usages = collectEnumSources(listingSchema, bundle);

    // propertyType is required at the root
    expect(usages.get("propertyTypes")!.required).toBe(true);
    // location is required and region is required within it
    expect(usages.get("regions")!.required).toBe(true);
    // amenities itself is optional
    expect(usages.get("amenities")!.required).toBe(false);
  });

  it("treats a source as required if any one of its uses is required", () => {
    const schema: RuntimeSchema = {
      id: "Multi",
      description: "Two uses of one source.",
      fields: [
        {
          name: "primary",
          description: "Primary tag",
          type: { kind: "dynamicEnum", sourceId: "tags" },
          required: true,
        },
        {
          name: "secondary",
          description: "Secondary tag",
          type: { kind: "dynamicEnum", sourceId: "tags" },
          required: false,
        },
      ],
    };

    const usage = collectEnumSources(schema).get("tags")!;
    expect(usage.required).toBe(true);
    expect(usage.paths).toEqual(["primary", "secondary"]);
  });

  it("terminates on a schema that references itself", () => {
    const nodeSchema: RuntimeSchema = {
      id: "Node",
      description: "A self-referencing node.",
      fields: [
        {
          name: "kind",
          description: "Node kind",
          type: { kind: "dynamicEnum", sourceId: "nodeKinds" },
          required: true,
        },
        {
          name: "child",
          description: "Nested node",
          type: { kind: "object", nestedSchemaId: "Node" },
          required: false,
        },
      ],
    };
    const cyclic: SchemaBundle = { schemas: { Node: nodeSchema } };

    const usages = collectEnumSources(nodeSchema, cyclic);
    expect([...usages.keys()]).toEqual(["nodeKinds"]);
  });

  it("terminates on a cycle spanning two schemas", () => {
    const a: RuntimeSchema = {
      id: "A",
      description: "A.",
      fields: [
        { name: "b", description: "B", type: { kind: "object", nestedSchemaId: "B" }, required: true },
        { name: "tag", description: "Tag", type: { kind: "dynamicEnum", sourceId: "aTags" }, required: true },
      ],
    };
    const b: RuntimeSchema = {
      id: "B",
      description: "B.",
      fields: [
        { name: "a", description: "A", type: { kind: "object", nestedSchemaId: "A" }, required: true },
        { name: "tag", description: "Tag", type: { kind: "dynamicEnum", sourceId: "bTags" }, required: true },
      ],
    };

    const usages = collectEnumSources(a, { schemas: { A: a, B: b } });
    expect([...usages.keys()].sort()).toEqual(["aTags", "bTags"]);
  });

  it("still walks a schema reached twice through different branches", () => {
    const leaf: RuntimeSchema = {
      id: "Leaf",
      description: "Leaf.",
      fields: [
        { name: "tag", description: "Tag", type: { kind: "dynamicEnum", sourceId: "leafTags" }, required: true },
      ],
    };
    const root: RuntimeSchema = {
      id: "Root",
      description: "Root.",
      fields: [
        { name: "left", description: "Left", type: { kind: "object", nestedSchemaId: "Leaf" }, required: true },
        { name: "right", description: "Right", type: { kind: "object", nestedSchemaId: "Leaf" }, required: true },
      ],
    };

    const usage = collectEnumSources(root, { schemas: { Root: root, Leaf: leaf } }).get(
      "leafTags",
    )!;
    expect(usage.paths).toEqual(["left.tag", "right.tag"]);
  });
});

describe("resolveEnumSources", () => {
  it("returns values keyed by source id", async () => {
    const { enums, failures } = await resolveEnumSources(
      listingSchema,
      echoResolver,
      bundle,
    );

    expect(failures).toEqual([]);
    expect(enums.propertyTypes).toEqual(["propertyTypes-a", "propertyTypes-b"]);
    expect(enums.regions).toEqual(["regions-a", "regions-b"]);
  });

  it("calls the resolver once per distinct source id", async () => {
    const seen: string[] = [];
    const schema: RuntimeSchema = {
      id: "Multi",
      description: "Two uses of one source.",
      fields: [
        { name: "a", description: "A", type: { kind: "dynamicEnum", sourceId: "tags" }, required: true },
        { name: "b", description: "B", type: { kind: "dynamicEnum", sourceId: "tags" }, required: true },
      ],
    };

    await resolveEnumSources(schema, (id) => {
      seen.push(id);
      return ["x"];
    });

    expect(seen).toEqual(["tags"]);
  });

  it("resolves sources concurrently", async () => {
    // Each call blocks until both have started; a sequential implementation
    // would deadlock and time out here.
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((r) => {
      release = r;
    });

    const { enums } = await resolveEnumSources(
      listingSchema,
      async (id) => {
        started++;
        if (started === 3) {
          release();
        }
        await bothStarted;
        return [id];
      },
      bundle,
    );

    expect(Object.keys(enums).sort()).toEqual([
      "amenities",
      "propertyTypes",
      "regions",
    ]);
  });

  it("reports a source that resolves to nothing as a failure", async () => {
    const { enums, failures } = await resolveEnumSources(
      listingSchema,
      (id) => (id === "regions" ? [] : [id]),
      bundle,
    );

    expect(enums.regions).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sourceId: "regions",
      reason: "empty",
      required: true,
      paths: ["location.region"],
    });
  });

  it("reports a resolver that throws as a failure, keeping the other sources", async () => {
    const boom = new Error("CMS unreachable");
    const { enums, failures } = await resolveEnumSources(
      listingSchema,
      (id) => {
        if (id === "amenities") {
          throw boom;
        }
        return [id];
      },
      bundle,
    );

    expect(enums.propertyTypes).toEqual(["propertyTypes"]);
    expect(failures).toHaveLength(1);
    expect(failures[0].sourceId).toBe("amenities");
    expect(failures[0].reason).toBe("threw");
    expect(failures[0].cause).toBe(boom);
    // amenities is an optional field, so this failure is not fatal
    expect(failures[0].required).toBe(false);
  });

  it("reports a rejected promise the same way as a synchronous throw", async () => {
    const { failures } = await resolveEnumSources(
      listingSchema,
      (id) =>
        id === "regions" ? Promise.reject(new Error("timeout")) : Promise.resolve([id]),
      bundle,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ sourceId: "regions", reason: "threw" });
  });

  it("reports failures in a deterministic order", async () => {
    const { failures } = await resolveEnumSources(
      listingSchema,
      async (id) => {
        // Settle in reverse-alphabetical order.
        await new Promise((r) => setTimeout(r, id === "amenities" ? 5 : 0));
        return [];
      },
      bundle,
    );

    expect(failures.map((f) => f.sourceId)).toEqual([
      "amenities",
      "propertyTypes",
      "regions",
    ]);
  });

  it("is a no-op for a schema with no dynamic enums", async () => {
    const plain: RuntimeSchema = {
      id: "Plain",
      description: "No dynamic enums.",
      fields: [
        { name: "name", description: "Name", type: { kind: "string" }, required: true },
      ],
    };

    let called = false;
    const { enums, failures } = await resolveEnumSources(plain, () => {
      called = true;
      return ["x"];
    });

    expect(called).toBe(false);
    expect(enums).toEqual({});
    expect(failures).toEqual([]);
  });
});
