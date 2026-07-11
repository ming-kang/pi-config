/** Cache custom dialog output by terminal width. */
export class WidthCachedRender {
	private cachedLines: string[] | undefined;
	private cachedWidth: number | undefined;

	invalidate(): void {
		this.cachedLines = undefined;
	}

	get(width: number, compute: (width: number) => string[]): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = compute(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}
