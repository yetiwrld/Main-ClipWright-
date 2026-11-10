/**
 * CRC-32, as zip requires it (ISO/IEC 19566-5, the same polynomial as PNG and Ethernet).
 *
 * A zip entry without a correct checksum is a corrupt file to every reader, and no amount of
 * "it unzips fine on my machine" makes a wrong one acceptable — `unzip -t` and Windows
 * Explorer both verify it. So this is implemented rather than approximated, and the tests
 * check it against the published check values and against a real `unzip`.
 *
 * The table is built once at module load: 256 entries, each a byte shifted through the
 * polynomial eight times.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      // 0xedb88320 is the reversed form of the 0x04c11db7 polynomial.
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The checksum of `data`, as an unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  /*
    The running value starts at all ones and is inverted at the end — the two steps that make
    this CRC-32 rather than a plain polynomial division. Both are part of the format, not a
    quirk: a reader that omits either produces a number no other implementation agrees with.
  */
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    value = TABLE[(value ^ data[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
