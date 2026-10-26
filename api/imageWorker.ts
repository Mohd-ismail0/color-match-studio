import { parentPort, workerData } from 'node:worker_threads';
import type { ColorMatrix } from '../src/types/colorCorrector';
import { processImageBuffer, ImageError } from './imagePipeline';

interface WorkerInput {
  buffer: ArrayBuffer;
  matrix: ColorMatrix;
}

const input = workerData as WorkerInput;

(async () => {
  try {
    const result = await processImageBuffer(Buffer.from(input.buffer), input.matrix);
    const png = result.png;
    const transferable = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
    parentPort?.postMessage(
      {
        ok: true,
        png: transferable,
        info: {
          width: result.width,
          height: result.height,
          pixels: result.pixels,
          bitDepth: result.bitDepth,
          sourceFormat: result.sourceFormat,
        },
      },
      [transferable as ArrayBuffer]
    );
  } catch (error) {
    const code = error instanceof ImageError ? error.code : 'IMAGE_INVALID';
    const message = error instanceof Error ? error.message : 'Image processing failed';
    parentPort?.postMessage({ ok: false, code, message });
  }
})();
