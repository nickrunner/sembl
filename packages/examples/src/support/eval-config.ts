/**
 * Config for `sembl eval`, built to `dist/support/eval-config.js`:
 *
 *   pnpm --filter @sembl/examples eval
 *
 * Exports the schema to evaluate, the provider to do it with, and prices for
 * the cost line. Recordings make the second run free.
 */
import { demoProvider, enumResolver } from "./provider.js";
import { Listing } from "./listing-runtime.js";

export const schema = Listing;
export const provider = demoProvider().provider;
export { enumResolver };
export const prices = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 };
export const coerceOptions = { onInvalidField: "clamp" as const, maxInputChars: 20_000 };
