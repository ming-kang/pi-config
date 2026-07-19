/** Bounded HTTP response body helpers shared by probe and models.dev lookups. */

export async function readBodyBounded(
	response: Response,
	maxBytes: number,
	limitMessage?: string,
): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(limitMessage ?? `Response exceeds the ${formatBytes(maxBytes)} limit.`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			throw new Error(limitMessage ?? `Response exceeds the ${formatBytes(maxBytes)} limit.`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function formatBytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
