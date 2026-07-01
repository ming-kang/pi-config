/**
 * Hand-written Protobuf encoder/decoder + Connect-RPC frame handling.
 *
 * Faithful TypeScript port of the upstream fast-context-mcp `protobuf.mjs`,
 * reproducing the Devin/Windsurf swe-grep wire format byte-for-byte. Pure
 * `node:zlib` + Buffer — no third-party dependencies.
 *
 * Wire format:
 *   - varint: base-128, low 7 bits per byte, MSB (0x80) = continuation
 *   - field tag: (fieldNumber << 3) | wireType, encoded as a varint
 *   - Connect-RPC frame: 1-byte flags + 4-byte big-endian length + payload;
 *     flags bit 0 (value 1) marks a gzip-compressed payload
 */
import { gunzipSync, gzipSync } from "node:zlib";

// ─── Protobuf Encoder ──────────────────────────────────────

export class ProtobufEncoder {
	_chunks: Buffer[] = [];

	/** Encode an unsigned varint (32-bit range, matching the upstream encoder). */
	_varint(value: number): Buffer {
		const bytes: number[] = [];
		while (value > 0x7f) {
			bytes.push((value & 0x7f) | 0x80);
			value >>>= 7;
		}
		bytes.push(value & 0x7f);
		return Buffer.from(bytes);
	}

	/** Encode a field tag: (field << 3) | wireType. */
	_tag(field: number, wire: number): Buffer {
		return this._varint((field << 3) | wire);
	}

	writeVarint(field: number, value: number): this {
		this._chunks.push(this._tag(field, 0), this._varint(value));
		return this;
	}

	writeString(field: number, value: string): this {
		const data = Buffer.from(value, "utf-8");
		this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
		return this;
	}

	writeBytes(field: number, value: Buffer | Uint8Array): this {
		const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
		this._chunks.push(this._tag(field, 2), this._varint(buf.length), buf);
		return this;
	}

	writeMessage(field: number, sub: ProtobufEncoder): this {
		const data = sub.toBuffer();
		this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
		return this;
	}

	toBuffer(): Buffer {
		return Buffer.concat(this._chunks);
	}
}

// ─── Varint Decode ─────────────────────────────────────────

/** Decode a varint at `offset`; returns [value, nextOffset]. */
export function decodeVarint(buf: Buffer, offset: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (offset < buf.length) {
		const b = buf[offset++]!;
		value |= (b & 0x7f) << shift;
		shift += 7;
		if (!(b & 0x80)) break;
	}
	return [value, offset];
}

// ─── Protobuf String Extraction ────────────────────────────

/**
 * Walk wire types and collect every length-delimited field that decodes to a
 * UTF-8 string longer than 5 chars. Used to pull the JWT and text frames out of
 * responses without a full schema. Matches the upstream loose scanner.
 */
export function extractStrings(data: Buffer): string[] {
	const strings: string[] = [];
	let i = 0;
	while (i < data.length) {
		// Read the field tag varint.
		let tag = 0;
		let shift = 0;
		while (i < data.length) {
			const b = data[i++]!;
			tag |= (b & 0x7f) << shift;
			shift += 7;
			if (!(b & 0x80)) break;
		}
		const wire = tag & 0x7;
		if (wire === 0) {
			// Varint — skip.
			while (i < data.length) {
				const b = data[i++]!;
				if (!(b & 0x80)) break;
			}
		} else if (wire === 1) {
			i += 8; // 64-bit fixed
		} else if (wire === 2) {
			// Length-delimited.
			let length = 0;
			shift = 0;
			while (i < data.length) {
				const b = data[i++]!;
				length |= (b & 0x7f) << shift;
				shift += 7;
				if (!(b & 0x80)) break;
			}
			if (i + length <= data.length) {
				const raw = data.subarray(i, i + length);
				try {
					const text = raw.toString("utf-8");
					if (text.length > 5) strings.push(text);
				} catch {
					// Not valid UTF-8 — skip.
				}
			}
			i += length;
		} else if (wire === 5) {
			i += 4; // 32-bit fixed
		} else {
			break; // Unknown wire type — stop.
		}
	}
	return strings;
}

// ─── Connect-RPC Frame Encode/Decode ───────────────────────

/** Wrap protobuf bytes in a Connect-RPC frame (gzip-compressed by default). */
export function connectFrameEncode(protoBytes: Buffer, compress = true): Buffer {
	let payload: Buffer;
	let flags: number;
	if (compress) {
		payload = gzipSync(protoBytes);
		flags = 1; // gzip compressed
	} else {
		payload = protoBytes;
		flags = 0;
	}
	const header = Buffer.alloc(5);
	header[0] = flags;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

/** Decode Connect-RPC frames, gunzipping payloads whose flags mark compression. */
export function connectFrameDecode(data: Buffer): Buffer[] {
	const frames: Buffer[] = [];
	let i = 0;
	while (i + 5 <= data.length) {
		const flags = data[i]!;
		const length = data.readUInt32BE(i + 1);
		i += 5;
		let payload = data.subarray(i, i + length);
		i += length;
		if (flags === 1 || flags === 3) {
			try {
				payload = gunzipSync(payload);
			} catch {
				// Decompression failed — keep raw payload.
			}
		}
		frames.push(Buffer.from(payload));
	}
	return frames;
}
