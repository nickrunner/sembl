import { partialCoerceWithProvenance } from "@sembl/core";
import { emailSource, splitMbox, threadSources } from "@sembl/source-email";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok, warn, table } from "../support/print.js";

export const title = "Email threads: quoted replies stripped, attachments routed";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const mbox = sample("lakehouse-handover.mbox");

  heading("@sembl/source-email: a three-message thread, oldest first, each message only its own words");
  const { sources, attachments } = await threadSources(mbox);
  table(sources.map((s) => ({ source: s.label, chars: s.text.length })));

  heading("What quoting costs: the host's reply with and without the history");
  const [, hostReply] = splitMbox(mbox);
  const raw = await emailSource(hostReply, { stripQuotedReplies: false, stripSignatures: false });
  note(`${raw.text.length} characters as sent → ${sources[1].text.length} as the model sees it: the quoted inquiry and the signature are gone`);
  show("Message 2", sources[1].text);

  heading("Attachments: text-like ones became sources, the rest are yours to route");
  show(
    "returned for routing",
    attachments.map((a) => ({ label: a.label, mediaType: a.attachment.mediaType, bytes: a.attachment.data.byteLength })),
  );
  note("The house notes (.txt) are already a source above. The PDF would go to a PDF source package; here it stays out of the coercion.");

  heading("partialCoerceWithProvenance over the thread");
  const { data, provenance } = await partialCoerceWithProvenance<Listing>(sources, {
    provider,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
  });
  show("Listing", data);
  table(
    Object.entries(provenance).map(([field, p]) => ({
      field,
      confidence: p.confidence,
      source: p.source ?? "",
    })),
  );

  const fromNotes = Object.values(provenance).some((p) => p.source?.includes("house-notes.txt"));
  if (data.petsAllowed === false && data.sleeps === 8 && fromNotes) {
    ok("the rate and sleeps came from the host's reply, the charger from the attached notes — provenance names the message each value was read from");
  } else {
    warn("the extraction differs from the expected reading; check the provenance table above");
  }
}
