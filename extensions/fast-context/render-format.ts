/**
 * Fast Context-specific render helpers. Shared line primitives (callLine,
 * activeDotLine, resultLine, errLine) live in tools-view/shared.ts; this module
 * keeps only the collapsed summary and expanded-envelope colorization that are
 * unique to Fast Context.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FastContextDetails } from "./execute.ts";

/** The dim/accent one-liner for a successful collapsed result (no expand hint). */
export function buildCollapsedSummary(details: FastContextDetails | undefined, theme: Theme): string {
	const n = details?.fileCount ?? 0;
	// Dim explicitly: the caller composes on resultPrefix(), which no longer
	// dim-wraps the summary for us.
	if (n <= 0) return theme.fg("dim", "No relevant files found");
	const kw = details?.keywords ?? [];
	const count = theme.fg("accent", `${n} file${n === 1 ? "" : "s"}`);
	const tail = kw.length ? theme.fg("dim", ` · grep: ${kw.slice(0, 4).join(", ")}`) : "";
	return `${count}${tail}`;
}

/** Recolor the text envelope line-by-line for the expanded human view. */
export function colorizeEnvelope(text: string, theme: Theme): string {
	return text
		.split("\n")
		.map((line) => {
			if (line === "") return "";

			// File header: "  [1/3] /path/to/file.ts (L10-60, L80-90)"
			let m = line.match(/^(\s*\[\d+\/\d+\])\s+(.*?)(\s+\(L[^)]*\))?$/);
			if (m) {
				const ranges = m[3] ? theme.fg("dim", m[3]) : "";
				return `${theme.fg("dim", m[1]!)} ${theme.fg("toolTitle", m[2]!)}${ranges}`;
			}

			// Line-numbered code: "      10 │ export const x = …"
			m = line.match(/^(\s+)(\d+) (│) (.*)$/);
			if (m) {
				return `${m[1]}${theme.fg("dim", m[2]!)} ${theme.fg("dim", m[3]!)} ${theme.fg("toolOutput", m[4]!)}`;
			}

			// Header / empty-result lines
			if (/^Found \d+ relevant/.test(line) || /^No (relevant files found|files found)/.test(line))
				return theme.fg("toolTitle", line);

			// grep keywords
			m = line.match(/^(grep keywords:)\s*(.*)$/);
			if (m) return `${theme.fg("dim", m[1]!)} ${theme.fg("accent", m[2]!)}`;

			// Actionable hints stand out; other bracketed meta is muted
			if (/^\[hint\]/.test(line)) return theme.fg("warning", line);
			if (/^\[(note|config|diagnostic)\]/.test(line)) return theme.fg("muted", line);

			if (/^Error:/.test(line)) return theme.fg("error", line);
			if (/^Raw response:/.test(line)) return theme.fg("dim", line);

			return theme.fg("toolOutput", line);
		})
		.join("\n");
}
