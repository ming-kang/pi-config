/**
 * render-cache.ts — small render cache keyed by terminal width.
 *
 * Custom dialogs such as `question/dialog` re-wrap & re-truncate the same
 * lines every frame; caching by `width` saves the per-keystroke recompute.
 * The TUI calls `invalidate()` on resize and on most state changes, but the
 * resize handler only calls `requestRender()`, not `invalidate()` — so the
 * cache key MUST include the width to stay correct.
 *
 * Usage:
 *   class FooComponent {
 *     private cache = new WidthCachedRender();
 *     render(width: number): string[] {
 *       return this.cache.get(width, (w) => this.compute(w));
 *     }
 *     invalidate() { this.cache.invalidate(); }
 *   }
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
