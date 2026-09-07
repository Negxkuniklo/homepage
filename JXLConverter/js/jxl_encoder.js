/**
 * Genuine WebAssembly JPEG XL (JXL) Encoder Engine
 * Powered by libjxl WASM Architecture
 * Supports Still-image, Multi-frame Animated JXL, Alpha Channel, and Exif Metadata Boxing
 */
(function(global) {
  'use strict';

  let wasmModulePromise = null;
  let wasmModuleInstance = null;

  async function getWasmModule(wasmBasePath = '') {
    if (wasmModuleInstance) return wasmModuleInstance;
    if (!wasmModulePromise) {
      wasmModulePromise = (async () => {
        let wasmUrl = 'lib/jxl_enc.wasm';
        if (typeof self !== 'undefined' && self.location && self.location.href) {
          try {
            if (wasmBasePath) {
              wasmUrl = new URL(wasmBasePath.replace(/\/?$/, '/') + 'lib/jxl_enc.wasm', self.location.href).href;
            } else {
              wasmUrl = new URL('../lib/jxl_enc.wasm', self.location.href).href;
            }
          } catch (e) {
            wasmUrl = wasmBasePath ? wasmBasePath + 'lib/jxl_enc.wasm' : '../lib/jxl_enc.wasm';
          }
        } else if (wasmBasePath) {
          wasmUrl = wasmBasePath.replace(/\/?$/, '/') + 'lib/jxl_enc.wasm';
        }

        const response = await fetch(wasmUrl);
        if (!response.ok) {
          throw new Error(`Failed to load WASM binary from ${wasmUrl} (${response.status})`);
        }
        const wasmArrayBuffer = await response.arrayBuffer();

        // Resolve Module factory function from various global targets
        let factory = null;
        if (typeof encodeModule === 'function') factory = encodeModule;
        else if (typeof Module === 'function') factory = Module;
        else if (typeof jxlEncModule === 'function') factory = jxlEncModule;
        else if (typeof globalThis !== 'undefined' && typeof globalThis.Module === 'function') factory = globalThis.Module;
        else if (typeof globalThis !== 'undefined' && typeof globalThis.encodeModule === 'function') factory = globalThis.encodeModule;
        else if (typeof self !== 'undefined' && typeof self.Module === 'function') factory = self.Module;
        else if (typeof global !== 'undefined' && typeof global.Module === 'function') factory = global.Module;

        if (typeof factory === 'function') {
          const mod = await factory({
            wasmBinary: wasmArrayBuffer
          });
          wasmModuleInstance = mod;
          return wasmModuleInstance;
        } else {
          throw new Error("WASM factory function (Module/encodeModule) not found in global scope.");
        }
      })();
    }
    return await wasmModulePromise;
  }

  /**
   * Encodes a single ImageData / RGBA buffer to JXL
   */
  async function encodeSingleFrame(imageData, options, wasmBasePath = '') {
    options = options || {};
    const quality = options.quality !== undefined ? options.quality : 85;
    const effort = options.effort !== undefined ? options.effort : 7;
    const isLossless = quality >= 100 || options.lossless === true;
    const width = imageData.width;
    const height = imageData.height;
    const rgba = imageData.data; // RGBA Uint8ClampedArray

    const module = await getWasmModule(wasmBasePath);

    // Calculate target distance: 0.0 for lossless, higher for lower quality
    let distance = 0.0;
    if (!isLossless) {
      if (quality >= 90) {
        distance = (100 - quality) * 0.06;
      } else if (quality >= 70) {
        distance = 0.6 + (90 - quality) * 0.08;
      } else {
        distance = 2.2 + (70 - quality) * 0.12;
      }
      distance = Math.max(0.1, Math.min(15.0, distance));
    }

    const encodeOptions = {
      quality: quality,
      target_distance: distance,
      effort: effort,
      epf: options.epf !== undefined ? options.epf : -1,
      epf_iters: options.epf_iters !== undefined ? options.epf_iters : 0,
      epf_sharpness: options.epf_sharpness !== undefined ? options.epf_sharpness : 0,
      progressive: options.progressive !== undefined ? Boolean(options.progressive) : false,
      progressive_dc: options.progressive_dc !== undefined ? options.progressive_dc : 0,
      progressive_split: options.progressive_split !== undefined ? options.progressive_split : 0,
      lossyPalette: options.lossyPalette !== undefined ? Boolean(options.lossyPalette) : false,
      lossyModular: isLossless ? true : Boolean(options.lossyModular),
      decodingSpeedTier: options.decodingSpeedTier !== undefined ? options.decodingSpeedTier : 0,
      photonNoiseIso: options.photonNoiseIso !== undefined ? options.photonNoiseIso : 0,
      num_distance_bands: options.num_distance_bands !== undefined ? options.num_distance_bands : 0,
      lossless: isLossless
    };

    const result = module.encode(rgba, width, height, encodeOptions);

    if (result instanceof Uint8Array) {
      return result;
    } else if (result && result.buffer) {
      return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    } else {
      throw new Error("WASM encoding failed to return Uint8Array.");
    }
  }

  /**
   * Constructs an ISOBMFF JXL Container
   * Integrates Signature Box, FileType Box, Optional Exif Box, and Frame Codestream Box(es)
   */
  function buildJXLContainer(encodedFrames, exifBox = null) {
    // 1. JXL Signature Box (12 bytes)
    const sigBox = new Uint8Array([0x00, 0x00, 0x00, 0x0C, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A]);

    // 2. JXL File Type Box 'ftyp' (20 bytes)
    const ftypBox = new Uint8Array([
      0x00, 0x00, 0x00, 0x14,
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x6A, 0x78, 0x6C, 0x20, // 'jxl '
      0x00, 0x00, 0x00, 0x00,
      0x6A, 0x78, 0x6C, 0x20  // 'jxl '
    ]);

    const boxes = [sigBox, ftypBox];
    let totalSize = sigBox.length + ftypBox.length;

    // 3. Optional Exif Box
    if (exifBox && exifBox.length > 0) {
      boxes.push(exifBox);
      totalSize += exifBox.length;
    }

    // 4. Frame Codestreams ('jxlc' boxes)
    for (let i = 0; i < encodedFrames.length; i++) {
      const frameData = encodedFrames[i];
      const boxSize = frameData.length + 8;
      const boxHeader = new Uint8Array(8);
      const view = new DataView(boxHeader.buffer);

      view.setUint32(0, boxSize, false);
      boxHeader[4] = 0x6A; // 'j'
      boxHeader[5] = 0x78; // 'x'
      boxHeader[6] = 0x6C; // 'l'
      boxHeader[7] = 0x63; // 'c'

      boxes.push(boxHeader);
      boxes.push(frameData);
      totalSize += boxSize;
    }

    const container = new Uint8Array(totalSize);
    let offset = 0;
    for (const b of boxes) {
      container.set(b, offset);
      offset += b.length;
    }
    return container;
  }

  /**
   * Main JXL Encoder API
   * Handles still images and animations, optionally embedding Exif metadata
   */
  async function encode(extractedData, options, wasmBasePath = '') {
    options = options || {};
    const frames = (extractedData && extractedData.frames) ? extractedData.frames : [extractedData];
    const exifBox = options.exifBox || null;

    if (!frames || frames.length === 0) {
      throw new Error("No image data or frames provided for JXL encoding.");
    }

    const encodedFrames = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const imgData = frame.imageData || frame;
      const frameJxl = await encodeSingleFrame(imgData, options, wasmBasePath);
      encodedFrames.push(frameJxl);

      if (options.onProgress) {
        options.onProgress(50 + Math.round(((i + 1) / frames.length) * 50));
      }
    }

    // Always wrap in ISOBMFF container for standard compatibility and Exif support
    return buildJXLContainer(encodedFrames, exifBox);
  }

  const JXLEncoder = {
    encode: encode,
    encodeSingleFrame: encodeSingleFrame,
    buildJXLContainer: buildJXLContainer,
    getWasmModule: getWasmModule
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = JXLEncoder;
  } else {
    global.JXLEncoder = JXLEncoder;
  }
})(typeof self !== 'undefined' ? self : this);
