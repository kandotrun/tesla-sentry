const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_PARSED_BOXES = 4096;
const MAX_BOX_DEPTH = 16;
const MAX_SAMPLE_DESCRIPTION_ENTRIES = 32;
const SUPPORTED_VIDEO_CODEC = /^(?:avc[1-4]|hvc[12]|hev[12])(?:\.|$)/i;
const ENCRYPTED_SAMPLE_ENTRIES = new Set(["enca", "encm", "encs", "enct", "encu", "encv"]);
const VISUAL_SAMPLE_ENTRY_PAYLOAD_BYTES = 78;

export type VideoPreflightCode =
  | "ready"
  | "empty_file"
  | "encrypted"
  | "unsupported_codec"
  | "missing_video_track"
  | "invalid_container"
  | "metadata_not_found";

export interface VideoMetadata {
  readonly codec: string | null;
  readonly durationSeconds: number | null;
  readonly encrypted: boolean;
  readonly height: number | null;
  readonly scannedBytes: number;
  readonly width: number | null;
}

export interface VideoPreflightResult extends VideoMetadata {
  readonly code: VideoPreflightCode;
}

export interface VideoPreflightOptions {
  readonly chunkBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly signal?: AbortSignal;
}

export interface PreflightRangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
}

interface BoxHeader {
  readonly contentStart: number;
  readonly end: number;
  readonly start: number;
  readonly type: string;
}

interface Timing {
  readonly duration: number | null;
  readonly timescale: number | null;
}

interface Dimensions {
  readonly height: number | null;
  readonly width: number | null;
}

interface MediaMetadata {
  readonly codec: string | null;
  readonly encrypted: boolean;
  readonly handler: string | null;
  readonly timing: Timing | null;
}

interface SampleDescriptionMetadata {
  readonly codec: string | null;
  readonly encrypted: boolean;
}

interface TrackMetadata {
  readonly dimensions: Dimensions | null;
  readonly media: MediaMetadata | null;
}

class InvalidContainerError extends Error {}
class MetadataBudgetError extends Error {}

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function emptyMetadata(scannedBytes: number): VideoMetadata {
  return {
    codec: null,
    durationSeconds: null,
    encrypted: false,
    height: null,
    scannedBytes,
    width: null,
  };
}

function emptyResult(code: VideoPreflightCode, scannedBytes: number): VideoPreflightResult {
  return { ...emptyMetadata(scannedBytes), code };
}

export function classifyVideoMetadata(metadata: VideoMetadata): VideoPreflightResult {
  if (!metadata.codec) {
    return { ...metadata, code: "missing_video_track" };
  }
  if (metadata.encrypted) {
    return { ...metadata, code: "encrypted" };
  }
  if (!SUPPORTED_VIDEO_CODEC.test(metadata.codec)) {
    return { ...metadata, code: "unsupported_codec" };
  }
  if (metadata.durationSeconds === null || metadata.width === null || metadata.height === null) {
    return { ...metadata, code: "metadata_not_found" };
  }
  return { ...metadata, code: "ready" };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(8, Math.floor(value));
}

function fourCc(bytes: Uint8Array): string {
  if (bytes.byteLength !== 4) {
    throw new InvalidContainerError("A fourcc must be four bytes");
  }
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
}

function printableFourCc(value: string): string | null {
  return /^[ -~]{4}$/.test(value) ? value : null;
}

