import { run } from "../../adapters/exec.js";
import { resolveBinaryPath } from "../../adapters/resolve-binary.js";
import { DISPATCH_DIR } from "../infra/paths.js";
import { hasDispatchMarker } from "../domain/playbooks.js";

const PHRASE_HEADER = "## Phrase";
const PHRASE_CAP = 48;
const GENERATE_TIMEOUT_MS = 20_000;

export interface GroupTitleMember {
  identifier: string;
  title: string;
  project: string | null;
}

function buildPrompt(members: GroupTitleMember[]): string {
  const lines = members
    .map(
      (m) =>
        `- ${m.identifier}: ${m.title}${m.project ? ` (project: ${m.project})` : ""}`,
    )
    .join("\n");
  return `You are naming a group of related Dispatch tickets that will be worked on together in one session. Read the tickets below and propose a short phrase describing their common thread.

Tickets:
${lines}

Output rules — follow exactly:
- Output ONLY one markdown section, with no preamble, no closing remarks, and no code fence wrapping the whole output.
- Start with the exact literal header line:

${PHRASE_HEADER}
<one concise plain-text phrase: no markdown, no trailing period, no ticket identifiers, capped at ${PHRASE_CAP} characters>

- Never emit the literal text "DISPATCH_STATUS:" anywhere in your output.`;
}

/**
 * Parse a `generateGroupTitlePhrase` stdout into the phrase string. Exported (undecorated by any
 * subprocess spawn) so a scratchpad/verify script can assert its shape/footgun guards without
 * invoking `claude`. Mirrors `parseTicketDraft`'s exact throwing contract: throws a plain `Error`
 * — the caller maps every throw to the same 502 `generate-failed` surface `cards.route.ts` already
 * uses for `/cards/draft` — when the `## Phrase` header is missing, when the phrase is empty after
 * trim, or when the phrase carries the `DISPATCH_STATUS:` marker. As a final defense-in-depth step
 * (the prompt already asks for this but a model can ignore it), the result is hard-clamped to
 * `PHRASE_CAP` characters before returning.
 */
export function parseGroupTitlePhrase(stdout: string): string {
  const headerIdx = stdout.indexOf(PHRASE_HEADER);
  if (headerIdx === -1) {
    throw new Error("missing ## Phrase header in generation output");
  }

  const phrase = stdout
    .slice(headerIdx + PHRASE_HEADER.length)
    .trim()
    .split("\n")[0]
    .trim();

  if (phrase === "") {
    throw new Error("empty phrase in generation output");
  }
  if (hasDispatchMarker(phrase)) {
    throw new Error("generated content contains the DISPATCH_STATUS marker");
  }

  return phrase.slice(0, PHRASE_CAP);
}

/**
 * Generate a group title phrase via a headless `claude -p` subprocess (`ORCH-05`), mirroring
 * `ticket-generate.ts#generateTicketDraft`'s invocation contract exactly (same binary resolution,
 * `--tools ""`, `--strict-mcp-config`, `--no-session-persistence`, `maxBuffer`, `cwd:
 * DISPATCH_DIR`). The prompt is the ONLY request-derived argv element; every flag is a fixed
 * literal.
 * @remarks `GENERATE_TIMEOUT_MS` (20s) is deliberately far shorter than `ticket-generate.ts`'s
 * 150s: this is a background prefill on a modal the user may press Start on within seconds, not
 * an explicit user-initiated wait with its own progress phase. Output is double-screened —
 * `DISPATCH_STATUS` marker rejection plus a hard length clamp inside {@link parseGroupTitlePhrase}
 * — mirroring `ticket-generate.ts:66`'s defense-in-depth posture. `killEscalationMs` arms `run()`'s
 * SIGTERM→grace→SIGKILL escalation so a `claude` that ignores SIGTERM cannot wedge the route's
 * `groupTitleInFlight` single-flight guard into permanent 409s.
 * @see docs/ARCHITECTURE.md#group-card-titles
 */
export async function generateGroupTitlePhrase(
  members: GroupTitleMember[],
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildPrompt(members);
  const claudePath = (await resolveBinaryPath("claude")) ?? "claude";
  const { stdout } = await run(
    claudePath,
    [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    {
      cwd: DISPATCH_DIR,
      timeout: GENERATE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      signal,
      killEscalationMs: 5_000,
    },
  );

  return parseGroupTitlePhrase(stdout);
}
