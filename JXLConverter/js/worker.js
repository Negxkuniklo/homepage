/**
 * JXL Converter Web Worker
 * Performs background WASM JXL encoding using pre-decoded or worker-decoded image data.
 */
/* global importScripts, ExifHandler, FrameExtractor, JXLEncoder */

// Configure Emscripten locateFile before importing jxl_enc.js
self.Module = {
  locateFile: function(path) {
    if (path.endsWith('.wasm')) {
      try {
        return new URL('../lib/jxl_enc.wasm', self.location.href).href;
      } catch(e) {
        return 'jxl_enc.wasm';
      }
    }
    return path;
  }
};

try {
  importScripts('../lib/jxl_enc.js', 'exif_handler.js', 'frame_extractor.js', 'jxl_encoder.js');
} catch (e) {
  console.error("Worker importScripts error:", e);
}

self.onmessage = async function(e) {
  const data = e.data;
  const taskId = data.taskId;

  try {
    const fileName = data.fileName || 'image';
    const isLossless = data.isLossless === true || data.quality >= 100;
    const quality = isLossless ? 100 : (data.quality !== undefined ? data.quality : 85);
    const updateExif = true;

    self.postMessage({
      type: 'progress',
      taskId: taskId,
      percent: 10,
      status: 'Exif解析中...'
    });

    // 1. Exif metadata handling
    let exifBox = null;
    let hasExif = false;
    const rawArrayBuffer = data.rawArrayBuffer || (data.file ? await data.file.arrayBuffer() : null);

    if (rawArrayBuffer) {
      try {
        const rawExif = ExifHandler.extractExifBuffer(rawArrayBuffer);
        if (rawExif && rawExif.length > 0) {
          hasExif = true;
          const updatedExif = ExifHandler.updateExifMetadata(rawExif);
          exifBox = ExifHandler.buildJxlExifBox(updatedExif);
        } else {
          // Default Exif with current date & version
          const defExif = ExifHandler.createDefaultExifBuffer();
          exifBox = ExifHandler.buildJxlExifBox(defExif);
        }
      } catch (exifErr) {
        console.warn("Exif processing warning:", exifErr);
      }
    }

    // 2. Obtain extracted frames (either passed from main thread or decoded here)
    let extractedData = null;

    if (data.extractedData && data.extractedData.frames && data.extractedData.frames.length > 0) {
      // Received pre-decoded frames from main thread
      extractedData = {
        width: data.extractedData.width,
        height: data.extractedData.height,
        isAnimated: data.extractedData.isAnimated,
        frames: data.extractedData.frames.map(f => ({
          imageData: {
            width: f.width,
            height: f.height,
            data: new Uint8ClampedArray(f.rgbaBuffer)
          },
          delayMs: f.delayMs || 100
        }))
      };
    } else {
      // Decode in worker
      self.postMessage({
        type: 'progress',
        taskId: taskId,
        percent: 25,
        status: '画像フレーム展開中...'
      });

      const blob = data.file || new Blob([rawArrayBuffer]);
      extractedData = await FrameExtractor.extractFrames(blob, (p) => {
        self.postMessage({
          type: 'progress',
          taskId: taskId,
          percent: 20 + Math.round(p * 0.3),
          status: 'フレームデコード中...'
        });
      });
    }

    if (!extractedData || !extractedData.frames || extractedData.frames.length === 0) {
      throw new Error("画像データの展開に失敗しました。");
    }

    const isAnimated = extractedData.isAnimated || extractedData.frames.length > 1;
    const frameCount = extractedData.frames.length;
    const modeText = isLossless ? '可逆(Lossless)' : `非可逆(${quality}%)`;

    self.postMessage({
      type: 'progress',
      taskId: taskId,
      percent: 40,
      status: `JXLエンコード中 [${modeText}, ${frameCount}フレーム]...`
    });

    // 3. Encode to JXL via WASM
    const jxlBytes = await JXLEncoder.encode(extractedData, {
      quality: quality,
      lossless: isLossless,
      exifBox: exifBox,
      onProgress: (p) => {
        self.postMessage({
          type: 'progress',
          taskId: taskId,
          percent: 40 + Math.round((p - 50) * 1.1), // 40% -> 95%
          status: `JXLエンコード中 (${Math.round(p)}%)...`
        });
      }
    }, '../');

    self.postMessage({
      type: 'progress',
      taskId: taskId,
      percent: 100,
      status: '変換完了'
    });

    // Determine output file name: replace extension with .jxl
    let baseName = fileName;
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot !== -1) {
      baseName = fileName.substring(0, lastDot);
    }
    const outFileName = `${baseName}.jxl`;
    const originalSize = rawArrayBuffer ? rawArrayBuffer.byteLength : (data.fileSize || 0);

    // Transfer result back to main thread
    self.postMessage({
      type: 'complete',
      taskId: taskId,
      fileName: outFileName,
      originalName: fileName,
      originalSize: originalSize,
      jxlSize: jxlBytes.byteLength,
      isAnimated: isAnimated,
      frameCount: frameCount,
      hasExif: hasExif,
      isLossless: isLossless,
      width: extractedData.width,
      height: extractedData.height,
      jxlBytes: jxlBytes.buffer
    }, [jxlBytes.buffer]);

  } catch (error) {
    console.error("Worker conversion error:", error);
    self.postMessage({
      type: 'error',
      taskId: taskId,
      error: error.message || String(error)
    });
  }
};
