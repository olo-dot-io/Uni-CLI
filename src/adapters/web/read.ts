import {
  EvidenceReadFailure,
  readEvidenceDocument,
} from "../../engine/evidence-reader.js";
import { cli, Strategy } from "../../registry.js";

cli({
  site: "web",
  name: "read",
  description: "Read any webpage and convert to Markdown",
  strategy: Strategy.PUBLIC,
  browser: false,
  operation_family: "get",
  operation_effect: "read",
  capabilities: ["http.fetch"],
  minimum_capability: "http.fetch",
  args: [
    {
      name: "url",
      type: "str",
      required: true,
      positional: true,
      format: "uri",
      description: "URL of the webpage to read",
    },
  ],
  columns: [],
  func: async (_page, args, context) => {
    const document = await readEvidenceDocument(String(args.url), {
      maxChars: 1_000_000,
      signal: context.signal,
    });
    if (document.truncated) {
      throw new EvidenceReadFailure({
        code: "response_too_large",
        message:
          "The document exceeds the one-million-character web read limit.",
        suggestion:
          "Use unicli extract with --max-chars to receive an explicitly bounded evidence document.",
      });
    }
    return document.content;
  },
});
