import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { budgetSources } from "@sembl/core";
import {
  EmailParseError,
  emailHtmlToText,
  emailSource,
  emailSources,
  emailToText,
  parseEmail,
  splitMbox,
  stripQuotedReplies,
  stripSignature,
  threadSources,
} from "../index.js";
import type { EmailLike } from "../index.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe("parseEmail", () => {
  it("reads headers, addresses, the date and the text body", async () => {
    const email = await parseEmail(fixture("plain.eml"));
    expect(email.from).toEqual({ name: "Alice Nguyen", address: "alice@seacabin.example" });
    expect(email.to).toEqual([
      { name: "Bob Osei", address: "bob@example.com" },
      { name: "", address: "carol@example.com" },
    ]);
    expect(email.cc).toEqual([{ name: "Front Desk", address: "desk@seacabin.example" }]);
    expect(email.subject).toBe("Sea Cabin availability");
    expect(email.date).toBe("2025-09-01T08:00:00.000Z");
    expect(email.messageId).toBe("plain-1@seacabin.example");
    expect(email.headers["x-mailer"]).toBe("Handwritten");
    expect(email.text).toContain("sleeps 6 across two bedrooms");
    expect(email.html).toBeUndefined();
    expect(email.attachments).toEqual([]);
  });

  it("accepts bytes as well as text", async () => {
    const email = await parseEmail(fixtureBytes("plain.eml"));
    expect(email.subject).toBe("Sea Cabin availability");
  });

  it("decodes a non-UTF-8 charset in the body and in encoded-word headers", async () => {
    const email = await parseEmail(fixture("latin1.eml"));
    expect(email.from?.name).toBe("Jørgen Sørensen");
    expect(email.subject).toBe("Café près de la mer");
    expect(email.text?.trim()).toBe("Smørrebrød et café à volonté. 120 euros la nuit, dès noël.");
  });

  it("passes an already-parsed message through, filling the convenience fields", async () => {
    const like: EmailLike = {
      headers: { From: "Alice <alice@seacabin.example>", Subject: "Hi", Date: "Mon, 1 Sep 2025 10:00:00 +0200", "Message-ID": "<x@y>" },
      text: "Body",
    };
    const email = await parseEmail(like);
    expect(email.from).toEqual({ name: "Alice", address: "alice@seacabin.example" });
    expect(email.subject).toBe("Hi");
    expect(email.date).toBe("2025-09-01T08:00:00.000Z");
    expect(email.messageId).toBe("x@y");
    expect(email.text).toBe("Body");
    expect(email.attachments).toEqual([]);
  });

  it("separates bodies and attachments of a multipart message", async () => {
    const email = await parseEmail(fixture("multipart.eml"));
    expect(email.text).toContain("Attached are the house notes");
    expect(email.html).toContain("<p>Dana,</p>");
    expect(email.attachments.map((a) => [a.filename, a.mediaType, a.inline ?? false])).toEqual([
      ["house-notes.txt", "text/plain", false],
      ["checklist.html", "text/html", false],
      ["floor-plan.pdf", "application/pdf", false],
      ["deck.png", "image/png", true],
    ]);
    const pdf = email.attachments[2];
    expect(new TextDecoder().decode(pdf.data.slice(0, 8))).toBe("%PDF-1.4");
    expect(email.attachments[3].contentId).toBe("deck@seacabin.example");
  });

  it("throws a clear error for input that is not a message", async () => {
    await expect(parseEmail("")).rejects.toThrow(EmailParseError);
    await expect(parseEmail("   \n")).rejects.toThrow(/empty/);
    await expect(parseEmail("this is not an email at all\nand never was")).rejects.toThrow(/does not look like an RFC 822 message/);
    await expect(parseEmail(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow(EmailParseError);
    await expect(parseEmail(42 as unknown as string)).rejects.toThrow(EmailParseError);
  });
});