function safeUint64(view: DataView, offset: number): number | null {
  const value = view.getBigUint64(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

class MetadataReader {
  readonly base: PreflightRangeReader;
  readonly chunkBytes: number;
  readonly maxBytes: number;
  readonly signal: AbortSignal | undefined;
  scannedBytes = 0;
  private cache = new Uint8Array(new ArrayBuffer(0));
  private cacheStart = 0;

  constructor(
    base: PreflightRangeReader,
    chunkBytes: number,
    maxBytes: number,
    signal?: AbortSignal,
  ) {
    this.base = base;
    this.chunkBytes = chunkBytes;
    this.maxBytes = maxBytes;
    this.signal = signal;
  }

  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    this.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1
    ) {
      throw new InvalidContainerError("Invalid byte range");
    }
    const requestedEnd = offset + length;
    if (!Number.isSafeInteger(requestedEnd) || requestedEnd > this.base.size) {
      throw new InvalidContainerError("Box data exceeds the file boundary");
    }

    const cacheEnd = this.cacheStart + this.cache.byteLength;
    if (offset >= this.cacheStart && requestedEnd <= cacheEnd) {
      return this.cache.subarray(offset - this.cacheStart, requestedEnd - this.cacheStart);
    }

    const remainingBudget = this.maxBytes - this.scannedBytes;
    if (remainingBudget < length) {
      throw new MetadataBudgetError("Metadata read budget exhausted");
    }
    const readLength = Math.min(this.chunkBytes, remainingBudget, this.base.size - offset);
    if (readLength < length) {
      throw new MetadataBudgetError("Metadata field does not fit within the read budget");
    }

    const chunk = await this.base.read(offset, readLength);
    this.signal?.throwIfAborted();
    this.scannedBytes += chunk.byteLength;
    this.cache = chunk;
    this.cacheStart = offset;
    if (this.cache.byteLength < length) {
      throw new InvalidContainerError("Truncated MP4 data");
    }
    return this.cache.subarray(0, length);
  }
}

class BlobRangeReader implements PreflightRangeReader {
  readonly blob: Blob;

  constructor(blob: Blob) {
    this.blob = blob;
  }

  get size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const buffer = await this.blob.slice(offset, offset + length).arrayBuffer();
    return new Uint8Array(buffer);
  }
}

class BoxTraversal {
  boxCount = 0;

  enter(depth: number): void {
    if (depth > MAX_BOX_DEPTH) {
      throw new InvalidContainerError("MP4 box nesting is too deep");
    }
    this.boxCount += 1;
    if (this.boxCount > MAX_PARSED_BOXES) {
      throw new InvalidContainerError("MP4 contains too many boxes");
    }
  }
}

async function readBoxHeader(
  reader: MetadataReader,
  traversal: BoxTraversal,
  start: number,
  parentEnd: number,
  depth: number,
): Promise<BoxHeader> {
  traversal.enter(depth);
  if (parentEnd - start < 8) {
    throw new InvalidContainerError("Truncated MP4 box header");
  }

  const base = await reader.read(start, 8);
  const baseView = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const size32 = baseView.getUint32(0);
  const type = fourCc(base.subarray(4, 8));
  let contentStart = start + 8;
  let size: number;

  if (size32 === 1) {
    if (parentEnd - start < 16) {
      throw new InvalidContainerError("Truncated extended MP4 box header");
    }
    const extended = await reader.read(start, 16);
    const extendedView = new DataView(extended.buffer, extended.byteOffset, extended.byteLength);
    const size64 = safeUint64(extendedView, 8);
    if (size64 === null) {
      throw new InvalidContainerError("MP4 box size exceeds the safe integer range");
    }
    size = size64;
    contentStart = start + 16;
  } else if (size32 === 0) {
    if (depth !== 0) {
      throw new InvalidContainerError("A nested MP4 box cannot extend to end-of-file");
    }
    size = reader.base.size - start;
  } else {
    size = size32;
  }

  const headerBytes = contentStart - start;
  if (size < headerBytes) {
    throw new InvalidContainerError("MP4 box is smaller than its header");
  }
  const end = start + size;
  if (!Number.isSafeInteger(end) || end > parentEnd) {
    throw new InvalidContainerError("MP4 box exceeds its parent boundary");
  }
  return { contentStart, end, start, type };
}

type BoxVisitor = (box: BoxHeader, depth: number) => Promise<void>;

