import { BackgroundGraphic } from '../data/backgrounds';
import { SpriteBitmap } from '../data/sprites';
import { ZX_FONT } from '../data/zxFont';

export const ZX_WIDTH = 256;
export const ZX_HEIGHT = 192;
export const ZX_BORDER = 32;
export const CANVAS_WIDTH = ZX_WIDTH + ZX_BORDER * 2; // 320
export const CANVAS_HEIGHT = ZX_HEIGHT + ZX_BORDER * 2; // 256

// Authentic 16-colour ZX Spectrum ULA Palette (8 normal + 8 bright) as 32-bit ABGR (little-endian RGBA)
const PALETTE_RGBA: readonly [number, number, number][] = [
  // Normal (BRIGHT = 0)
  [0x00, 0x00, 0x00], // 0 Black
  [0x00, 0x00, 0xd7], // 1 Blue
  [0xd7, 0x00, 0x00], // 2 Red
  [0xd7, 0x00, 0xd7], // 3 Magenta
  [0x00, 0xd7, 0x00], // 4 Green
  [0x00, 0xd7, 0xd7], // 5 Cyan
  [0xd7, 0xd7, 0x00], // 6 Yellow
  [0xd7, 0xd7, 0xd7], // 7 White
  // Bright (BRIGHT = 1)
  [0x00, 0x00, 0x00], // 8 Bright Black
  [0x00, 0x00, 0xff], // 9 Bright Blue
  [0xff, 0x00, 0x00], // 10 Bright Red
  [0xff, 0x00, 0xff], // 11 Bright Magenta
  [0x00, 0xff, 0x00], // 12 Bright Green
  [0x00, 0xff, 0xff], // 13 Bright Cyan
  [0xff, 0xff, 0x00], // 14 Bright Yellow
  [0xff, 0xff, 0xff], // 15 Bright White
];

const PALETTE_U32 = new Uint32Array(
  PALETTE_RGBA.map(([r, g, b]) => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0)
);