describe("emailToText and emailSource", () => {
  it("opens with the default headers in order, then the body", async () => {
    const email = await parseEmail(fixture("plain.eml"));
    const text = emailToText(email);
    expect(text.split("\n").slice(0, 6)).toEqual([
      "From: Alice Nguyen <alice@seacabin.example>",
      "To: Bob Osei <bob@example.com>, carol@example.com",
      "Cc: Front Desk <desk@seacabin.example>",
      "Date: Mon, 1 Sep 2025 10:00:00 +0200",
      "Subject: Sea Cabin availability",
      "Message-ID: plain-1@seacabin.example",
    ]);
    expect(text).toContain("\n\nHi Bob,\n\nThe Sea Cabin sleeps 6");
    expect(text).not.toContain("In-Reply-To");
  });

  it("labels the source with the subject, or Email, or what the caller says", async () => {
    expect((await emailSource(fixture("plain.eml"))).label).toBe("Sea Cabin availability");
    expect((await emailSource(fixture("plain.eml"), { label: "Host reply" })).label).toBe("Host reply");
    expect((await emailSource({ headers: { From: "a@b.c" }, text: "x" })).label).toBe("Email");
  });

  it("renders only the headers asked for, any header, case-insensitively", async () => {
    const email = await parseEmail(fixture("plain.eml"));
    const text = emailToText(email, { includeHeaders: ["subject", "X-Mailer", "Reply-To"] });
    expect(text.split("\n\n")[0]).toBe("subject: Sea Cabin availability\nX-Mailer: Handwritten");
  });

  it("falls back to the HTML body and drops the noise around it", async () => {
    const source = await emailSource(fixture("html-only.eml"));
    expect(source.text).toContain("Booking confirmed");
    expect(source.text).toContain("Sea Cabin, 12–15 September. Sleeps 6, $250 a night.");
    expect(source.text).toContain("- Check-in from 4pm\n- Sauna and hot tub");
    expect(source.text).toContain("View your booking");
    expect(source.text).not.toContain("Preheader");
    expect(source.text).not.toContain("t.coastal-stays.example");
    expect(source.text).not.toContain("color:red");
    // The blockquote was the quoted reply.
    expect(source.text).not.toContain("Can I book 12 to 15 September?");
  });

  it("lists attachments in the header block and keeps inline images out of the body", async () => {
    const source = await emailSource(fixture("multipart.eml"));
    const [head, body] = source.text.split("\n\n");
    expect(head).toContain("Attachment: house-notes.txt (text/plain, 104 B)");
    expect(head).toContain("Attachment: floor-plan.pdf (application/pdf, 69 B)");
    expect(head).toContain("Inline image: deck.png (image/png, 70 B)");
    expect(body).toBe("Dana,");
    expect(source.text).not.toContain("Wifi:");
  });

  it("strips the quoted history and the signature from a reply by default", async () => {
    const source = await emailSource(fixture("reply.eml"));
    const body = source.text.split("\n\n").slice(1).join("\n\n");
    expect(body).toBe("Thanks Alice, that works for us. We will arrive around 4pm on the 12th with\nour dog, four adults and two children.");
  });

  it("keeps them when told to", async () => {
    const source = await emailSource(fixture("reply.eml"), { stripQuotedReplies: false, stripSignatures: false });
    expect(source.text).toContain("Mobile: +1 (555) 010-2233");
    expect(source.text).toContain("> The Sea Cabin sleeps 6");
  });

  it("cuts an Outlook-style reply at the original message and at the -- delimiter", async () => {
    const source = await emailSource(fixture("outlook-reply.eml"));
    expect(source.text).toContain("cap it at 6 guests.");
    expect(source.text).not.toContain("Managers Ltd");
    expect(source.text).not.toContain("Original Message");
    expect(source.text).not.toContain("Attached are the house notes");
  });

  it("keeps what a forwarded message forwards, minus the history inside it", async () => {
    const source = await emailSource(fixture("forwarded.eml"));
    expect(source.text).toContain("Dana, this is the guest I mentioned.");
    expect(source.text).toContain("---------- Forwarded message ---------");
    expect(source.text).toContain("From: Bob Osei <bob@example.com>");
    expect(source.text).toContain("our dog, four adults and two children.");
    expect(source.text).not.toContain("> The Sea Cabin sleeps 6");
    expect(source.text).not.toContain("wrote:");
  });

  it("keeps the headers through SEMBL's default truncation", async () => {
    const email = await parseEmail(fixture("plain.eml"));
    const source = { label: "Long", text: emailToText({ ...email, text: `${email.text}\n${"filler ".repeat(2000)}` }) };
    const [cut] = budgetSources([source], 600).sources;
    expect(cut.text.startsWith("From: Alice Nguyen")).toBe(true);
    expect(cut.text).toContain("characters omitted");
  });
});

