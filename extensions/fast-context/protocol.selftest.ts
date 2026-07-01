/**
 * Self-contained self-test for protocol.ts.
 *
 * Verifies the protobuf / Connect-RPC wire format against hand-derived golden
 * vectors (standard protobuf encoding, so this checks the port against the spec,
 * not just against upstream) plus round-trip properties.
 *
 *   node extensions/fast-context/protocol.selftest.ts
 *
 * Optional byte-for-byte parity against the upstream reference:
 *   FC_UPSTREAM=/path/to/protobuf.mjs node extensions/fast-context/protocol.selftest.ts
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ProtobufEncoder, connectFrameDecode, connectFrameEncode, decodeVarint, extractStrings } from "./protocol.ts";

// 1. Golden vectors — spec-derived protobuf varint/tag encoding.
{
	const v = new ProtobufEncoder().writeVarint(1, 300).toBuffer();
	assert.deepEqual([...v], [0x08, 0xac, 0x02], "varint field1=300");

	const s = new ProtobufEncoder().writeString(3, "hi").toBuffer();
	assert.deepEqual([...s], [0x1a, 0x02, 0x68, 0x69], "string field3='hi'");

	const b = new ProtobufEncoder().writeBytes(30, Buffer.from([0x00, 0x01])).toBuffer();
	assert.deepEqual([...b], [0xf2, 0x01, 0x02, 0x00, 0x01], "bytes field30");
}

// 2. Nested message + uncompressed Connect frame golden.
{
	const sub = new ProtobufEncoder().writeString(1, "hi");
	const msg = new ProtobufEncoder().writeVarint(1, 300).writeMessage(6, sub).toBuffer();
	assert.deepEqual([...msg], [0x08, 0xac, 0x02, 0x32, 0x04, 0x0a, 0x02, 0x68, 0x69], "nested message");

	const frame = connectFrameEncode(msg, false);
	assert.equal(frame[0], 0, "uncompressed flag");
	assert.equal(frame.readUInt32BE(1), msg.length, "frame length header");
	assert.deepEqual(connectFrameDecode(frame), [msg], "uncompressed frame round-trip");
}

// 3. Varint decode round-trip (skip the 1-byte tag).
for (const value of [0, 1, 127, 128, 300, 16384, 1 << 20, (1 << 28) - 1]) {
	const buf = new ProtobufEncoder().writeVarint(1, value).toBuffer();
	const [decoded, offset] = decodeVarint(buf, 1);
	assert.equal(decoded, value, `decodeVarint ${value}`);
	assert.equal(offset, buf.length, `decodeVarint offset ${value}`);
}

// 4. gzip Connect frame round-trip + flag.
{
	const msg = new ProtobufEncoder().writeString(3, "fast-context").toBuffer();
	const frame = connectFrameEncode(msg, true);
	assert.equal(frame[0], 1, "gzip flag");
	assert.deepEqual(connectFrameDecode(frame), [msg], "gzip frame round-trip");
}

// 5. extractStrings keeps long top-level strings, drops short ones.
{
	const msg = new ProtobufEncoder().writeString(3, "fast-context").writeString(4, "tiny").toBuffer();
	const strs = extractStrings(msg);
	assert.ok(strs.includes("fast-context"), "extractStrings finds long string");
	assert.ok(!strs.includes("tiny"), "extractStrings skips short string");
}

// 6. Optional dev-only parity against the upstream protobuf.mjs.
const upstream = process.env.FC_UPSTREAM;
if (upstream && existsSync(upstream)) {
	const up = await import(pathToFileURL(upstream).href);
	const build = (Enc: typeof ProtobufEncoder) => {
		const sub = new Enc().writeString(1, "hello-world");
		return new Enc()
			.writeVarint(2, 300)
			.writeString(3, "fast-context")
			.writeBytes(30, Buffer.from([0x00, 0x01]))
			.writeMessage(6, sub)
			.toBuffer();
	};
	const mine = build(ProtobufEncoder);
	const theirs = build(up.ProtobufEncoder);
	assert.deepEqual(mine, theirs, "encoder parity with upstream");
	assert.deepEqual(extractStrings(mine), up.extractStrings(mine), "extractStrings parity");
	assert.deepEqual(connectFrameDecode(connectFrameEncode(mine)), up.connectFrameDecode(up.connectFrameEncode(mine)), "frame parity");
	console.log("  + upstream parity verified");
}

console.log("OK protocol self-test passed");
