/**
 * FrameExtractor - Robust frame & metadata extractor for JPEG, PNG, GIF, WebP
 * Works seamlessly across Desktop, Mobile (Android/iOS), Chrome, Firefox, Safari.
 */
(function(global) {
  'use strict';

  /**
   * Decompresses LZW for GIF fallback
   */
  function decompressLZW(bytes, pos, minCodeSize, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const eofCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let mask = (1 << codeSize) - 1;

    const dictionary = [];
    function resetDict() {
      dictionary.length = 0;
      for (let i = 0; i < clearCode; i++) {
        dictionary[i] = [i];
      }
      dictionary[clearCode] = [];
      dictionary[eofCode] = null;
    }
    resetDict();

    const output = new Uint8Array(pixelCount);
    let outIdx = 0;
    let bitBuf = 0;
    let bitLen = 0;
    let prevCode = -1;

    while (pos < bytes.length) {
      const subBlockLen = bytes[pos++];
      if (subBlockLen === 0) break;

      for (let i = 0; i < subBlockLen; i++) {
        bitBuf |= (bytes[pos++] << bitLen);
        bitLen += 8;

        while (bitLen >= codeSize) {
          const code = bitBuf & mask;
          bitBuf >>= codeSize;
          bitLen -= codeSize;

          if (code === clearCode) {
            codeSize = minCodeSize + 1;
            mask = (1 << codeSize) - 1;
            resetDict();
            prevCode = -1;
            continue;
          }
          if (code === eofCode) {
            pos = bytes.length;
            break;
          }

          let entry;
          if (code < dictionary.length) {
            entry = dictionary[code];
          } else if (code === dictionary.length && prevCode !== -1) {
            entry = dictionary[prevCode].concat(dictionary[prevCode][0]);
          } else {
            continue;
          }

          for (let j = 0; j < entry.length && outIdx < pixelCount; j++) {
            output[outIdx++] = entry[j];
          }

          if (prevCode !== -1 && dictionary.length < 4096) {
            dictionary.push(dictionary[prevCode].concat(entry[0]));
            if (dictionary.length === (1 << codeSize) && codeSize < 12) {
              codeSize++;
              mask = (1 << codeSize) - 1;
            }
          }
          prevCode = code;
        }
      }
    }

    return { data: output, nextPos: pos };
  }

  /**
   * Fallback GIF parser
   */
  function parseGIFFallback(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 13) throw new Error("Invalid GIF file size");

    const sig = String.fromCharCode.apply(null, bytes.subarray(0, 6));
    if (sig !== "GIF87a" && sig !== "GIF89a") {
      throw new Error("Not a valid GIF signature");
    }

    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    const gctFlag = (bytes[10] & 0x80) !== 0;
    const gctSize = 1 << ((bytes[10] & 0x07) + 1);

    let pos = 13;
    let globalPalette = null;
    if (gctFlag) {
      globalPalette = bytes.subarray(pos, pos + gctSize * 3);
      pos += gctSize * 3;
    }

    const frames = [];
    let delayMs = 100;
    let transparentIndex = -1;

    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(width, height)
      : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    
    if (!canvas) throw new Error("Canvas is not supported in this environment");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    while (pos < bytes.length) {
      const blockType = bytes[pos++];
      if (blockType === 0x3B) break; // Trailer

      if (blockType === 0x21) {
        const extType = bytes[pos++];
        if (extType === 0xF9) {
          const blockSize = bytes[pos++];
          const flags = bytes[pos];
          const hasTransparent = (flags & 0x01) !== 0;
          const delay = bytes[pos + 1] | (bytes[pos + 2] << 8);
          delayMs = delay > 0 ? delay * 10 : 100;
          transparentIndex = hasTransparent ? bytes[pos + 3] : -1;
          pos += blockSize;
          while (bytes[pos] !== 0) pos += bytes[pos] + 1;
          pos++;
        } else {
          while (pos < bytes.length && bytes[pos] !== 0) {
            pos += bytes[pos] + 1;
          }
          pos++;
        }
      } else if (blockType === 0x2C) {
        const left = bytes[pos] | (bytes[pos + 1] << 8);
        const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
        const frameWidth = bytes[pos + 4] | (bytes[pos + 5] << 8);
        const frameHeight = bytes[pos + 6] | (bytes[pos + 7] << 8);
        const flags = bytes[pos + 8];
        pos += 9;

        const lctFlag = (flags & 0x80) !== 0;
        const lctSize = 1 << ((flags & 0x07) + 1);
        let activePalette = globalPalette;
        if (lctFlag) {
          activePalette = bytes.subarray(pos, pos + lctSize * 3);
          pos += lctSize * 3;
        }

        const lzwMinCodeSize = bytes[pos++];
        const pixelIndices = decompressLZW(bytes, pos, lzwMinCodeSize, frameWidth * frameHeight);
        pos = pixelIndices.nextPos;

        const frameImgData = ctx.createImageData(frameWidth, frameHeight);
        const dest = frameImgData.data;
        for (let i = 0; i < pixelIndices.data.length; i++) {
          const idx = pixelIndices.data[i];
          const outIdx = i * 4;
          if (idx === transparentIndex) {
            dest[outIdx] = 0;
            dest[outIdx + 1] = 0;
            dest[outIdx + 2] = 0;
            dest[outIdx + 3] = 0;
          } else if (activePalette && idx * 3 + 2 < activePalette.length) {
            dest[outIdx] = activePalette[idx * 3];
            dest[outIdx + 1] = activePalette[idx * 3 + 1];
            dest[outIdx + 2] = activePalette[idx * 3 + 2];
            dest[outIdx + 3] = 255;
          }
        }

        ctx.putImageData(frameImgData, left, top);
        const compositeData = ctx.getImageData(0, 0, width, height);

        frames.push({
          imageData: compositeData,
          delayMs: delayMs
        });
      }
    }

    if (frames.length === 0) {
      throw new Error("No frames decoded from GIF");
    }

    return {
      width: width,
      height: height,
      isAnimated: frames.length > 1,
      frames: frames
    };
  }

  /**
   * Main extractor function
   * Supports animated GIF, animated/still WebP, PNG, JPEG
   * Returns: { width, height, isAnimated, frames: [{ imageData, delayMs }] }
   */
  async function extractFrames(blob, onProgress) {
    let mimeType = blob.type || '';
    const arrayBuffer = await blob.arrayBuffer();

    // Detect format by magic bytes if mimeType is missing or generic
    const u8 = new Uint8Array(arrayBuffer, 0, 12);
    if (!mimeType || mimeType === 'application/octet-stream') {
      if (u8[0] === 0xFF && u8[1] === 0xD8) mimeType = 'image/jpeg';
      else if (u8[0] === 0x89 && u8[1] === 0x50) mimeType = 'image/png';
      else if (u8[0] === 0x47 && u8[1] === 0x49) mimeType = 'image/gif';
      else if (u8[0] === 0x52 && u8[8] === 0x57) mimeType = 'image/webp';
    }

    const isGif = (mimeType === 'image/gif') || (u8[0] === 0x47 && u8[1] === 0x49);
    const isWebp = (mimeType === 'image/webp') || (u8[0] === 0x52 && u8[8] === 0x57);

    // Strategy 1: Modern WebCodecs ImageDecoder for Animated formats (GIF, WebP)
    if (typeof ImageDecoder !== 'undefined' && (isGif || isWebp)) {
      try {
        const decoder = new ImageDecoder({
          data: new Uint8Array(arrayBuffer),
          type: mimeType || (isGif ? 'image/gif' : 'image/webp'),
          premultiplyAlpha: 'none'
        });

        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        const frameCount = (track && track.frameCount) ? track.frameCount : 1;
        const isAnimated = track ? track.animated : false;

        const frames = [];
        let width = 0;
        let height = 0;
        let canvas = null;
        let ctx = null;

        for (let i = 0; i < frameCount; i++) {
          const decodeResult = await decoder.decode({ frameIndex: i });
          const videoFrame = decodeResult.image;

          if (i === 0) {
            width = videoFrame.displayWidth || videoFrame.codedWidth || videoFrame.width;
            height = videoFrame.displayHeight || videoFrame.codedHeight || videoFrame.height;
            canvas = (typeof OffscreenCanvas !== 'undefined')
              ? new OffscreenCanvas(width, height)
              : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
            if (!canvas) throw new Error("Canvas not supported");
            canvas.width = width;
            canvas.height = height;
            ctx = canvas.getContext('2d', { willReadFrequently: true });
          }

          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(videoFrame, 0, 0, width, height);
          const imgData = ctx.getImageData(0, 0, width, height);

          let delayMs = 100;
          if (videoFrame.duration !== undefined && videoFrame.duration > 0) {
            delayMs = Math.round(videoFrame.duration / 1000);
          } else if (decodeResult.duration !== undefined && decodeResult.duration > 0) {
            delayMs = Math.round(decodeResult.duration / 1000);
          }

          if (typeof videoFrame.close === 'function') {
            videoFrame.close();
          }

          frames.push({
            imageData: imgData,
            delayMs: delayMs || 100
          });

          if (onProgress) {
            onProgress(Math.round(((i + 1) / frameCount) * 50));
          }
        }

        if (frames.length > 0) {
          return {
            width: width,
            height: height,
            isAnimated: isAnimated || frames.length > 1,
            frames: frames
          };
        }
      } catch (decoderErr) {
        console.warn("WebCodecs ImageDecoder failed, trying fallback:", decoderErr);
      }
    }

    // Strategy 2: GIF Fallback parser
    if (isGif) {
      try {
        return parseGIFFallback(arrayBuffer);
      } catch (gifErr) {
        console.warn("GIF Fallback parser failed:", gifErr);
      }
    }

    // Strategy 3: Standard createImageBitmap for Still images (JPEG, PNG, WebP, etc.)
    if (typeof createImageBitmap === 'function') {
      try {
        let bitmap;
        try {
          bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
        } catch (e1) {
          try {
            bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
          } catch (e2) {
            bitmap = await createImageBitmap(blob);
          }
        }

        const width = bitmap.width;
        const height = bitmap.height;
        const canvas = (typeof OffscreenCanvas !== 'undefined')
          ? new OffscreenCanvas(width, height)
          : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
        
        if (!canvas) throw new Error("Canvas is unavailable");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, width, height);

        if (typeof bitmap.close === 'function') {
          bitmap.close();
        }

        return {
          width: width,
          height: height,
          isAnimated: false,
          frames: [{
            imageData: imageData,
            delayMs: 100
          }]
        };
      } catch (bitmapErr) {
        console.warn("createImageBitmap failed, trying Image element fallback:", bitmapErr);
      }
    }

    // Strategy 4: HTML Image element fallback (if document is available)
    if (typeof document !== 'undefined') {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = (e) => reject(new Error("Image element failed to load blob"));
          img.src = url;
        });

        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, width, height);

        return {
          width: width,
          height: height,
          isAnimated: false,
          frames: [{
            imageData: imageData,
            delayMs: 100
          }]
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    throw new Error("画像のデコードに失敗しました。対応していない画像形式か、ブラウザの制限です。");
  }

  const FrameExtractor = {
    extractFrames: extractFrames,
    parseGIFFallback: parseGIFFallback
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FrameExtractor;
  } else {
    global.FrameExtractor = FrameExtractor;
  }
})(typeof self !== 'undefined' ? self : this);