describe("stripQuotedReplies", () => {
  it("keeps every answer of an interleaved reply", () => {
    const text = [
      "On Mon, 1 Sep 2025 at 10:00, Alice <a@x.y> wrote:",
      "> Does it sleep 6?",
      "Yes, six.",
      "> Pets?",
      "Dogs are fine.",
      "> > older still",
    ].join("\n");
    expect(stripQuotedReplies(text)).toBe("Yes, six.\nDogs are fine.");
  });

  it("takes a wrapped attribution line with the quote", () => {
    const text = "Sure.\n\nOn Mon, 1 Sep 2025 at 10:00, Alice Nguyen <alice@seacabin.example>\nwrote:\n> question";
    expect(stripQuotedReplies(text)).toBe("Sure.");
  });

  it("cuts at an Outlook header block without dashes", () => {
    const text = "Sure.\n\nFrom: Alice\nSent: Monday\nTo: Bob\nSubject: Re: x\n\nold body";
    expect(stripQuotedReplies(text)).toBe("Sure.");
  });

  it("cuts at an underscore rule and at localised original-message markers", () => {
    expect(stripQuotedReplies("New.\n\n________________________________\nFrom: X\nold")).toBe("New.");
    expect(stripQuotedReplies("Neu.\n\n-----Ursprüngliche Nachricht-----\nVon: X\nalt")).toBe("Neu.");
    expect(stripQuotedReplies("Oui.\n\nLe 1 sept. 2025 à 10:00, Alice <a@x.y> a écrit :\n> non")).toBe("Oui.");
  });

  it("treats the first reply block of a forward as the forwarded content", () => {
    const text = "FYI\n\n-----Original Message-----\nFrom: Alice\nSent: Monday\nTo: Bob\nSubject: x\n\nthe point\n\n-----Original Message-----\nFrom: Older\nSent: Sunday\nSubject: y\n\nhistory";
    expect(stripQuotedReplies(text, { forwarded: true })).toBe("FYI\n\n-----Original Message-----\nFrom: Alice\nSent: Monday\nTo: Bob\nSubject: x\n\nthe point");
    expect(stripQuotedReplies(text)).toBe("FYI");
  });

  it("unquotes an Apple Mail forward one level and drops history inside it", () => {
    const text = "See below.\n\nBegin forwarded message:\n\n> From: Alice\n> Subject: Sea Cabin\n>\n> Sleeps 6.\n>\n> On Sunday, Bob <b@x.y> wrote:\n> > free?";
    expect(stripQuotedReplies(text)).toBe("See below.\n\nBegin forwarded message:\n\nFrom: Alice\nSubject: Sea Cabin\n\nSleeps 6.");
  });

  it("keeps a message the parser rendered an attached message into", () => {
    const text = "See attached.\n\n-----------------\nFrom:    orig@b.c\nSubject: hi\nDate:    1/9/2025\n-----------------\n\nOriginal body here";
    expect(stripQuotedReplies(text)).toContain("Original body here");
  });
});

describe("stripSignature", () => {
  it("removes a short contact block, a -- block and a sent-from line", () => {
    expect(stripSignature("Body.\n\nBob Osei\nMobile: +1 (555) 010-2233\nbob@example.com")).toBe("Body.");
    expect(stripSignature("Body.\n\n-- \nBob\nhttps://example.com")).toBe("Body.");
    expect(stripSignature("Body.\n\nSent from my iPhone")).toBe("Body.");
  });

  it("keeps a sentence that mentions a phone number, and a lone block", () => {
    const text = "Call me on +1 555 010 2233 if the lockbox code does not work.";
    expect(stripSignature(`Body.\n\n${text}`)).toBe(`Body.\n\n${text}`);
    expect(stripSignature("Bob\n+1 555 010 2233")).toBe("Bob\n+1 555 010 2233");
  });
});

describe("emailHtmlToText", () => {
  it("prefixes blockquote content with one > per level", () => {
    const html = "<p>Reply</p><blockquote><p>Quoted</p><blockquote><p>Older</p></blockquote></blockquote>";
    expect(emailHtmlToText(html)).toBe("Reply\n\n> Quoted\n\n> > Older");
  });
});

