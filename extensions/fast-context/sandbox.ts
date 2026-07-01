/**
 * Path sandbox — the security boundary for remotely-planned filesystem commands.
 *
 * The Devin backend plans paths (rg/readfile/tree/ls/glob) that we execute
 * locally. The upstream executor mapped `/codebase`-rooted paths but passed any
 * other path through verbatim, and never re-checked `..` traversal after join —
 * so a planned `/codebase/../../etc/passwd` or an absolute path escaped the
 * project root. This module closes that hole: every model-supplied path is
 * mapped through `toReal`, which refuses anything that resolves outside the root
 * (lexically AND after symlink resolution).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const VIRTUAL_ROOT = "/codebase";

/** Lexical containment: is `p` the base or strictly inside it? */
function within(base: string, p: string): boolean {
	const rel = relative(base, p);
	if (rel === "") return true;
	if (rel === "..") return false;
	if (rel.startsWith(".." + sep)) return false;
	if (isAbsolute(rel)) return false; // different drive on Windows
	return true;
}

/**
 * realpath that tolerates a not-yet-existing tail: resolve symlinks on the
 * deepest existing ancestor, then re-append the missing segments. This keeps
 * symlinked parents normalized even for paths that don't exist yet.
 */
function safeRealpath(p: string): string {
	let current = resolve(p);
	const tail: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(p); // hit the filesystem root, nothing exists
		tail.unshift(basename(current));
		current = parent;
	}
	try {
		const real = realpathSync(current);
		return tail.length ? resolve(real, ...tail) : real;
	} catch {
		return resolve(p);
	}
}

export class PathSandbox {
	/** Lexically resolved root. */
	readonly root: string;
	/** Symlink-resolved root (may differ from `root`, e.g. /tmp -> /private/tmp). */
	readonly realRoot: string;

	constructor(root: string) {
		this.root = resolve(root);
		this.realRoot = safeRealpath(this.root);
	}

	/**
	 * Map a model-supplied virtual path to a real filesystem path, or null if it
	 * escapes the root. `/codebase/...` is root-relative; bare relative paths are
	 * treated as root-relative; absolute paths are rejected outright.
	 */
	toReal(virtual: string): string | null {
		if (typeof virtual !== "string" || virtual.length === 0) return null;

		let rel: string;
		if (virtual.startsWith(VIRTUAL_ROOT) || virtual.startsWith("\\codebase")) {
			rel = virtual.slice(VIRTUAL_ROOT.length).replace(/^[/\\]+/, "");
		} else if (isAbsolute(virtual)) {
			return null; // model must address everything under /codebase
		} else {
			rel = virtual.replace(/^[/\\]+/, "");
		}

		const candidate = resolve(this.root, rel);
		if (!this.contains(candidate)) return null;
		return candidate;
	}

	/**
	 * True if an already-real absolute path stays within the root — lexically
	 * (catches `..` traversal) AND after symlink resolution (catches symlink
	 * escapes). Used to vet glob walk results, not just model-supplied paths.
	 */
	contains(realPath: string): boolean {
		const abs = resolve(realPath);
		return within(this.root, abs) && within(this.realRoot, safeRealpath(abs));
	}

	/** Remap a real path back to the virtual `/codebase` root for model-facing output. */
	toVirtual(realPath: string): string {
		let out = realPath;
		for (const base of [this.realRoot, this.root]) {
			if (out === base) return VIRTUAL_ROOT;
			if (out.startsWith(base + sep)) {
				out = VIRTUAL_ROOT + out.slice(base.length);
				break;
			}
		}
		return out.split(sep).join("/");
	}

	/** Replace every occurrence of the root prefix in free-form text with /codebase. */
	remapText(text: string): string {
		let out = text;
		for (const base of new Set([this.realRoot, this.root])) {
			out = out.split(base).join(VIRTUAL_ROOT);
		}
		return out;
	}
}
