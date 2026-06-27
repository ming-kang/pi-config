/**
 * tools-view — compact tool-call rendering for Pi.
 *
 * Replaces the rendering of the built-in read / bash / edit / write tools with
 * a compact, text-only layout while preserving the original tool behavior.
 *
 * The read-only grep / find / ls tools are intentionally not re-registered
 * here. Pi keeps them available but disabled by default; registering them from
 * an extension would make them extension tools and can enable them by default.
 *
 * Known limitation: createXToolDefinition(cwd) uses default options and cannot
 * inherit session settings (shellPath, commandPrefix, autoResizeImages) because
 * the extension API does not expose them. The official built-in-tool-renderer
 * example has the same limitation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashRenderer } from "./bash.ts";
import { createEditRenderer } from "./edit.ts";
import { createReadRenderer } from "./read.ts";
import { createWriteRenderer } from "./write.ts";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	pi.registerTool(createReadRenderer(cwd));
	pi.registerTool(createBashRenderer(cwd));
	pi.registerTool(createEditRenderer(cwd));
	pi.registerTool(createWriteRenderer(cwd));
}
