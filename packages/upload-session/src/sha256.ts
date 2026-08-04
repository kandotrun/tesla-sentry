/**
 * 依存なしのincremental SHA-256実装。
 *
 * - ブラウザ: `crypto.subtle.digest`は非ストリーミングのため、大きなFileを
 *   メモリに溜めずにチャンク単位でハッシュできる。
 * - workerd: miniflareローカル開発には`DigestStream`が公開されていないため、
 *   R2上の大きなオブジェクトをストリーミングハッシュする必要がある。
 * 環境差を吸収して同じコードが動く。参照: FIPS 180-4。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class StreamingSha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalLength = 0;
  private readonly w = new Uint32Array(64);

  update(chunk: Uint8Array): void {
    let offset = 0;
    this.totalLength += chunk.byteLength;
    while (offset < chunk.byteLength) {
      const take = Math.min(64 - this.bufferLength, chunk.byteLength - offset);
      this.buffer.set(chunk.subarray(offset, offset + take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  digestHex(): string {
    const bitLength = this.totalLength * 8;
    // Padding: 0x80, then zeros, then 64-bit big-endian length.
    const pad = new Uint8Array(64);
    pad[0] = 0x80;
    const remainder = this.bufferLength;
    // Number of zero bytes needed so that the final 8 bytes hold the length.
    const zeros = (55 - remainder + 64) % 64;
    this.update(pad.subarray(0, 1));
    if (zeros > 0) {
      this.update(new Uint8Array(zeros));
    }
    const lengthBytes = new Uint8Array(8);
    const view = new DataView(lengthBytes.buffer);
    view.setUint32(0, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(4, bitLength >>> 0, false);
    this.update(lengthBytes);

    let hex = "";
    for (let i = 0; i < 8; i += 1) {
      hex += (this.state[i] ?? 0).toString(16).padStart(8, "0");
    }
    return hex;
  }

  private compress(block: Uint8Array): void {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
      const s1 = rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = this.state[0] ?? 0;
    let b = this.state[1] ?? 0;
    let c = this.state[2] ?? 0;
    let d = this.state[3] ?? 0;
    let e = this.state[4] ?? 0;
    let f = this.state[5] ?? 0;
    let g = this.state[6] ?? 0;
    let h = this.state[7] ?? 0;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
    this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
    this.state[5] = ((this.state[5] ?? 0) + f) >>> 0;
    this.state[6] = ((this.state[6] ?? 0) + g) >>> 0;
    this.state[7] = ((this.state[7] ?? 0) + h) >>> 0;
  }
}

function rotr(value: number, amount: number): number {
  return ((value >>> amount) | (value << (32 - amount))) >>> 0;
}
