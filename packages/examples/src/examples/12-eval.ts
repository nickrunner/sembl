import { runEval, loadFixtures, formatReport, saveReport, loadReport, diffReports } from "@sembl/testing";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver } from "../support/provider.js";
import { examplesPath } from "../support/env.js";
import { heading, note } from "../support/print.js";

export const title = "Eval: per-field precision and recall over fixtures, with deltas against the last run";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const fixturesDir = examplesPath("evals", "listing");
  const reportFile = examplesPath("evals", "listing", ".sembl-eval", "last-run.json");

  heading(`Fixtures in evals/listing`);
  const fixtures = loadFixtures(fixturesDir);
  note(fixtures.map((f) => f.name).join(", "));

  const previous = loadReport(reportFile);
  const report = await runEval({
    fixtures,
    schema: Listing,
    provider,
    enumResolver,
    mode: "partialCoerce",
    onInvalidField: "clamp",
    prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  });
  saveReport(report, reportFile);

  heading("Report");
  console.log(formatReport(report, previous ? diffReports(previous, report) : undefined));
  note(`\nSaved to ${reportFile}. Rerun after a change to see the deltas.`);
  note('Try it: add "Infer it from the symbol: $ is USD, € is EUR, £ is GBP." to the currency description in src/support/listing-runtime.ts.');
  note("The same thing from the CLI: pnpm --filter @sembl/examples eval");
}
