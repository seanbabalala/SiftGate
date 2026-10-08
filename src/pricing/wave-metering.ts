import { ExactDecimal } from "./exact-decimal";

/** PCM RIFF/WAVE header measurement only. Never decode, save, or inspect sample content. */
export function pcmWaveSeconds(bytes: Buffer): string | null {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    return null;
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 12) return null;
  let sampleRate: number | undefined;
  let blockAlign: number | undefined;
  let dataBytes = 0;
  let foundData = false;
  for (let offset = 12, chunks = 0; offset < end; chunks++) {
    if (chunks >= 256 || offset + 8 > end) return null;
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) return null;
    if (name === "fmt ") {
      if (
        sampleRate !== undefined ||
        size < 16 ||
        bytes.readUInt16LE(start) !== 1
      )
        return null;
      const channels = bytes.readUInt16LE(start + 2);
      const rate = bytes.readUInt32LE(start + 4);
      const byteRate = bytes.readUInt32LE(start + 8);
      const align = bytes.readUInt16LE(start + 12);
      const bits = bytes.readUInt16LE(start + 14);
      if (
        !channels ||
        channels > 32 ||
        !rate ||
        ![8, 16].includes(bits) ||
        align !== (channels * bits) / 8 ||
        byteRate !== rate * align
      )
        return null;
      sampleRate = rate;
      blockAlign = align;
    } else if (name === "data") {
      dataBytes += size;
      foundData = true;
    }
    offset = start + size + (size % 2);
    if (offset > end) return null;
  }
  if (!sampleRate || !blockAlign || !foundData || dataBytes % blockAlign !== 0)
    return null;
  return ExactDecimal.parse(String(dataBytes / blockAlign))
    .divide(ExactDecimal.parse(String(sampleRate)))
    .toFixed(18);
}
