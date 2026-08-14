/**
 * Renderers for the artifact kinds that cannot execute.
 *
 * The split these live on: `html` and `svg` can carry script, so they are shown
 * in a sandboxed `<webview>` (ArtifactViewer). Everything here is inert data, so
 * it is rendered by the app itself — which is the only way it gets the app's
 * typography and theme instead of a bare white frame.
 *
 * **That inertness is a claim this file has to keep true.** These components run
 * in loop's own origin, with the renderer's RPC bridge on `window`, so anything
 * that escapes here is not a broken page — it is script with access to the
 * agent. Markdown is the only kind with real teeth (it can embed raw HTML), and
 * it is sanitised below; the rest go into text nodes, which React escapes.
 */
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";

/**
 * Deliberately the stock schema, not the chat's.
 *
 * `ChatMarkdown` widens `defaultSchema` to allow `file:` hrefs, which is
 * reasonable for a message about your own repo and wrong here: an artifact is a
 * page a model wrote, and letting it mint links into the local filesystem is a
 * capability it has no reason to hold. Stock allows http/https/mailto and drops
 * every script, event handler and unknown attribute.
 */
const ARTIFACT_SANITIZE_SCHEMA = defaultSchema satisfies Parameters<typeof rehypeSanitize>[0];

/** rehypeRaw parses embedded HTML; rehypeSanitize then strips what it may not keep. */
const ARTIFACT_REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, ARTIFACT_SANITIZE_SCHEMA]] as const;
const ARTIFACT_REMARK_PLUGINS = [remarkGfm] as const;

/** Tailwind prose-ish styling without the plugin — the app does not ship one. */
const PROSE = [
  "mx-auto w-full max-w-3xl px-6 py-8 text-[14px] leading-relaxed text-foreground",
  "[&_h1]:mt-8 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_p]:my-3",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-8 [&_hr]:border-border",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px]",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px]",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5",
  "[&_img]:my-4 [&_img]:max-w-full [&_img]:rounded",
].join(" ");

export function ArtifactMarkdown({ content }: { readonly content: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown
        rehypePlugins={ARTIFACT_REHYPE_PLUGINS as never}
        remarkPlugins={ARTIFACT_REMARK_PLUGINS as never}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Pretty-printed when it parses, verbatim when it does not — never an error page. */
export function ArtifactJson({ content }: { readonly content: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Malformed JSON is still worth reading — that is usually the point of
      // opening it.
      return content;
    }
  }, [content]);
  return <ArtifactPlainText content={pretty} />;
}

/**
 * Split one CSV line, honouring quoted fields.
 *
 * A hand-rolled parse rather than a dependency: this only ever renders a table
 * that a human reads, so the failure mode of an exotic dialect is a wrong
 * column, not corrupted data. Doubled quotes inside a quoted field ("") are the
 * one escape that shows up often enough to matter.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** Rows past this render as plain text — a table this long is a download, not a page. */
const MAX_CSV_ROWS = 2000;

export function ArtifactCsv({ content }: { readonly content: string }) {
  const rows = useMemo(() => {
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
    return lines.slice(0, MAX_CSV_ROWS).map(splitCsvLine);
  }, [content]);

  const [header, ...body] = rows;
  if (!header) return <ArtifactPlainText content={content} />;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                className="sticky top-0 border border-border bg-muted px-3 py-1.5 text-left font-medium"
                key={i}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td className="border border-border px-3 py-1.5 align-top" key={c}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= MAX_CSV_ROWS ? (
        <p className="px-1 py-3 text-xs text-muted-foreground/70">
          {`Showing the first ${MAX_CSV_ROWS} rows.`}
        </p>
      ) : null}
    </div>
  );
}

export function ArtifactPlainText({
  className,
  content,
}: {
  readonly className?: string;
  readonly content: string;
}) {
  return (
    <pre
      className={cn(
        "min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-[12.5px] leading-relaxed text-foreground",
        className,
      )}
    >
      {content}
    </pre>
  );
}
