/** Truncate text to a fixed character budget with a trailing ellipsis. */
export function truncateText(text: string, maxLength: number): string {
	const ellipsis = "...";
	if (text.length <= maxLength) return text;
	if (ellipsis.length >= maxLength) return ellipsis.slice(0, maxLength);
	return `${text.slice(0, maxLength - ellipsis.length)}${ellipsis}`;
}
