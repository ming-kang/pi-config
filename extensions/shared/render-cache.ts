/**
 * render-cache.ts — small render cache keyed by terminal width.
 *
 * A few custom dialogs (search-selector, question/dialog) re-wrap & re-truncate
 * the same lines every frame; caching by `width` saves the per-keystroke
 * recompute. The TUI calls `invalidate()` on resize and on most state changes,
 * but the resize handler only calls `requestRender()`, not `invalidate()` —
 * so the cache key MUST include the width to stay correct.
 *
 * Usage:
 *   class FooComponent {
 *     private cache = new WidthCachedRender();
 *     render(width: number): string[] {
 *       return this.cache.get(width, (w) => this.compute(w));
 *     }
 *     invalidate() { this.cache.invalidate(); }
 *   }
 *
 * Drop-in: replaces the `(cachedLines, cachedWidth)` pair that appeared in
 * search-selector.ts and question/dialog.ts as a hand-rolled pair.
 */
export class WidthCachedRender {
	private cached: string[] | undefined;
	private cachedWidth: number | undefined;

	invalidate(): void {
		this.cached = undefined;
	}

	/** Return the cached lines for `width`, computing + caching when stale. */
	get(width: number, compute: (width: number) => string[]): string[] {
		if (this.cached !== undefined && this.cachedWidth === width) return this.cached;
		this.cached = compute(width);
		this.cachedWidth = width;
		return this.cached;
	}
}