describe("emailSources", () => {
  it("returns the message, text-like attachments as sources, and the rest for routing", async () => {
    const { sources, attachments } = await emailSources(fixture("multipart.eml"));
    expect(sources.map((s) => s.label)).toEqual([
      "Sea Cabin handover pack",
      "Sea Cabin handover pack: attachment house-notes.txt",
      "Sea Cabin handover pack: attachment checklist.html",
    ]);
    expect(sources[1].text).toBe("Wifi: SeaCabin / password saltwater\nParking: two cars by the boathouse\nPets: welcome, dogs off the beds");
    expect(sources[2].text).toContain("Page metadata:\ntitle: Turnover checklist");
    expect(sources[2].text).toContain("- Drain the hot tub");
    expect(attachments.map((a) => [a.label, a.attachment.mediaType, a.attachment.inline ?? false])).toEqual([
      ["Sea Cabin handover pack: attachment floor-plan.pdf", "application/pdf", false],
      ["Sea Cabin handover pack: attachment deck.png", "image/png", true],
    ]);
    expect(attachments[0].attachment.data).toBeInstanceOf(Uint8Array);
  });

  it("reads a text attachment by extension when the media type is generic, in its charset", async () => {
    const like: EmailLike = {
      headers: { From: "a@b.c", Subject: "Notes" },
      text: "See attached.",
      attachments: [
        { filename: "notes.md", mediaType: "application/octet-stream", data: new Uint8Array([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9]) },
        { filename: "blob.bin", mediaType: "application/octet-stream", data: new Uint8Array([0, 1]) },
      ],
    };
    const { sources, attachments } = await emailSources(like);
    expect(sources.map((s) => s.text)).toEqual(["From: a@b.c\nSubject: Notes\nAttachment: notes.md (application/octet-stream, 6 B)\nAttachment: blob.bin (application/octet-stream, 2 B)\n\nSee attached.", "# Café"]);
    expect(attachments.map((a) => a.attachment.filename)).toEqual(["blob.bin"]);
  });
});

describe("splitMbox", () => {
  it("splits on From_ lines and unescapes >From", () => {
    const messages = splitMbox(fixture("thread.mbox"));
    expect(messages).toHaveLength(3);
    expect(messages[0].startsWith("From: Alice Nguyen")).toBe(true);
    expect(messages[0]).toContain("\nFrom Bob's earlier note");
  });

  it("returns a lone .eml as one message", () => {
    expect(splitMbox(fixture("plain.eml"))).toHaveLength(1);
  });
});

describe("threadSources", () => {
  it("orders an mbox oldest first, labels each message, and strips the history from each", async () => {
    const { sources, attachments } = await threadSources(fixture("thread.mbox"));
    expect(sources.map((s) => s.label)).toEqual([
      "Message 1 from Bob Osei on 2025-08-31",
      "Message 2 from Alice Nguyen on 2025-09-01",
      "Message 3 from Bob Osei on 2025-09-01",
      "Message 3 from Bob Osei on 2025-09-01: attachment guests.csv",
    ]);
    expect(sources[1].text).toContain("Yes, those dates are free.");
    expect(sources[1].text).not.toContain("Hello, is the Sea Cabin free");
    expect(sources[1].text).toContain("From Bob's earlier note: we would need parking for two cars.");
    expect(sources[2].text).toContain("Booked, thank you.");
    expect(sources[2].text).not.toContain("those dates are free");
    expect(sources[3].text).toBe("name,age\nBob Osei,41\nAma Osei,39");
    expect(attachments).toEqual([]);
  });

  it("takes an array of raw and parsed messages and can keep the given order", async () => {
    const { sources } = await threadSources(
      [fixture("reply.eml"), { headers: { From: "Alice <alice@seacabin.example>", Date: "Sun, 31 Aug 2025 09:00:00 +0000" }, text: "First." }],
      { order: "given" },
    );
    expect(sources.map((s) => s.label)).toEqual(["Message 1 from Bob Osei on 2025-09-01", "Message 2 from Alice on 2025-08-31"]);
    const dated = await threadSources([fixture("reply.eml"), { headers: { From: "Alice <alice@seacabin.example>", Date: "Sun, 31 Aug 2025 09:00:00 +0000" }, text: "First." }]);
    expect(dated.sources[0].label).toBe("Message 1 from Alice on 2025-08-31");
  });

  it("keeps the given order when any message lacks a date, and labels what it can", async () => {
    const { sources } = await threadSources([{ headers: { From: "a@b.c" }, text: "x" }, fixture("plain.eml")]);
    expect(sources.map((s) => s.label)).toEqual(["Message 1 from a@b.c", "Message 2 from Alice Nguyen on 2025-09-01"]);
  });

  it("rejects an empty thread", async () => {
    await expect(threadSources([])).rejects.toThrow(EmailParseError);
  });
});