async function visitChildren(
  reader: MetadataReader,
  traversal: BoxTraversal,
  parent: BoxHeader,
  depth: number,
  visitor: BoxVisitor,
): Promise<void> {
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = await readBoxHeader(reader, traversal, offset, parent.end, depth);
    if (child.end <= offset) {
      throw new InvalidContainerError("MP4 box traversal did not advance");
    }
    await visitor(child, depth);
    offset = child.end;
  }
}

async function parseTiming(reader: MetadataReader, box: BoxHeader): Promise<Timing> {
  const payloadBytes = box.end - box.contentStart;
  if (payloadBytes < 20) {
    throw new InvalidContainerError("Timing box is truncated");
  }
  const versionBytes = await reader.read(box.contentStart, 1);
  const version = versionBytes[0];
  if (version === 0) {
    const fields = await reader.read(box.contentStart + 12, 8);
    const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
    return { duration: view.getUint32(4), timescale: view.getUint32(0) };
  }
  if (version === 1) {
    if (payloadBytes < 32) {
      throw new InvalidContainerError("Version 1 timing box is truncated");
    }
    const fields = await reader.read(box.contentStart + 20, 12);
    const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
    return { duration: safeUint64(view, 4), timescale: view.getUint32(0) };
  }
  throw new InvalidContainerError("Unsupported timing box version");
}

async function parseDimensions(reader: MetadataReader, box: BoxHeader): Promise<Dimensions> {
  const payloadBytes = box.end - box.contentStart;
  if (payloadBytes < 1) {
    throw new InvalidContainerError("Track header is truncated");
  }
  const versionBytes = await reader.read(box.contentStart, 1);
  const version = versionBytes[0];
  const minimumPayload = version === 0 ? 84 : version === 1 ? 96 : null;
  if (minimumPayload === null || payloadBytes < minimumPayload) {
    throw new InvalidContainerError("Track header has an invalid version or size");
  }
  const fields = await reader.read(box.end - 8, 8);
  const view = new DataView(fields.buffer, fields.byteOffset, fields.byteLength);
  return {
    height: finitePositive(view.getUint32(4) / 65_536),
    width: finitePositive(view.getUint32(0) / 65_536),
  };
}

async function parseHandler(reader: MetadataReader, box: BoxHeader): Promise<string> {
  if (box.end - box.contentStart < 12) {
    throw new InvalidContainerError("Handler box is truncated");
  }
  return fourCc(await reader.read(box.contentStart + 8, 4));
}

function requiredCodecConfiguration(sampleType: string): string | null {
  if (/^avc[1-4]$/i.test(sampleType)) {
    return "avcC";
  }
  if (/^(?:hvc[12]|hev[12])$/i.test(sampleType)) {
    return "hvcC";
  }
  return null;
}

async function validateVideoSampleEntry(
  reader: MetadataReader,
  traversal: BoxTraversal,
  entry: BoxHeader,
  sampleType: string,
  depth: number,
): Promise<void> {
  if (entry.end - entry.contentStart < VISUAL_SAMPLE_ENTRY_PAYLOAD_BYTES) {
    throw new InvalidContainerError("Video sample entry is undersized");
  }

  const requiredConfiguration = requiredCodecConfiguration(sampleType);
  let foundRequiredConfiguration = requiredConfiguration === null;
  let offset = entry.contentStart + VISUAL_SAMPLE_ENTRY_PAYLOAD_BYTES;
  while (offset < entry.end) {
    const child = await readBoxHeader(reader, traversal, offset, entry.end, depth);
    if (child.type === requiredConfiguration) {
      foundRequiredConfiguration = true;
    }
    offset = child.end;
  }
  if (!foundRequiredConfiguration) {
    throw new InvalidContainerError("Supported video sample entry lacks codec configuration");
  }
}

