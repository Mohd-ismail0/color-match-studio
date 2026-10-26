import sharp, { type Metadata, type OutputInfo } from 'sharp';
import type { ColorMatrix } from '../src/types/colorCorrector';
import { IMAGE_LIMITS } from '../src/lib/calibrationLimits';
import { applyMatrixToRgba8, applyMatrixToRgba16 } from '../src/lib/colorMath';
import { encodePng16 } from './png16';
import { assessMatrix, validateColorMatrix } from '../src/lib/matrixValidation';

export type ImageErrorCode =
  | 'IMAGE_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TYPE_UNSUPPORTED'
  | 'IMAGE_DEPTH_UNSUPPORTED'
  | 'MATRIX_REJECTED';

export class ImageError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode, message: string) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

export interface ProcessedImage {
  png: Buffer;
  width: number;
  height: number;
  pixels: number;
  bitDepth: 8 | 16;
  sourceFormat: string;
}

const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp', 'tiff']);

function assertMatrix(matrix: ColorMatrix): void {
  const validation = validateColorMatrix(matrix);
  if (!validation.ok) {
    throw new ImageError('MATRIX_REJECTED', validation.errors.join('; '));
  }
  const assessment = assessMatrix(matrix);
  if (assessment.destructive) {
    throw new ImageError(
      'MATRIX_REJECTED',
      `Calibration would destroy colour data (${assessment.reasons.join('; ')})`
    );
  }
}

/**
 * Decode → sRGB → matrix in linear light → PNG. Preserves 16-bit depth when
 * the source is 16-bit, preserves alpha, and tags the output as sRGB (audit C9).
 */
export async function processImageBuffer(
  input: Buffer,
  matrix: ColorMatrix
): Promise<ProcessedImage> {
  if (input.length === 0) throw new ImageError('IMAGE_INVALID', 'Empty image payload');
  if (input.length > IMAGE_LIMITS.maxInputBytes) {
    throw new ImageError('IMAGE_TOO_LARGE', 'Image exceeds the input byte limit');
  }
  assertMatrix(matrix);

  let metadata: Metadata;
  try {
    metadata = await sharp(input, {
      limitInputPixels: IMAGE_LIMITS.maxPixels,
      animated: false,
    }).metadata();
  } catch {
    throw new ImageError('IMAGE_INVALID', 'Could not decode image');
  }

  const format = metadata.format ?? 'unknown';
  if (!ALLOWED_FORMATS.has(format)) {
    throw new ImageError('IMAGE_TYPE_UNSUPPORTED', `Unsupported image format: ${format}`);
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!(width > 0) || !(height > 0)) {
    throw new ImageError('IMAGE_INVALID', 'Image has no usable dimensions');
  }
  const pixels = width * height;
  if (pixels > IMAGE_LIMITS.maxPixels || width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension) {
    throw new ImageError('IMAGE_TOO_LARGE', 'Image exceeds the pixel/dimension limit');
  }

  const bit16 = metadata.depth === 'ushort';
  if (bit16 && pixels > IMAGE_LIMITS.max16BitPixels) {
    throw new ImageError('IMAGE_TOO_LARGE', '16-bit image exceeds the 16-bit pixel budget');
  }

  let raw: Buffer;
  let info: OutputInfo;
  try {
    const base = sharp(input, {
      limitInputPixels: IMAGE_LIMITS.maxPixels,
      animated: false,
    }).rotate();

    if (bit16) {
      ({ data: raw, info } = await base
        .toColourspace('rgb16')
        .ensureAlpha()
        .raw({ depth: 'ushort' })
        .toBuffer({ resolveWithObject: true }));
    } else {
      ({ data: raw, info } = await base
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }));
    }
  } catch {
    throw new ImageError('IMAGE_INVALID', 'Could not decode image pixels');
  }

  if (info.channels !== 4) {
    throw new ImageError('IMAGE_INVALID', `Unexpected channel count: ${info.channels}`);
  }

  if (bit16) {
    if ((info as OutputInfo & { depth?: string }).depth !== 'ushort' || raw.length !== info.width * info.height * info.channels * 2) {
      throw new ImageError('IMAGE_DEPTH_UNSUPPORTED', '16-bit decode did not return 16-bit samples');
    }
    // Copy into an aligned Uint16Array (raw 16-bit data is little-endian).
    const copy = Buffer.from(raw);
    const pixels16 = new Uint16Array(copy.buffer, copy.byteOffset, copy.length / 2);
    applyMatrixToRgba16(pixels16, matrix);
    const png = encodePng16(info.width, info.height, pixels16);
    return {
      png,
      width: info.width,
      height: info.height,
      pixels: info.width * info.height,
      bitDepth: 16,
      sourceFormat: format,
    };
  }

  applyMatrixToRgba8(raw, matrix);
  const png = await sharp(raw, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .withIccProfile('srgb')
    .png({ compressionLevel: 6, adaptiveFiltering: false })
    .toBuffer();

  return {
    png,
    width: info.width,
    height: info.height,
    pixels: info.width * info.height,
    bitDepth: 8,
    sourceFormat: format,
  };
}
