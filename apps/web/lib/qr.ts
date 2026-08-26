/* ------------------------------------------------------------------ *
 * A minimal QR encoder, for exactly one job: the TOTP enrolment code.
 *
 * The panel is self-hosted and self-contained — it loads no CDN, and it
 * must never send an `otpauth://` URI (which carries the shared secret)
 * to a third-party chart service to be rendered. That rules out every
 * hosted QR generator, so the encoder lives here.
 *
 * Deliberately narrow: byte mode, error correction level M, versions 1
 * to 9. That covers 182 bytes, and an otpauth URI is well under half of
 * that, so nothing here needs the 16-bit character counts or the second
 * alignment-pattern regime that larger versions bring.
 *
 * The structure follows ISO/IEC 18004 directly: encode, error-correct,
 * interleave, place, mask, score.
 * ------------------------------------------------------------------ */

export interface QrMatrix {
  size: number;
  /** `modules[y][x]` — true is a dark module. */
  modules: boolean[][];
}

/** Block structure per version at error correction level M. */
interface VersionSpec {
  ecPerBlock: number;
  group1: number;
  data1: number;
  group2: number;
  data2: number;
}

const VERSIONS: readonly VersionSpec[] = [
  { ecPerBlock: 10, group1: 1, data1: 16, group2: 0, data2: 0 },
  { ecPerBlock: 16, group1: 1, data1: 28, group2: 0, data2: 0 },
  { ecPerBlock: 26, group1: 1, data1: 44, group2: 0, data2: 0 },
  { ecPerBlock: 18, group1: 2, data1: 32, group2: 0, data2: 0 },
  { ecPerBlock: 24, group1: 2, data1: 43, group2: 0, data2: 0 },
  { ecPerBlock: 16, group1: 4, data1: 27, group2: 0, data2: 0 },
  { ecPerBlock: 18, group1: 4, data1: 31, group2: 0, data2: 0 },
  { ecPerBlock: 22, group1: 2, data1: 38, group2: 2, data2: 39 },
  { ecPerBlock: 22, group1: 3, data1: 36, group2: 2, data2: 37 },
];

/** Alignment-pattern centre coordinates, indexed by version - 1. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ------------------------------ GF(256) ---------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial coefficients, descending degree, leading 1 omitted. */
function rsCoefficients(degree: number): Uint8Array {
  const coef = new Uint8Array(degree);
  coef[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      coef[j] = mul(coef[j]!, root);
      if (j + 1 < degree) coef[j] = coef[j]! ^ coef[j + 1]!;
    }
    root = mul(root, 0x02);
  }
  return coef;
}

function rsRemainder(data: Uint8Array, coef: Uint8Array): Uint8Array {
  const result = new Uint8Array(coef.length);
  for (const byte of data) {
    const factor = byte ^ result[0]!;
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) result[i] = result[i]! ^ mul(coef[i]!, factor);
  }
  return result;
}

/* --------------------------- bit assembly -------------------------- */

function bitAt(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function dataCapacity(spec: VersionSpec): number {
  return spec.group1 * spec.data1 + spec.group2 * spec.data2;
}

/**
 * Mode indicator, 8-bit character count, payload, terminator and the
 * alternating 0xEC/0x11 pad bytes, as one codeword array.
 */
function buildCodewords(payload: Uint8Array, spec: VersionSpec): Uint8Array {
  const capacity = dataCapacity(spec);
  const bits: boolean[] = [];

  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push(bitAt(value, i));
  };

  push(0b0100, 4);
  push(payload.length, 8);
  for (const byte of payload) push(byte, 8);

  const capacityBits = capacity * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(false);
  while (bits.length % 8 !== 0) bits.push(false);

  const codewords = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) codewords[i >>> 3] = codewords[i >>> 3]! | (0x80 >>> (i & 7));
  }
  for (let i = bits.length / 8, pad = 0xec; i < capacity; i += 1, pad ^= 0xec ^ 0x11) {
    codewords[i] = pad;
  }
  return codewords;
}

