import { describe, it, expect, afterEach } from "vitest";
import { sembl, Coercible } from "../coerce/coercible.js";
import { SemblConfig, resolveConfig } from "../coerce/config.js";
import { EnumResolutionError } from "../errors/enum-resolution-error.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../provider/types.js";
import type { RuntimeSchema } from "../schema/types.js";

const profileSchema: RuntimeSchema = {
  id: "Profile",
  description: "A user profile.",
  fields: [
    { name: "name", description: "Name", type: { kind: "string" }, required: true },
    { name: "sport", description: "Sport", type: { kind: "string" }, required: false },
  ],
};

const intentSchema: RuntimeSchema = {
  id: "PromptIntent",
  description: "The intent of a prompt.",
  fields: [
    { name: "action", description: "Action", type: { kind: "string" }, required: true },
    { name: "target", description: "Target", type: { kind: "string" }, required: true },
  ],
};

function createMockProvider(
  response: Record<string, unknown>,
  spy?: (input: string) => void,
): Provider {
  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      spy?.(request.userInput);
      return {
        data: response,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
}

afterEach(() => {
  SemblConfig.reset();
});

describe("sembl + Coercible", () => {
  it("single coerceTo returns coerced data", async () => {
    const provider = createMockProvider({ name: "Alice", sport: null });

    const result = await sembl("I'm Alice", { provider }).coerceTo<{
      name: string;
    }>(profileSchema);

    expect(result.name).toBe("Alice");
  });

  it("single partialCoerceTo returns partial data", async () => {
    const provider = createMockProvider({ name: "Bob", sport: null });

    const result = await sembl("I'm Bob", { provider }).partialCoerceTo<{
      name: string;
      sport: string;
    }>(profileSchema);

    expect(result.name).toBe("Bob");
    expect(result.sport).toBeUndefined();
  });

  it("chained partialCoerceTo().coerceTo() passes serialized result", async () => {
    const inputs: string[] = [];
    let callCount = 0;

    const provider: Provider = {
      async complete(request: ProviderRequest): Promise<ProviderResponse> {
        inputs.push(request.userInput);
        callCount++;
        if (callCount === 1) {
          return {
            data: { name: "Alice", sport: null },
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        }
        return {
          data: { action: "suggest", target: "route" },
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
    };

    const result = await sembl("I love cycling", { provider })
      .partialCoerceTo<{ name: string }>(profileSchema)
      .coerceTo<{ action: string; target: string }>(intentSchema);

    expect(result.action).toBe("suggest");
    expect(result.target).toBe("route");

    // First call receives the original input
    expect(inputs[0]).toBe("<source>\nI love cycling\n</source>");
    // Second call receives JSON of the partial result (nulls stripped)
    expect(inputs[1]).toBe(`<source>\n${JSON.stringify({ name: "Alice" })}\n</source>`);
  });

  it("serializes object input to JSON", async () => {
    let capturedInput = "";
    const provider = createMockProvider(
      { action: "run", target: "marathon" },
      (input) => {
        capturedInput = input;
      },
    );

    await sembl({ foo: "bar", num: 42 }, { provider }).coerceTo(intentSchema);

    expect(capturedInput).toBe(`<source>\n${JSON.stringify({ foo: "bar", num: 42 })}\n</source>`);
  });

  it("is thenable — await works directly after coerceTo", async () => {
    const provider = createMockProvider({ name: "Carol", sport: null });
    const coercible = sembl("test", { provider }).coerceTo(profileSchema);

    // Should be a Coercible
    expect(coercible).toBeInstanceOf(Coercible);

    // Should be awaitable
    const result = await coercible;
    expect(result).toHaveProperty("name", "Carol");
  });

  it("error in first step stops the chain", async () => {
    const provider: Provider = {
      async complete(): Promise<ProviderResponse> {
        throw new Error("LLM failure");
      },
    };

    await expect(
      sembl("test", { provider })
        .partialCoerceTo(profileSchema)
        .coerceTo(intentSchema),
    ).rejects.toThrow("LLM failure");
  });
});

describe("SemblConfig", () => {
  it("resolveConfig uses global provider when no per-call override", () => {
    const provider = createMockProvider({});
    SemblConfig.configure({ provider });

    const resolved = resolveConfig();
    expect(resolved.provider).toBe(provider);
  });

  it("per-call provider overrides global provider", () => {
    const globalProvider = createMockProvider({});
    const callProvider = createMockProvider({});
    SemblConfig.configure({ provider: globalProvider });

    const resolved = resolveConfig({ provider: callProvider });
    expect(resolved.provider).toBe(callProvider);
  });

  it("throws when no provider is configured anywhere", () => {
    expect(() => resolveConfig()).toThrow("No provider configured");
  });

  it("reset clears global config", () => {
    const provider = createMockProvider({});
    SemblConfig.configure({ provider });

    SemblConfig.reset();

    expect(() => resolveConfig()).toThrow("No provider configured");
  });

  it("sembl uses global config when no per-call config given", async () => {
    const provider = createMockProvider({ name: "Global", sport: null });
    SemblConfig.configure({ provider });

    const result = await sembl("test").coerceTo<{ name: string }>(profileSchema);
    expect(result.name).toBe("Global");
  });

  it("per-call enumResolver overrides the global one", () => {
    const globalResolver = () => ["global"];
    const callResolver = () => ["call"];
    SemblConfig.configure({ provider: createMockProvider({}), enumResolver: globalResolver });

    expect(resolveConfig().enumResolver).toBe(globalResolver);
    expect(resolveConfig({ enumResolver: callResolver }).enumResolver).toBe(callResolver);
  });
});

describe("Coercible carries the enum resolver through a chain", () => {
  const taggedSchema: RuntimeSchema = {
    id: "Tagged",
    description: "A tagged thing.",
    fields: [
      {
        name: "tag",
        description: "Tag",
        type: { kind: "dynamicEnum", sourceId: "tags" },
        required: true,
      },
    ],
  };

  it("resolves sources at every step of the chain", async () => {
    const resolvedFor: string[] = [];
    const provider: Provider = {
      async complete(request: ProviderRequest): Promise<ProviderResponse> {
        resolvedFor.push(JSON.stringify(request.resolvedEnums));
        return { data: { tag: "alpha", name: "Alice", action: "go", target: "there" } };
      },
    };

    SemblConfig.configure({ provider, enumResolver: () => ["alpha", "beta"] });

    await sembl("input").coerceTo(taggedSchema).partialCoerceTo(taggedSchema);

    expect(resolvedFor).toEqual([
      JSON.stringify({ tags: ["alpha", "beta"] }),
      JSON.stringify({ tags: ["alpha", "beta"] }),
    ]);
  });

  it("rejects the chain when a required source cannot be resolved", async () => {
    SemblConfig.configure({
      provider: createMockProvider({ tag: "alpha" }),
      enumResolver: () => {
        throw new Error("CMS unreachable");
      },
    });

    await expect(sembl("input").coerceTo(taggedSchema)).rejects.toThrow(
      EnumResolutionError,
    );
  });
});

describe("sembl with labelled sources", () => {
  it("passes sources through the first link untouched", async () => {
    let captured = "";
    const provider: Provider = {
      async complete(request) {
        captured = request.userInput;
        return { data: { name: "Ada" } };
      },
    };
    const schema: RuntimeSchema = {
      id: "Person",
      description: "A person.",
      fields: [{ name: "name", description: "Name", type: { kind: "string" }, required: true }],
    };
    await sembl(
      [
        { label: "Email", text: "From Ada" },
        { label: "Form", text: "A." },
      ],
      { provider },
    ).coerceTo(schema);
    expect(captured).toContain('<source label="Email">');
    expect(captured).toContain('<source label="Form">');
  });
});

describe("sembl with instructions", () => {
  afterEach(() => SemblConfig.reset());

  const schema: RuntimeSchema = {
    id: "Quote",
    description: "A price quote.",
    fields: [{ name: "price", description: "Price", type: { kind: "number" }, required: true }],
  };

  it("uses the global list unless the call overrides it", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      async complete(request) {
        prompts.push(request.systemPrompt);
        return { data: { price: 1 } };
      },
    };
    SemblConfig.configure({ provider, instructions: ["Global hint."] });
    await sembl("x").coerceTo(schema);
    await sembl("x", { instructions: "Call hint." }).coerceTo(schema);
    expect(prompts[0]).toContain("- Global hint.");
    expect(prompts[0]).not.toContain("Call hint.");
    expect(prompts[1]).toContain("- Call hint.");
    expect(prompts[1]).not.toContain("Global hint.");
  });
});