async function parseSampleDescriptions(
  reader: MetadataReader,
  traversal: BoxTraversal,
  box: BoxHeader,
  depth: number,
): Promise<SampleDescriptionMetadata> {
  if (box.end - box.contentStart < 8) {
    throw new InvalidContainerError("Sample description box is truncated");
  }
  const header = await reader.read(box.contentStart, 8);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0) !== 0) {
    throw new InvalidContainerError("Sample description full-box header is invalid");
  }
  const entryCount = view.getUint32(4);
  if (entryCount > MAX_SAMPLE_DESCRIPTION_ENTRIES) {
    throw new InvalidContainerError("Sample description count exceeds the hard limit");
  }
  if (entryCount === 0) {
    return { codec: null, encrypted: false };
  }

  let offset = box.contentStart + 8;
  let encrypted = false;
  let firstType: string | null = null;
  let firstUnsupportedType: string | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = await readBoxHeader(reader, traversal, offset, box.end, depth);
    const sampleType = printableFourCc(entry.type);
    if (!sampleType) {
      throw new InvalidContainerError("Video sample entry type is invalid");
    }
    await validateVideoSampleEntry(reader, traversal, entry, sampleType, depth + 1);
    const entryIsEncrypted = ENCRYPTED_SAMPLE_ENTRIES.has(sampleType.toLowerCase());
    encrypted ||= entryIsEncrypted;
    if (!entryIsEncrypted && !SUPPORTED_VIDEO_CODEC.test(sampleType)) {
      firstUnsupportedType ??= sampleType;
    }
    firstType ??= sampleType;
    offset = entry.end;
  }
  if (offset !== box.end) {
    throw new InvalidContainerError("Sample description entries do not fill their box");
  }
  return { codec: firstUnsupportedType ?? firstType, encrypted };
}

async function parseSampleTable(
  reader: MetadataReader,
  traversal: BoxTraversal,
  box: BoxHeader,
  depth: number,
): Promise<SampleDescriptionMetadata> {
  let descriptions: SampleDescriptionMetadata = { codec: null, encrypted: false };
  await visitChildren(reader, traversal, box, depth, async (child, childDepth) => {
    if (child.type === "stsd") {
      descriptions = await parseSampleDescriptions(reader, traversal, child, childDepth + 1);
    }
  });
  return descriptions;
}

async function parseMediaInformation(
  reader: MetadataReader,
  traversal: BoxTraversal,
  box: BoxHeader,
  depth: number,
): Promise<SampleDescriptionMetadata> {
  let descriptions: SampleDescriptionMetadata = { codec: null, encrypted: false };
  await visitChildren(reader, traversal, box, depth, async (child, childDepth) => {
    if (child.type === "stbl") {
      descriptions = await parseSampleTable(reader, traversal, child, childDepth + 1);
    }
  });
  return descriptions;
}

async function parseMedia(
  reader: MetadataReader,
  traversal: BoxTraversal,
  box: BoxHeader,
  depth: number,
): Promise<MediaMetadata> {
  let handler: string | null = null;
  let mediaInformation: BoxHeader | null = null;
  let timing: Timing | null = null;
  await visitChildren(reader, traversal, box, depth, async (child) => {
    if (child.type === "mdhd") {
      timing = await parseTiming(reader, child);
    } else if (child.type === "hdlr") {
      handler = await parseHandler(reader, child);
    } else if (child.type === "minf") {
      mediaInformation = child;
    }
  });

  const descriptions =
    handler === "vide" && mediaInformation
      ? await parseMediaInformation(reader, traversal, mediaInformation, depth + 1)
      : { codec: null, encrypted: false };
  return {
    codec: descriptions.codec,
    encrypted: descriptions.encrypted,
    handler,
    timing,
  };
}

async function parseTrack(
  reader: MetadataReader,
  traversal: BoxTraversal,
  box: BoxHeader,
  depth: number,
): Promise<TrackMetadata> {
  let dimensions: Dimensions | null = null;
  let media: MediaMetadata | null = null;
  await visitChildren(reader, traversal, box, depth, async (child, childDepth) => {
    if (child.type === "tkhd") {
      dimensions = await parseDimensions(reader, child);
    } else if (child.type === "mdia") {
      media = await parseMedia(reader, traversal, child, childDepth + 1);
    }
  });
  return { dimensions, media };
}

