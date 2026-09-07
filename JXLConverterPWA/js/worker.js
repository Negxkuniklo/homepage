/**
 * JXL Converter Web Worker
 * Performs background extraction, Exif handling, and libjxl WASM encoding without freezing UI.
 */
/* global importScripts, ExifHandler, FrameExtractor, JXLEncoder */

try {
  importScripts('../lib/jxl_enc.js', 'exif_handler.js', 'frame_extractor.js', 'jxl_encoder.js');
} catch (e) {
  console.error("Worker importScripts error:", e);
}

self.onmessage = async function(e) {
  const data = e.data;
  const taskId = data.taskId;

  try {
    const file = data.file; // Blob / File or ArrayBuffer
    const fileName = data.fileName || 'image';
    const quality = data.quality !== undefined ? data.quality : 85;
    const updateExif = data.updateExif !== false;

    // Send initial progress
    self.postMessage({
      type: 'progress',
      taskId: taskId,
      percent: 5,
      status: 'ファイル解析中...'
    });

    const arrayBuffer = (file instanceof ArrayBuffer)
      ? file
      : await file.arrayBuffer();

    // 1. Extract and update Exif metadata
    let exifBox = null;
    let hasExif = false;
    try {
      const rawExif = ExifHandler.extractExifBuffer(arrayBuffer);
      if (rawExif && rawExif.length > 0) {
        hasExif = true;
        const updatedExif = updateExif ? ExifHandler.updateExifMetadata(rawExif) : rawExif;
        exifBox = ExifHandler.buildJxlExifBox(updatedExif);
      } else if (updateExif) {
        // Create default Exif with current date & ExifVersion 2.32
        const defExif = ExifHandler.createDefaultExifBuffer();
        exifBox = ExifHandler.buildJxlExifBox(defExif);
      }
    } catch (exifErr) {
      console.warn("Exif processing warning:", exifErr);
    }

    self.postMessage({
      type: 'progress',
      taskId: taskId,
      percent: 20,
      status: 'フレーム展開・画像デコード中...'
    });

    // 2. Extract frames (handles GIF, animated WebP, transparent PNG, JPEG)
    const blob = (file instanceof Blob) ? file : new Blob([arrayBuffer]);
    const extractedData = await FrameExtractor.extractFrames(blob, (p) => {
      self.postMessage({
        type: 'progress',
        taskId: taskId,
        percent: 20 + Math.round(p * 0.3), // 20% -> 35%
        status: `フレームデコード中 (${extractedData && extractedData.frames ? extractedData.frames.length : 1} フレーム)...`
      });
    });

    const isAnimated = extractedData.isAnimated || (extractedData.frames && extractedData.frames.length > 1);
    const frameCount = extractedData.frames ? extractedData.frames.length : 1;

    self.postMessage({
      type: 'progress',
      taskId: taskId,
      percent: 40,
      status: `JXLエンコード中 (${frameCount}フレーム, 品質 ${quality}%)...`
    });

    // 3. Encode to JXL
    const jxlBytes = await JXLEncoder.encode(extractedData, {
      quality: quality,
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

    // Transfer result back to main thread
    self.postMessage({
      type: 'complete',
      taskId: taskId,
      fileName: outFileName,
      originalName: fileName,
      originalSize: arrayBuffer.byteLength,
      jxlSize: jxlBytes.byteLength,
      isAnimated: isAnimated,
      frameCount: frameCount,
      hasExif: hasExif,
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
