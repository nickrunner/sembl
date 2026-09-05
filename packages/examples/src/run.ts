import { demoProvider } from "./support/provider.js";
import { heading, note } from "./support/print.js";
import * as e01 from "./examples/01-basics.js";
import * as e02 from "./examples/02-define-schema.js";
import * as e03 from "./examples/03-constraints-and-taxonomies.js";
import * as e04 from "./examples/04-lenient-validation.js";
import * as e05 from "./examples/05-repair.js";
import * as e06 from "./examples/06-sources.js";
import * as e07 from "./examples/07-html-and-budget.js";
import * as e08 from "./examples/08-batch.js";
import * as e09 from "./examples/09-provenance.js";
import * as e10 from "./examples/10-tracing.js";
import * as e11 from "./examples/11-record-replay.js";
import * as e12 from "./examples/12-eval.js";
import * as e13 from "./examples/13-instructions.js";
import * as e14 from "./examples/14-images.js";
import * as e15 from "./examples/15-pdf.js";
import * as e16 from "./examples/16-table.js";
import * as e17 from "./examples/17-email.js";
import * as e18 from "./examples/18-audio.js";
import * as e19 from "./examples/19-docx.js";
import * as e20 from "./examples/20-feeds.js";
import * as e21 from "./examples/21-image-tools.js";

const examples = [
  ["01", e01], ["02", e02], ["03", e03], ["04", e04], ["05", e05], ["06", e06],
  ["07", e07], ["08", e08], ["09", e09], ["10", e10], ["11", e11], ["12", e12], ["13", e13],
  ["14", e14], ["15", e15], ["16", e16], ["17", e17], ["18", e18], ["19", e19], ["20", e20],
  ["21", e21],
] as const;

async function main(): Promise<void> {
  const filter = process.argv.slice(2);
  const selected = filter.length === 0
    ? examples
    : examples.filter(([n, m]) => filter.some((f) => n === f.padStart(2, "0") || m.title.toLowerCase().includes(f.toLowerCase())));
  if (selected.length === 0) {
    console.error(`No example matches ${filter.join(" ")}. Available:`);
    for (const [n, m] of examples) console.error(`  ${n}  ${m.title}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Provider: ${demoProvider().description}`);
  for (const [n, m] of selected) {
    console.log(`\n\x1b[36m━━━ ${n}  ${m.title} ━━━\x1b[0m`);
    await m.run();
  }
  heading("Done");
  note("Run one example with `pnpm demo 06`, or by a word in its title: `pnpm demo batch`.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