function durationSeconds(trackTiming: Timing | null, movieTiming: Timing | null): number | null {
  const timing = trackTiming?.timescale ? trackTiming : movieTiming;
  if (!timing?.timescale || timing.duration === null) {
    return null;
  }
  return finitePositive(timing.duration / timing.timescale);
}

async function parseMovie(
  reader: MetadataReader,
  traversal: BoxTraversal,
  moov: BoxHeader,
): Promise<VideoMetadata> {
  let movieTiming: Timing | null = null;
  const tracks: TrackMetadata[] = [];
  await visitChildren(reader, traversal, moov, 1, async (child, childDepth) => {
    if (child.type === "mvhd") {
      movieTiming = await parseTiming(reader, child);
    } else if (child.type === "trak") {
      tracks.push(await parseTrack(reader, traversal, child, childDepth + 1));
    }
  });

  if (!movieTiming || tracks.length === 0) {
    throw new InvalidContainerError("Movie metadata is structurally incomplete");
  }
  const videoTrack = tracks.find((track) => track.media?.handler === "vide");
  if (!videoTrack) {
    return emptyMetadata(reader.scannedBytes);
  }

  const codec = videoTrack.media?.codec ?? null;
  return {
    codec,
    durationSeconds: durationSeconds(videoTrack.media?.timing ?? null, movieTiming),
    encrypted: videoTrack.media?.encrypted ?? false,
    height: videoTrack.dimensions?.height ?? null,
    scannedBytes: reader.scannedBytes,
    width: videoTrack.dimensions?.width ?? null,
  };
}

async function locateAndParseMovie(
  reader: MetadataReader,
  traversal: BoxTraversal,
): Promise<VideoMetadata | null> {
  let offset = 0;
  while (offset < reader.base.size) {
    const box = await readBoxHeader(reader, traversal, offset, reader.base.size, 0);
    if (box.type === "moov") {
      return parseMovie(reader, traversal, box);
    }
    if (box.end <= offset) {
      throw new InvalidContainerError("Top-level MP4 box traversal did not advance");
    }
    offset = box.end;
  }
  return null;
}

export async function preflightRangeReader(
  base: PreflightRangeReader,
  options: VideoPreflightOptions = {},
): Promise<VideoPreflightResult> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!Number.isFinite(base.size) || base.size < 0 || !Number.isSafeInteger(base.size)) {
    throw new InvalidContainerError("Reader size is invalid");
  }
  if (base.size === 0) {
    return emptyResult("empty_file", 0);
  }

  const chunkBytes = Math.min(
    positiveInteger(options.chunkBytes, DEFAULT_CHUNK_BYTES),
    DEFAULT_CHUNK_BYTES,
  );
  const maxMetadataBytes = Math.min(
    positiveInteger(options.maxMetadataBytes, MAX_METADATA_BYTES),
    MAX_METADATA_BYTES,
  );
  const reader = new MetadataReader(base, chunkBytes, maxMetadataBytes, signal);

  try {
    const metadata = await locateAndParseMovie(reader, new BoxTraversal());
    signal?.throwIfAborted();
    if (!metadata) {
      return emptyResult("metadata_not_found", reader.scannedBytes);
    }
    return classifyVideoMetadata({ ...metadata, scannedBytes: reader.scannedBytes });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof MetadataBudgetError) {
      return emptyResult("metadata_not_found", reader.scannedBytes);
    }
    return emptyResult("invalid_container", reader.scannedBytes);
  }
}

export async function preflightMp4(
  blob: Blob,
  options: VideoPreflightOptions = {},
): Promise<VideoPreflightResult> {
  return preflightRangeReader(new BlobRangeReader(blob), options);
}
