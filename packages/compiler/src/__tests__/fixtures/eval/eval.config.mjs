// A config the eval command can import: a runtime schema and a provider
// that answers by reading the plain text back out of the framed input.
import { defineSchema, field } from "@sembl/core";

export const schema = defineSchema("Person", "A person.", {
  name: field.string("Name."),
  age: field.number("Age.").optional(),
});

export const provider = {
  async complete(request) {
    const text = request.userInput.replace(/<\/?source[^>]*>/g, "").trim();
    const [name, age] = text.split(",").map((s) => s.trim());
    return {
      data: { name, age: age ? Number(age) : null },
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    };
  },
};

export const prices = { inputPerMTok: 1, outputPerMTok: 2 };
