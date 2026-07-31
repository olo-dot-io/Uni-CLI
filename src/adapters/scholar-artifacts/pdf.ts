/**
 * @owner       src::adapters::scholar-artifacts::pdf
 * @does        Registers source-agnostic scholarly PDF artifact download and text extraction commands.
 * @needs       kernel CommandExecutionContext cancellation, src/engine/executor.ts download/exec steps, pdftotext, scholarly adapters that expose pdf_url
 * @feeds       src/commands/scholar.ts generic scholar download/read workflows
 * @breaks      PDF URL drift, denied download paths, missing pdftotext, or empty extracted text stop the artifact loop.
 * @invariants  PDF bytes are downloaded through pipeline resource guards; caller cancellation reaches download and pdftotext; text extraction uses the same pdftotext contract as pdf/read.
 * @side-effects HTTPS egress to the supplied PDF URL; writes PDF files under the requested output directory; executes pdftotext for read-pdf.
 * @perf        O(PDF bytes + extracted pages); page range defaults to the first 20 pages.
 * @concurrency Caller-provided unique output directories isolate invocations; the same ref/output pair shares one deterministic artifact path.
 * @test        tests/unit/adapters/scholar-artifacts.test.ts
 * @stability   experimental
 * @since       2026-06-26
 */

import { cli, Strategy } from "../../registry.js";
import { downloadScholarPdf, readScholarPdf } from "./pdf-read.js";

export {
  requireScholarMaxChars,
  requireScholarPageRange,
  requireScholarPdfUrl,
  scholarArtifactFilename,
  truncateScholarText,
} from "./pdf-read.js";

const SCHOLAR_ARTIFACT_PDF_OPTIONS = {
  site: "scholar-artifacts",
  command: "read-pdf",
  defaultOutput: "./scholar-downloads",
  userAgent:
    "unicli-scholar-artifacts/1.0 (https://github.com/olo-dot-io/Uni-CLI)",
};

cli({
  site: "scholar-artifacts",
  name: "download-pdf",
  description: "Download a scholarly PDF URL with artifact metadata",
  domain: "scholarly-pdf",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "pdf_url",
      type: "str",
      required: true,
      positional: true,
      description: "Open scholarly PDF URL",
      format: "uri",
    },
    { name: "title", type: "str", description: "Paper title" },
    { name: "id", type: "str", description: "Source-local paper id" },
    { name: "source_adapter", type: "str", description: "Source adapter name" },
    { name: "source_url", type: "str", description: "Landing page URL" },
    {
      name: "output",
      type: "str",
      default: "./scholar-downloads",
      description: "Output directory",
    },
    { name: "filename", type: "str", description: "Output PDF filename" },
  ],
  columns: [
    "id",
    "title",
    "source_adapter",
    "pdf_url",
    "source_url",
    "path",
    "_download",
  ],
  capabilities: ["http.download"],
  minimum_capability: "http.download",
  func: async (_page, kwargs, context) => [
    await downloadScholarPdf(kwargs, {
      ...SCHOLAR_ARTIFACT_PDF_OPTIONS,
      command: "download-pdf",
      signal: context.signal,
    }),
  ],
});

cli({
  site: "scholar-artifacts",
  name: "read-pdf",
  description: "Download a scholarly PDF URL and extract text with pdftotext",
  domain: "scholarly-pdf",
  strategy: Strategy.PUBLIC,
  operation_family: "download",
  operation_effect: "local_file",
  args: [
    {
      name: "pdf_url",
      type: "str",
      required: true,
      positional: true,
      description: "Open scholarly PDF URL",
      format: "uri",
    },
    { name: "title", type: "str", description: "Paper title" },
    { name: "id", type: "str", description: "Source-local paper id" },
    { name: "source_adapter", type: "str", description: "Source adapter name" },
    { name: "source_url", type: "str", description: "Landing page URL" },
    {
      name: "output",
      type: "str",
      default: "./scholar-downloads",
      description: "Output directory",
    },
    { name: "filename", type: "str", description: "Output PDF filename" },
    { name: "first-page", type: "int", default: 1, description: "First page" },
    { name: "last-page", type: "int", default: 20, description: "Last page" },
    {
      name: "max-chars",
      type: "int",
      default: 40000,
      description: "Maximum extracted text characters",
    },
  ],
  columns: [
    "id",
    "title",
    "source_adapter",
    "pdf_url",
    "source_url",
    "path",
    "text",
    "text_chars",
    "text_truncated",
  ],
  capabilities: ["http.download", "subprocess.exec"],
  executables: ["pdftotext"],
  minimum_capability: "subprocess.exec",
  func: async (_page, kwargs, context) => [
    await readScholarPdf(kwargs, {
      ...SCHOLAR_ARTIFACT_PDF_OPTIONS,
      signal: context.signal,
    }),
  ],
});