/** Splits into blocks, appends error correction, and interleaves both. */
function interleave(codewords: Uint8Array, spec: VersionSpec): Uint8Array {
  const counts: number[] = [];
  for (let i = 0; i < spec.group1; i += 1) counts.push(spec.data1);
  for (let i = 0; i < spec.group2; i += 1) counts.push(spec.data2);

  const coef = rsCoefficients(spec.ecPerBlock);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (const count of counts) {
    const block = codewords.subarray(offset, offset + count);
    offset += count;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, coef));
  }

  const out: number[] = [];
  const widest = Math.max(...counts);
  for (let i = 0; i < widest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

/* --------------------------- module layout ------------------------- */

class Canvas {
  readonly size: number;
  readonly modules: boolean[][];
  /** Function patterns are never masked and never carry data. */
  private readonly reserved: boolean[][];

  constructor(private readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      Array.from({ length: this.size }, () => false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      Array.from({ length: this.size }, () => false),
    );
  }

  private set(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  isReserved(x: number, y: number): boolean {
    return this.reserved[y]![x]!;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }

    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const centres = ALIGNMENT[this.version - 1]!;
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = 0; j < centres.length; j += 1) {
        // The three corners already hold finder patterns.
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === centres.length - 1) ||
          (i === centres.length - 1 && j === 0);
        if (!corner) this.drawAlignment(centres[i]!, centres[j]!);
      }
    }

    this.drawFormat(0);
    this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Error correction level M is `00`; the 15 bits are BCH(15,5) coded. */
  drawFormat(mask: number): void {
    const data = (0b00 << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;

    for (let i = 0; i <= 5; i += 1) this.set(8, i, bitAt(bits, i));
    this.set(8, 7, bitAt(bits, 6));
    this.set(8, 8, bitAt(bits, 7));
    this.set(7, 8, bitAt(bits, 8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bitAt(bits, i));

    for (let i = 0; i < 8; i += 1) this.set(this.size - 1 - i, 8, bitAt(bits, i));
    for (let i = 8; i < 15; i += 1) this.set(8, this.size - 15 + i, bitAt(bits, i));
    this.set(8, this.size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;

    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | remainder;

    for (let i = 0; i < 18; i += 1) {
      const dark = bitAt(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** Upward-then-downward zigzag from the bottom right, skipping column 6. */
  drawCodewords(data: Uint8Array): void {
    let index = 0;
    const total = data.length * 8;

    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let column = 0; column < 2; column += 1) {
          const x = right - column;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (this.isReserved(x, y) || index >= total) continue;
          this.modules[y]![x] = bitAt(data[index >>> 3]!, 7 - (index & 7));
          index += 1;
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.isReserved(x, y)) continue;
        if (maskAt(mask, x, y)) this.modules[y]![x] = !this.modules[y]![x]!;
      }
    }
  }

  penalty(): number {
    let score = 0;
    let dark = 0;

    for (let y = 0; y < this.size; y += 1) {
      let runColor = this.modules[y]![0]!;
      let run = 1;
      let bits = 0;
      for (let x = 0; x < this.size; x += 1) {
        const module = this.modules[y]![x]!;
        if (module) dark += 1;

        if (x > 0) {
          if (module !== runColor) {
            runColor = module;
            run = 1;
          } else {
            run += 1;
            if (run === 5) score += PENALTY_N1;
            else if (run > 5) score += 1;
          }
        }

        bits = ((bits << 1) & 0x7ff) | (module ? 1 : 0);
        if (x >= 10 && (bits === 0x05d || bits === 0x5d0)) score += PENALTY_N3;
      }
    }

    for (let x = 0; x < this.size; x += 1) {
      let runColor = this.modules[0]![x]!;
      let run = 1;
      let bits = 0;
      for (let y = 0; y < this.size; y += 1) {
        const module = this.modules[y]![x]!;

        if (y > 0) {
          if (module !== runColor) {
            runColor = module;
            run = 1;
          } else {
            run += 1;
            if (run === 5) score += PENALTY_N1;
            else if (run > 5) score += 1;
          }
        }

        bits = ((bits << 1) & 0x7ff) | (module ? 1 : 0);
        if (y >= 10 && (bits === 0x05d || bits === 0x5d0)) score += PENALTY_N3;
      }
    }

    for (let y = 0; y < this.size - 1; y += 1) {
      for (let x = 0; x < this.size - 1; x += 1) {
        const color = this.modules[y]![x]!;
        if (
          color === this.modules[y]![x + 1]! &&
          color === this.modules[y + 1]![x]! &&
          color === this.modules[y + 1]![x + 1]!
        ) {
          score += PENALTY_N2;
        }
      }
    }

    const total = this.size * this.size;
    const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return score + Math.max(0, deviation) * PENALTY_N4;
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/* ------------------------------ public ----------------------------- */

/**
 * Returns the module matrix, or null when the payload does not fit the
 * supported versions. Callers render the matrix themselves — an SVG of
 * rects, so it stays crisp at any size and inherits the theme.
 */
export function encodeQr(text: string): QrMatrix | null {
  const payload = new TextEncoder().encode(text);

  const index = VERSIONS.findIndex((spec) => 4 + 8 + payload.length * 8 <= dataCapacity(spec) * 8);
  if (index === -1) return null;

  const spec = VERSIONS[index]!;
  const version = index + 1;
  const interleaved = interleave(buildCodewords(payload, spec), spec);

  const canvas = new Canvas(version);
  canvas.drawFunctionPatterns();
  canvas.drawCodewords(interleaved);

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    canvas.applyMask(mask);
    canvas.drawFormat(mask);
    const penalty = canvas.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    // Masking is its own inverse, so the canvas returns to the raw
    // placement before the next candidate is measured.
    canvas.applyMask(mask);
  }

  canvas.applyMask(bestMask);
  canvas.drawFormat(bestMask);

  return { size: canvas.size, modules: canvas.modules };
}