export class ZXScreen {
  public readonly pixels = new Uint8Array(32 * 192);
  public readonly attrs = new Uint8Array(32 * 24);
  public borderColour = 0; // 0..7
  public flashInverted = false;
  private frameCounter = 0;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly buf32: Uint32Array;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not initialize 2D canvas context');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.imageData = this.ctx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
    this.buf32 = new Uint32Array(this.imageData.data.buffer);
  }

  public tickFlash(): void {
    this.frameCounter = (this.frameCounter + 1) & 0x1f;
    this.flashInverted = (this.frameCounter & 0x10) !== 0;
  }

  /** Load a standard 6912-byte ZX Spectrum SCREEN$ ($4000-$5AFF) */
  public loadScr(scr: Uint8Array): void {
    for (let offset = 0; offset < 6144; offset++) {
      const y = ((offset >> 5) & 0xc0) | ((offset >> 8) & 0x07) | ((offset >> 2) & 0x38);
      const col = offset & 0x1f;
      this.pixels[y * 32 + col] = scr[offset];
    }
    this.attrs.set(scr.subarray(6144, 6912));
  }

  /** Full screen clear + banner attribute setup ($9964-$9978) */
  public initScreenAndBannerAttrs(): void {
    this.pixels.fill(0x00);
    this.attrs.fill(0x40); // Bright black paper, black ink
    // Row 0 ($5800..$581F): $47 (bright white on black)
    this.attrs.fill(0x47, 0, 32);
    // Row 1 ($5820..$583F): $46 (bright yellow on black)
    this.attrs.fill(0x46, 32, 64);
  }

  /** Clear play area pixels & attributes (rows 2..23, Y = 16..191) ($BB5C & $BB7C) */
  public clearPlayArea(): void {
    this.pixels.fill(0x00, 16 * 32);
    this.attrs.fill(0x40, 2 * 32);
  }

  /** Clear central menu/Hall of Fame panel ($B2D8): col 4..27 (width 24), row 5..20 (height 16) */
  public clearPanel(): void {
    for (let row = 5; row < 21; row++) {
      for (let col = 4; col < 28; col++) {
        this.attrs[row * 32 + col] = 0x00;
      }
    }
    for (let y = 40; y < 168; y++) {
      for (let col = 4; col < 28; col++) {
        this.pixels[y * 32 + col] = 0x00;
      }
    }
  }

  /** Draw a background graphic stamp ($BC0B): inverted pixels (byte ^ 0xFF) + attributes */
  public drawStamp(bg: BackgroundGraphic, x: number, y: number, useAltAttrs = false): void {
    const startCol = (x & 0xff) >> 3;
    let pIdx = 0;
    for (let py = 0; py < bg.heightPixels; py++) {
      const sy = y + py;
      if (sy >= 0 && sy < ZX_HEIGHT) {
        const rowOff = sy * 32;
        for (let bx = 0; bx < bg.widthBytes; bx++) {
          const col = startCol + bx;
          if (col >= 0 && col < 32) {
            this.pixels[rowOff + col] = bg.pixels[pIdx] ^ 0xff;
          }
          pIdx++;
        }
      } else {
        pIdx += bg.widthBytes;
      }
    }

    const attrSrc = useAltAttrs && bg.attrs2 ? bg.attrs2 : bg.attrs1;
    const attrRow = (y & 0xff) >> 3;
    let aIdx = 0;
    for (let ay = 0; ay < bg.attrHeight; ay++) {
      const ar = attrRow + ay;
      if (ar >= 0 && ar < 24) {
        const rowOff = ar * 32;
        for (let ax = 0; ax < bg.attrWidth; ax++) {
          const ac = startCol + ax;
          if (ac >= 0 && ac < 32) {
            this.attrs[rowOff + ac] = attrSrc[aIdx];
          }
          aIdx++;
        }
      } else {
        aIdx += bg.attrWidth;
      }
    }
  }

  /** XOR a sprite onto the 1-bit pixel buffer ($B9A9). y is the bottom pixel row! */
  public xorSprite(sprite: SpriteBitmap, x: number, y: number): void {
    if (sprite.widthBytes === 0 || sprite.heightPixels === 0) return;
    const startCol = (x & 0xff) >> 3;
    const shift = x & 7;
    let idx = 0;

    for (let r = 0; r < sprite.heightPixels; r++) {
      const py = y - r;
      if (py >= 0 && py < ZX_HEIGHT) {
        const rowOff = py * 32;
        if (shift === 0) {
          for (let bx = 0; bx < sprite.widthBytes; bx++) {
            const c0 = startCol + bx;
            if (c0 >= 0 && c0 < 32) {
              this.pixels[rowOff + c0] ^= sprite.data[idx];
            }
            idx++;
          }
        } else {
          for (let bx = 0; bx < sprite.widthBytes; bx++) {
            const b = sprite.data[idx++];
            const c0 = startCol + bx;
            if (c0 >= 0 && c0 < 32) {
              this.pixels[rowOff + c0] ^= b >>> shift;
            }
            const c1 = c0 + 1;
            if (c1 >= 0 && c1 < 32) {
              this.pixels[rowOff + c1] ^= (b << (8 - shift)) & 0xff;
            }
          }
        }
      } else {
        idx += sprite.widthBytes;
      }
    }
  }

  /**
   * Colour attribute cells covered by an actor ($BB24 / $BB45).
   * Only writes `colour` into cells whose PAPER is black ((attr & 0x38) === 0),
   * reproducing authentic Ultimate foliage foreground masking and ZX attribute clash!
   */
  public colourEntity(
    x: number,
    y: number,
    widthBytes: number,
    heightPixels: number,
    colour: number,
    forceCols?: number
  ): void {
    if (heightPixels <= 0) return;
    const cols = forceCols ?? widthBytes + ((x & 7) !== 0 ? 1 : 0);
    const a = (~y) & 7;
    const rows = ((a + heightPixels - 1) >> 3) + 1;
    const startCol = (x & 0xff) >> 3;
    const startRow = (y & 0xff) >> 3;

    this.colourRows(startCol, startRow, cols, rows, colour);
  }

  /** Low-level upward row attribute writer ($BB45) */
  public colourRows(startCol: number, startRow: number, cols: number, rows: number, colour: number): void {
    for (let r = 0; r < rows; r++) {
      const ar = startRow - r;
      if (ar < 0 || ar >= 24) continue;
      const rowOff = ar * 32;
      for (let c = 0; c < cols; c++) {
        const ac = startCol + c;
        if (ac >= 0 && ac < 32) {
          if ((this.attrs[rowOff + ac] & 0x38) === 0) {
            this.attrs[rowOff + ac] = colour;
          }
        }
      }
    }
  }

  /** Write an 8x8 glyph directly at character column `col` and pixel row `yPx` ($B599) */
  public printGlyph(glyph: Uint8Array, glyphOffset: number, col: number, yPx: number): void {
    if (col < 0 || col >= 32) return;
    for (let i = 0; i < 8; i++) {
      const py = yPx + i;
      if (py >= 0 && py < ZX_HEIGHT) {
        this.pixels[py * 32 + col] = glyph[glyphOffset + i];
      }
    }
  }

  /** Print a single ZX ASCII character (0x20..0x7F) at (col, yPx) without changing attributes ($B589) */
  public printCharAtCol(charCode: number, col: number, yPx: number): void {
    const code = Math.max(0x20, Math.min(0x7f, charCode & 0x7f));
    this.printGlyph(ZX_FONT, (code - 0x20) * 8, col, yPx);
  }

  /** Print a string with its attribute at pixel coordinates (xPx, yPx), supporting sub-column pixel centering */
  public printColourString(xPx: number, yPx: number, attr: number, text: string): void {
    const shift = xPx & 7;
    const attrRow = (yPx & 0xff) >> 3;
    if (shift === 0) {
      let col = (xPx & 0xff) >> 3;
      for (let i = 0; i < text.length; i++) {
        if (col >= 32) break;
        const code = text.charCodeAt(i) & 0x7f;
        this.printCharAtCol(code, col, yPx);
        if (attrRow >= 0 && attrRow < 24) {
          this.attrs[attrRow * 32 + col] = attr & 0xff;
        }
        col++;
      }
      return;
    }

    const startCol = Math.max(0, (xPx & 0xff) >> 3);
    const endCol = Math.min(31, ((xPx + text.length * 8 - 1) & 0xff) >> 3);
    for (let r = 0; r < 8; r++) {
      const py = yPx + r;
      if (py < 0 || py >= ZX_HEIGHT) continue;
      for (let c = startCol; c <= endCol; c++) {
        this.pixels[py * 32 + c] = 0x00;
      }
    }
    if (attrRow >= 0 && attrRow < 24) {
      for (let c = startCol; c <= endCol; c++) {
        this.attrs[attrRow * 32 + c] = attr & 0xff;
      }
    }

    for (let i = 0; i < text.length; i++) {
      const px = xPx + i * 8;
      const c0 = px >> 3;
      if (c0 >= 32) break;
      const code = Math.max(0x20, Math.min(0x7f, text.charCodeAt(i) & 0x7f));
      const glyphOff = (code - 0x20) * 8;
      for (let r = 0; r < 8; r++) {
        const py = yPx + r;
        if (py < 0 || py >= ZX_HEIGHT) continue;
        const g = ZX_FONT[glyphOff + r];
        if (c0 >= 0) {
          this.pixels[py * 32 + c0] |= g >>> shift;
        }
        if (c0 + 1 >= 0 && c0 + 1 < 32) {
          this.pixels[py * 32 + c0 + 1] |= (g << (8 - shift)) & 0xff;
        }
      }
    }
  }

  /** Render the 256x192 ULA screen + 32px border to the HTMLCanvasElement */
  public render(overrideBorderColour?: number): void {
    const borderCol = PALETTE_U32[(overrideBorderColour ?? this.borderColour) & 0x07];
    const buf = this.buf32;

    // Top border
    buf.fill(borderCol, 0, ZX_BORDER * CANVAS_WIDTH);
    // Bottom border
    buf.fill(borderCol, (ZX_BORDER + ZX_HEIGHT) * CANVAS_WIDTH, CANVAS_HEIGHT * CANVAS_WIDTH);

    const flashInv = this.flashInverted;
    for (let y = 0; y < ZX_HEIGHT; y++) {
      const dstRow = (y + ZX_BORDER) * CANVAS_WIDTH;
      // Left & right border strips
      buf.fill(borderCol, dstRow, dstRow + ZX_BORDER);
      buf.fill(borderCol, dstRow + ZX_BORDER + ZX_WIDTH, dstRow + CANVAS_WIDTH);

      const pixRow = y * 32;
      const attrRow = (y >> 3) * 32;
      let dst = dstRow + ZX_BORDER;

      for (let col = 0; col < 32; col++) {
        const pByte = this.pixels[pixRow + col];
        const attr = this.attrs[attrRow + col];
        const bright = (attr & 0x40) !== 0 ? 8 : 0;
        let ink = (attr & 0x07) + bright;
        let paper = ((attr >> 3) & 0x07) + bright;

        if ((attr & 0x80) !== 0 && flashInv) {
          const tmp = ink;
          ink = paper;
          paper = tmp;
        }

        const inkU32 = PALETTE_U32[ink];
        const paperU32 = PALETTE_U32[paper];

        buf[dst] = (pByte & 0x80) !== 0 ? inkU32 : paperU32;
        buf[dst + 1] = (pByte & 0x40) !== 0 ? inkU32 : paperU32;
        buf[dst + 2] = (pByte & 0x20) !== 0 ? inkU32 : paperU32;
        buf[dst + 3] = (pByte & 0x10) !== 0 ? inkU32 : paperU32;
        buf[dst + 4] = (pByte & 0x08) !== 0 ? inkU32 : paperU32;
        buf[dst + 5] = (pByte & 0x04) !== 0 ? inkU32 : paperU32;
        buf[dst + 6] = (pByte & 0x02) !== 0 ? inkU32 : paperU32;
        buf[dst + 7] = (pByte & 0x01) !== 0 ? inkU32 : paperU32;
        dst += 8;
      }
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }
}
