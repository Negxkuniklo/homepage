/**
 * ExifHandler - Metadata extraction, selective update, and JXL Exif box serialization
 * Supports JPEG (APP1), PNG (eXIf chunk), WebP (EXIF chunk)
 */
(function(global) {
  'use strict';

  /**
   * Formats a Date object to Exif DateTime format "YYYY:MM:DD HH:MM:SS"
   */
  function formatExifDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `${y}:${m}:${d} ${h}:${min}:${s}`;
  }

  /**
   * Extracts raw TIFF/Exif bytes from various image file formats
   */
  function extractExifBuffer(fileArrayBuffer) {
    const view = new DataView(fileArrayBuffer);
    const bytes = new Uint8Array(fileArrayBuffer);
    const len = bytes.length;

    // 1. Check JPEG (SOI = 0xFFD8)
    if (len > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let offset = 2;
      while (offset < len - 4) {
        if (bytes[offset] !== 0xFF) break;
        const marker = bytes[offset + 1];
        if (marker === 0xDA || marker === 0xD9) break; // SOS or EOI
        const segmentLen = view.getUint16(offset + 2, false);

        if (marker === 0xE1 && segmentLen >= 8) { // APP1
          // Check for 'Exif\0\0'
          if (
            bytes[offset + 4] === 0x45 && // 'E'
            bytes[offset + 5] === 0x78 && // 'x'
            bytes[offset + 6] === 0x69 && // 'i'
            bytes[offset + 7] === 0x66 && // 'f'
            bytes[offset + 8] === 0x00 &&
            bytes[offset + 9] === 0x00
          ) {
            const exifStart = offset + 10;
            const exifEnd = offset + 2 + segmentLen;
            return bytes.slice(exifStart, exifEnd);
          }
        }
        offset += 2 + segmentLen;
      }
    }

    // 2. Check PNG (Magic = 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A)
    if (len > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      let offset = 8;
      while (offset < len - 8) {
        const chunkLen = view.getUint32(offset, false);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        if (type === 'eXIf') {
          const chunkDataStart = offset + 8;
          return bytes.slice(chunkDataStart, chunkDataStart + chunkLen);
        }
        offset += 12 + chunkLen; // 4 len + 4 type + data + 4 crc
      }
    }

    // 3. Check WebP (RIFF....WEBP)
    if (len > 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      let offset = 12;
      while (offset < len - 8) {
        const fourCC = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const chunkSize = view.getUint32(offset + 4, true); // Little endian in RIFF
        if (fourCC === 'EXIF') {
          let dataStart = offset + 8;
          let dataEnd = dataStart + chunkSize;
          // Check if starts with 'Exif\0\0' header inside chunk
          if (
            bytes[dataStart] === 0x45 &&
            bytes[dataStart + 1] === 0x78 &&
            bytes[dataStart + 2] === 0x69 &&
            bytes[dataStart + 3] === 0x66 &&
            bytes[dataStart + 4] === 0x00 &&
            bytes[dataStart + 5] === 0x00
          ) {
            dataStart += 6;
          }
          return bytes.slice(dataStart, dataEnd);
        }
        // Chunks in RIFF are padded to even length
        const paddedSize = (chunkSize + 1) & ~1;
        offset += 8 + paddedSize;
      }
    }

    return null;
  }

  /**
   * Modifies specific tags (e.g. DateTime to now, ExifVersion to 0232) in a raw TIFF/Exif buffer
   */
  function updateExifMetadata(exifBuffer, options) {
    if (!exifBuffer || exifBuffer.length < 8) return exifBuffer;

    // Work on a copy
    const buffer = new Uint8Array(exifBuffer).slice(0);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const isLittleEndian = (buffer[0] === 0x49 && buffer[1] === 0x49); // 'II'
    const isBigEndian = (buffer[0] === 0x4D && buffer[1] === 0x4D);    // 'MM'

    if (!isLittleEndian && !isBigEndian) {
      // Not a valid TIFF header
      return buffer;
    }

    const le = isLittleEndian;
    const magic = view.getUint16(2, le);
    if (magic !== 0x002A) {
      return buffer;
    }

    const firstIfdOffset = view.getUint32(4, le);
    if (firstIfdOffset >= buffer.length) return buffer;

    const newDateTimeStr = formatExifDate(new Date()) + '\0'; // 20 bytes
    const newDateTimeBytes = new TextEncoder().encode(newDateTimeStr);

    function processIfd(offset) {
      if (offset + 2 > buffer.length) return 0;
      const numEntries = view.getUint16(offset, le);
      let entryOffset = offset + 2;

      let subIfdOffset = 0;

      for (let i = 0; i < numEntries; i++) {
        if (entryOffset + 12 > buffer.length) break;
        const tag = view.getUint16(entryOffset, le);
        const type = view.getUint16(entryOffset + 2, le);
        const count = view.getUint32(entryOffset + 4, le);

        // Tag 0x0132 = DateTime (Modify date)
        if (tag === 0x0132 && type === 2 && count >= 19) {
          const valOffset = view.getUint32(entryOffset + 8, le);
          if (valOffset + 19 <= buffer.length) {
            for (let b = 0; b < Math.min(newDateTimeBytes.length, count); b++) {
              buffer[valOffset + b] = newDateTimeBytes[b];
            }
          }
        }

        // Tag 0x8769 = ExifSubIFD
        if (tag === 0x8769) {
          subIfdOffset = view.getUint32(entryOffset + 8, le);
        }

        // Tag 0x9000 = ExifVersion (inside ExifSubIFD or directly)
        if (tag === 0x9000 && type === 7) { // UNDEFINED 4 bytes
          // Update to "0232" (Exif 2.32)
          buffer[entryOffset + 8] = 0x30; // '0'
          buffer[entryOffset + 9] = 0x32; // '2'
          buffer[entryOffset + 10] = 0x33; // '3'
          buffer[entryOffset + 11] = 0x32; // '2'
        }

        entryOffset += 12;
      }

      if (subIfdOffset > 0 && subIfdOffset < buffer.length) {
        processIfd(subIfdOffset);
      }

      if (entryOffset + 4 <= buffer.length) {
        return view.getUint32(entryOffset, le); // Next IFD offset
      }
      return 0;
    }

    let nextOffset = firstIfdOffset;
    let loopGuard = 0;
    while (nextOffset > 0 && nextOffset < buffer.length && loopGuard < 10) {
      nextOffset = processIfd(nextOffset);
      loopGuard++;
    }

    return buffer;
  }

  /**
   * Creates a minimal default Exif buffer with current DateTime and ExifVersion if none exists
   */
  function createDefaultExifBuffer() {
    const size = 76;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);

    // Header
    buf[0] = 0x49; buf[1] = 0x49; // 'II'
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);

    // IFD0 (offset 8)
    view.setUint16(8, 2, true); // 2 entries

    // Entry 1: DateTime (0x0132)
    view.setUint16(10, 0x0132, true);
    view.setUint16(12, 2, true); // ASCII
    view.setUint32(14, 20, true);
    view.setUint32(18, 38, true); // offset 38

    // Entry 2: ExifOffset (0x8769)
    view.setUint16(22, 0x8769, true);
    view.setUint16(24, 4, true); // LONG
    view.setUint32(26, 1, true);
    view.setUint32(30, 58, true); // offset 58

    // Next IFD = 0
    view.setUint32(34, 0, true);

    // DateTime string at offset 38
    const dtStr = formatExifDate(new Date()) + '\0';
    const dtBytes = new TextEncoder().encode(dtStr);
    for (let i = 0; i < dtBytes.length; i++) {
      buf[38 + i] = dtBytes[i];
    }

    // ExifSubIFD at offset 58
    view.setUint16(58, 1, true); // 1 entry
    view.setUint16(60, 0x9000, true); // ExifVersion
    view.setUint16(62, 7, true); // UNDEFINED
    view.setUint32(64, 4, true);
    buf[68] = 0x30; buf[69] = 0x32; buf[70] = 0x33; buf[71] = 0x32; // "0232"
    view.setUint32(72, 0, true);

    return buf;
  }

  /**
   * Builds an ISOBMFF Exif Box binary from a TIFF Exif buffer
   * Box Format: [4 bytes size][4 bytes 'Exif'][4 bytes Exif start offset = 0][raw TIFF data]
   */
  function buildJxlExifBox(exifBuffer) {
    if (!exifBuffer || exifBuffer.length === 0) return null;

    const payloadSize = 4 + exifBuffer.length; // 4 bytes for 0x00000000 offset + exif data
    const totalBoxSize = 8 + payloadSize;

    const box = new Uint8Array(totalBoxSize);
    const view = new DataView(box.buffer);

    // Box size (4 bytes big-endian)
    view.setUint32(0, totalBoxSize, false);

    // Box type 'Exif' (0x45 0x78 0x69 0x66)
    box[4] = 0x45;
    box[5] = 0x78;
    box[6] = 0x69;
    box[7] = 0x66;

    // 4-byte offset indicating position of TIFF header relative to start of box payload
    view.setUint32(8, 0, false);

    // Copy TIFF Exif data
    box.set(exifBuffer, 12);

    return box;
  }

  const ExifHandler = {
    extractExifBuffer: extractExifBuffer,
    updateExifMetadata: updateExifMetadata,
    createDefaultExifBuffer: createDefaultExifBuffer,
    buildJxlExifBox: buildJxlExifBox
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ExifHandler;
  } else {
    global.ExifHandler = ExifHandler;
  }
})(typeof self !== 'undefined' ? self : this);
