/**
 * Split an mbox file into its raw messages.
 *
 * A message starts at a line beginning `From ` (the mbox "From_" line,
 * which is not a header and is removed) and runs to the next one. Lines
 * escaped as `>From ` inside a body — the mboxrd convention — are unescaped.
 * Text with no `From_` line at all is returned as a single message, so an
 * `.eml` passed where an mbox was expected still works.
 */
export function splitMbox(mbox: string): string[] {
  const text = mbox.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const messages: string[] = [];
  let current: string[] | undefined;

  for (const line of lines) {
    if (/^From (?!:)\S/.test(line)) {
      if (current) messages.push(current.join("\n"));
      current = [];
      continue;
    }
    if (!current) current = [];
    current.push(line.replace(/^>(>*From )/, "$1"));
  }
  if (current) messages.push(current.join("\n"));

  return messages.map((m) => m.trim()).filter((m) => m.length > 0);
}
