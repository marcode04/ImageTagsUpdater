import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import piexif from "piexifjs";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import "./App.css";

const fileToDataURL = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

function dataURLToBlob(dataURL) {
  const parts = dataURL.split(",");
  const mime = parts[0].match(/:(.*?);/)?.[1] || "image/jpeg";
  const bstr = atob(parts[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new Blob([u8arr], { type: mime });
}

// UTF-8 encoder
const utf8 = (s) => new TextEncoder().encode(s);

// Basic XML escape
const xmlEscape = (s = "") =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// Build minimal XMP packet for Title/Description/Keywords (Adobe-compatible)
const buildXmpXml = (title, description, keywordsArr) => {
  const kws = (keywordsArr || []).filter(Boolean);
  const bagItems = kws.map((k) => `<rdf:li>${xmlEscape(k)}</rdf:li>`).join("");
  const inner =
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">` +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(
      title || ""
    )}</rdf:li></rdf:Alt></dc:title>` +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(
      description || ""
    )}</rdf:li></rdf:Alt></dc:description>` +
    `<dc:subject><rdf:Bag>${bagItems}</rdf:Bag></dc:subject>` +
    `</rdf:Description>` +
    `</rdf:RDF>` +
    `</x:xmpmeta>`;
  // Include xpacket envelope for maximum Adobe compatibility
  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    inner +
    `<?xpacket end="w"?>`
  );
};

// Construct APP1 XMP segment ("http://ns.adobe.com/xap/1.0/\0" + xml)
const buildXmpSegment = (xml) => {
  const preamble = utf8("http://ns.adobe.com/xap/1.0/\0");
  const xmlBytes = utf8(xml);
  const payload = new Uint8Array(preamble.length + xmlBytes.length);
  payload.set(preamble, 0);
  payload.set(xmlBytes, preamble.length);
  const length = payload.length + 2; // includes the two length bytes
  const seg = new Uint8Array(2 + 2 + payload.length);
  seg[0] = 0xff; // APP1
  seg[1] = 0xe1;
  seg[2] = (length >> 8) & 0xff;
  seg[3] = length & 0xff;
  seg.set(payload, 4);
  return seg;
};

// Find existing XMP APP1 segment; returns {start, totalLen} or null
const findExistingXmp = (jpegBytes) => {
  if (!(jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8)) return null;
  let offset = 2;
  const sig = utf8("http://ns.adobe.com/xap/1.0/\0");
  while (offset + 4 <= jpegBytes.length) {
    if (jpegBytes[offset] !== 0xff) break;
    const type = jpegBytes[offset + 1];
    if (type === 0xda) break; // SOS
    if (type === 0xd8 || type === 0xd9) {
      offset += 2;
      continue;
    }
    const len = (jpegBytes[offset + 2] << 8) | jpegBytes[offset + 3];
    if (type === 0xe1) {
      // Check for XMP preamble
      let ok = true;
      for (let i = 0; i < sig.length; i++) {
        if (jpegBytes[offset + 4 + i] !== sig[i]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        // 'len' is the segment length including its own two length bytes.
        // Total bytes to remove = marker (2) + len
        return { start: offset, totalLen: 2 + len };
      }
    }
    offset += 2 + len;
  }
  return null;
};

// Replace an existing segment with new bytes
const replaceSegment = (jpegBytes, start, totalLen, newSeg) => {
  const out = new Uint8Array(jpegBytes.length - totalLen + newSeg.length);
  out.set(jpegBytes.slice(0, start), 0);
  out.set(newSeg, start);
  out.set(jpegBytes.slice(start + totalLen), start + newSeg.length);
  return out;
};

// Insert XMP segment after existing APP segments and before SOS for better compatibility
const insertXmpIntoJpeg = (jpegBytes, xmpSeg) => {
  if (!(jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8)) return jpegBytes;
  const existing = findExistingXmp(jpegBytes);
  if (existing) {
    return replaceSegment(jpegBytes, existing.start, existing.totalLen, xmpSeg);
  }
  let offset = 2; // start after SOI
  let insertPos = offset; // default insertion right after SOI
  while (offset + 4 <= jpegBytes.length) {
    const marker = jpegBytes[offset];
    // Stop if not a marker prefix
    if (marker !== 0xff) break;
    const type = jpegBytes[offset + 1];
    if (type === 0xda) {
      // SOS: stop scanning; we must insert before this
      break;
    }
    // Standalone markers without length: skip only 2 bytes
    if (type === 0xd8 || type === 0xd9) {
      offset += 2;
      continue;
    }
    const len = (jpegBytes[offset + 2] << 8) | jpegBytes[offset + 3];
    // APPn markers range 0xE0 - 0xEF; keep track of last APP position
    if (type >= 0xe0 && type <= 0xef) {
      insertPos = offset + 2 + len; // end of this APP segment
    }
    offset += 2 + len;
  }
  const out = new Uint8Array(jpegBytes.length + xmpSeg.length);
  out.set(jpegBytes.slice(0, insertPos), 0);
  out.set(xmpSeg, insertPos);
  out.set(jpegBytes.slice(insertPos), insertPos + xmpSeg.length);
  return out;
};

// Build IPTC IIM payload and wrap as Photoshop APP13 (8BIM #0x0404)
const buildIptcSegment = (title, caption, keywordsArr) => {
  const kws = (keywordsArr || []).filter(Boolean);

  const enc = (s) => utf8(s || "");
  const pushRecord = (arr, record, dataset, dataBytes) => {
    arr.push(0x1c, record, dataset);
    const len = dataBytes.length;
    arr.push((len >> 8) & 0xff, len & 0xff);
    for (const b of dataBytes) arr.push(b);
  };

  const payload = [];
  // Envelope: CodedCharacterSet to UTF-8
  pushRecord(payload, 1, 90, enc("\u001B%G"));
  // Application: RecordVersion = 4
  pushRecord(payload, 2, 0, new Uint8Array([0x00, 0x04]));
  // Title (ObjectName)
  if (title) pushRecord(payload, 2, 5, enc(title));
  // Caption/Abstract (WordPress reads this into the Caption field)
  if (caption) pushRecord(payload, 2, 120, enc(caption));
  // Keywords: one record per keyword
  for (const k of kws) pushRecord(payload, 2, 25, enc(k));

  const payloadBytes = new Uint8Array(payload);

  // Build 8BIM resource block
  const header = utf8("Photoshop 3.0\0");
  const sig = utf8("8BIM");
  const nameLen = 0; // empty Pascal string name
  const namePad = (nameLen + 1) % 2 === 1 ? 1 : 0; // even length
  const size = payloadBytes.length;
  const dataPad = size % 2 === 1 ? 1 : 0;

  const block = new Uint8Array(
    header.length +
      sig.length +
      2 +
      1 +
      namePad +
      4 +
      payloadBytes.length +
      dataPad
  );
  let p = 0;
  block.set(header, p);
  p += header.length;
  block.set(sig, p);
  p += sig.length;
  // Resource ID 0x0404
  block[p++] = 0x04;
  block[p++] = 0x04;
  // Pascal name (empty)
  block[p++] = 0x00;
  if (namePad) block[p++] = 0x00;
  // Size (big-endian)
  block[p++] = (size >> 24) & 0xff;
  block[p++] = (size >> 16) & 0xff;
  block[p++] = (size >> 8) & 0xff;
  block[p++] = size & 0xff;
  // Data
  block.set(payloadBytes, p);
  p += payloadBytes.length;
  if (dataPad) block[p++] = 0x00;

  // Wrap into APP13 segment
  const length = block.length + 2;
  const seg = new Uint8Array(2 + 2 + block.length);
  seg[0] = 0xff;
  seg[1] = 0xed; // APP13
  seg[2] = (length >> 8) & 0xff;
  seg[3] = length & 0xff;
  seg.set(block, 4);
  return seg;
};

// Insert APP13 IPTC after last APP segment and before SOS
const insertIptcIntoJpeg = (jpegBytes, iptcSeg) => {
  if (!(jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8)) return jpegBytes;
  let offset = 2;
  let insertPos = offset;
  while (offset + 4 <= jpegBytes.length) {
    if (jpegBytes[offset] !== 0xff) break;
    const type = jpegBytes[offset + 1];
    if (type === 0xda) break; // SOS
    if (type === 0xd8 || type === 0xd9) {
      offset += 2;
      continue;
    }
    const len = (jpegBytes[offset + 2] << 8) | jpegBytes[offset + 3];
    // Keep moving insert position to end of last APPn
    if (type >= 0xe0 && type <= 0xef) insertPos = offset + 2 + len;
    offset += 2 + len;
  }
  const out = new Uint8Array(jpegBytes.length + iptcSeg.length);
  out.set(jpegBytes.slice(0, insertPos), 0);
  out.set(iptcSeg, insertPos);
  out.set(jpegBytes.slice(insertPos), insertPos + iptcSeg.length);
  return out;
};

// Remove existing Photoshop APP13 segments (8BIM with IPTC) to avoid duplicates
const removePhotoshopApp13Segments = (jpegBytes) => {
  if (!(jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8)) return jpegBytes;
  const header = utf8("Photoshop 3.0\0");
  const parts = [];
  // Keep SOI
  parts.push(jpegBytes.slice(0, 2));
  let offset = 2;
  while (offset + 4 <= jpegBytes.length) {
    if (jpegBytes[offset] !== 0xff) break;
    const type = jpegBytes[offset + 1];
    const len = (jpegBytes[offset + 2] << 8) | jpegBytes[offset + 3];
    const segEnd = offset + 2 + len;
    if (type === 0xda) {
      // Copy the rest (SOS and image data) and stop
      parts.push(jpegBytes.slice(offset));
      offset = jpegBytes.length;
      break;
    }
    if (type === 0xed) {
      // APP13: check for Photoshop header
      let isPhotoshop = true;
      for (let i = 0; i < header.length; i++) {
        if (offset + 4 + i >= jpegBytes.length || jpegBytes[offset + 4 + i] !== header[i]) {
          isPhotoshop = false;
          break;
        }
      }
      if (!isPhotoshop) {
        parts.push(jpegBytes.slice(offset, segEnd));
      }
      // If Photoshop, skip this APP13 entirely (remove existing IPTC)
    } else {
      parts.push(jpegBytes.slice(offset, segEnd));
    }
    offset = segEnd;
  }
  if (offset < jpegBytes.length) parts.push(jpegBytes.slice(offset));

  // Concatenate kept parts
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
};

// Transliterate Serbian characters to ASCII equivalents when needed
const transliterateSerbian = (s = "") => {
  const map = {
    Š: "S",
    š: "s",
    Đ: "DJ",
    đ: "dj",
    Č: "C",
    č: "c",
    Ć: "C",
    ć: "c",
    Ž: "Z",
    ž: "z",
    DŽ: "DZ",
    dž: "dz",
  };
  // Handle digraphs first, then single characters
  return s.replace(/DŽ|dž|Š|š|Đ|đ|Č|č|Ć|ć|Ž|ž/g, (m) => map[m] || m);
};

// Convert common non-ASCII punctuation to ASCII and strip remaining non-ASCII
const sanitizeAsciiText = (s = "") => {
  let t = transliterateSerbian(s);
  t = t
    .replace(/[–—]/g, "-")
    .replace(/[“”„]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/…/g, "...")
    .replace(/•/g, "*")
    .replace(/™/g, "(TM)")
    .replace(/®/g, "(R)")
    .replace(/©/g, "(C)");
  if (typeof t.normalize === "function") {
    t = t.normalize("NFKD");
  }
  // Strip non-ASCII without using control characters in regex
  t = Array.from(t)
    .map((ch) => (ch.codePointAt(0) <= 0x7f ? ch : ""))
    .join("");
  return t;
};

// XLSX header alias support
const HEADER_ALIASES = {
  "Source file name": ["source"],
  "Output file name": ["output", "output name", "output filename"],
  Title: ["title"],
  Caption: ["caption"],
  Description: ["description"],
  Keywords: ["keywords"],
};

const normHeader = (s = "") => s.toString().trim().toLowerCase();

// Get a field value from a row, accepting canonical name or any alias
const getField = (row, canonical) => {
  const aliases = [canonical, ...(HEADER_ALIASES[canonical] || [])].map(
    normHeader
  );
  for (const key of Object.keys(row)) {
    if (aliases.includes(normHeader(key))) return row[key];
  }
  return "";
};

// Resolve which actual header key exists in the provided rows
const resolveHeaderKey = (rows, canonical) => {
  const aliases = [canonical, ...(HEADER_ALIASES[canonical] || [])].map(
    normHeader
  );
  for (const r of rows) {
    for (const key of Object.keys(r)) {
      if (aliases.includes(normHeader(key))) return key;
    }
  }
  return canonical;
};

export default function App() {
  const [images, setImages] = useState([]); // {file,url,status,updatedBlob,newName,error}
  const [xlsxRows, setXlsxRows] = useState([]);
  const [processing, setProcessing] = useState(false);
  const imageInputRef = useRef(null);
  const xlsxInputRef = useRef(null);

  // Determine actual header names used for preview rendering
  const resolvedHeaders = useMemo(
    () => ({
      "Source file name": resolveHeaderKey(xlsxRows, "Source file name"),
      "Output file name": resolveHeaderKey(xlsxRows, "Output file name"),
      Title: resolveHeaderKey(xlsxRows, "Title"),
      Caption: resolveHeaderKey(xlsxRows, "Caption"),
      Description: resolveHeaderKey(xlsxRows, "Description"),
      Keywords: resolveHeaderKey(xlsxRows, "Keywords"),
    }),
    [xlsxRows]
  );

  const rowMap = useMemo(() => {
    const m = new Map();
    xlsxRows.forEach((r) => {
      const key = (getField(r, "Source file name") || "")
        .toString()
        .trim()
        .toLowerCase();
      if (key) m.set(key, r);
    });
    return m;
  }, [xlsxRows]);

  const onImagesSelected = (e) => {
    const files = Array.from(e.target.files || []);
    const prepared = files.map((f) => ({
      file: f,
      url: URL.createObjectURL(f),
      status: "pending",
      updatedBlob: null,
      newName: "-",
      error: null,
    }));
    setImages(prepared);
  };

  const onXlsxSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const firstSheetName = wb.SheetNames?.[0];
      if (!firstSheetName) throw new Error("No sheets in XLSX file.");
      const sheet = wb.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      setXlsxRows(rows);
    } catch (err) {
      console.error("Failed to parse XLSX:", err);
      alert("Failed to read XLSX file. Please check the file format.");
      setXlsxRows([]);
    }
  };

  const clearUploads = () => {
    // Revoke object URLs to free memory
    images.forEach((i) => {
      try {
        URL.revokeObjectURL(i.url);
      } catch (e) {
        // ignore revoke errors (e.g., already revoked)
        void e;
      }
    });
    setImages([]);
    setXlsxRows([]);
    setProcessing(false);
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (xlsxInputRef.current) xlsxInputRef.current.value = "";
  };

  // Remove only uploaded images
  const clearImages = () => {
    images.forEach((i) => {
      try {
        URL.revokeObjectURL(i.url);
      } catch (e) {
        // ignore revoke errors (e.g., already revoked)
        void e;
      }
    });
    setImages([]);
    setProcessing(false);
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  // Remove only uploaded XLSX rows
  const clearXlsx = () => {
    setXlsxRows([]);
    setProcessing(false);
    if (xlsxInputRef.current) xlsxInputRef.current.value = "";
  };

  const applyMetadata = async () => {
    if (!images.length || !xlsxRows.length) return;
    setProcessing(true);
    const out = [];
    for (const img of images) {
      let next = { ...img };
      try {
        if (
          !img.file.type.includes("jpeg") &&
          !img.file.name.toLowerCase().endsWith(".jpg")
        ) {
          next.status = "error";
          next.error = "Only JPEG is supported.";
          out.push(next);
          continue;
        }

        const row = rowMap.get(img.file.name.toLowerCase());
        if (!row) {
          next.status = "error";
          next.error = "No matching row in XLSX.";
          out.push(next);
          continue;
        }

        const title = (getField(row, "Title") || "").toString();
        const caption = (getField(row, "Caption") || "").toString();
        const description = (getField(row, "Description") || "").toString();
        const keywords = (getField(row, "Keywords") || "").toString();
        const outputName = (
          getField(row, "Output file name") || img.file.name
        ).toString();
        const safeOutputName = transliterateSerbian(outputName);

        const dataUrl = await fileToDataURL(img.file);
        const exifObj = piexif.load(dataUrl);
        // EXIF ImageDescription must be ASCII; use XLSX Description (fallback to Caption)
        const asciiDescription = sanitizeAsciiText(description || caption);
        exifObj["0th"][piexif.ImageIFD.ImageDescription] = asciiDescription;
        // Encode Unicode safely for XP* tags (UTF-16LE byte array with null terminator)
        const encodeXP = (str) => {
          const bytes = [];
          for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            bytes.push(code & 0xff);
            bytes.push((code >> 8) & 0xff);
          }
          // Null terminator
          bytes.push(0);
          bytes.push(0);
          return bytes;
        };
        if (title) exifObj["0th"][piexif.ImageIFD.XPTitle] = encodeXP(title);
        if (caption)
          exifObj["0th"][piexif.ImageIFD.XPComment] = encodeXP(caption);
        if (keywords)
          exifObj["0th"][piexif.ImageIFD.XPKeywords] = encodeXP(keywords);
        const exifBytes = piexif.dump(exifObj);
        let newDataUrl;
        try {
          newDataUrl = piexif.insert(exifBytes, dataUrl);
        } catch {
          // Fallback: clear ImageDescription and retry if Latin1 btoa error occurs
          exifObj["0th"][piexif.ImageIFD.ImageDescription] = "";
          const exifBytes2 = piexif.dump(exifObj);
          newDataUrl = piexif.insert(exifBytes2, dataUrl);
        }

        // Build XMP packet for Adobe-compatible Title/Description/Keywords
        const kwList = keywords
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean);
        const xmpXml = buildXmpXml(title, description, kwList);
        const xmpSeg = buildXmpSegment(xmpXml);

        // Start from EXIF-updated JPEG bytes
        const tempBlob = dataURLToBlob(newDataUrl);
        let bytes = new Uint8Array(await tempBlob.arrayBuffer());
        // Insert/replace XMP
        bytes = insertXmpIntoJpeg(bytes, xmpSeg);
        // Remove existing Photoshop APP13 segments to avoid duplicate/old IPTC
        bytes = removePhotoshopApp13Segments(bytes);
        // Insert IPTC APP13 for broader compatibility (Caption via 2:120)
        const iptcSeg = buildIptcSegment(title, caption, kwList);
        bytes = insertIptcIntoJpeg(bytes, iptcSeg);
        const updatedBlob = new Blob([bytes], { type: "image/jpeg" });

        next.updatedBlob = updatedBlob;
        next.newName = /\.jpe?g$/i.test(safeOutputName)
          ? safeOutputName
          : `${safeOutputName}.jpg`;
        next.status = "updated";
        out.push(next);
      } catch (err) {
        next.status = "error";
        next.error = err?.message || "Failed to update metadata.";
        out.push(next);
      }
    }
    setImages(out);
    setProcessing(false);
  };

  const downloadZip = async () => {
    const zip = new JSZip();
    images.forEach((i) => {
      if (i.status === "updated" && i.updatedBlob) {
        zip.file(i.newName, i.updatedBlob);
      }
    });
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "updated-images.zip");
  };

  return (
    <div className="container">
      <header>
        <h1>Image Tags Updater</h1>
        <p>Upload JPEG images and an XLSX to update metadata.</p>
      </header>

      <section className="upload-section">
        <div className="uploader">
          <label className="label" htmlFor="images">
            Images
          </label>
          <input
            id="images"
            type="file"
            multiple
            accept="image/jpeg,image/jpg,.jpg,.jpeg"
            onChange={onImagesSelected}
            ref={imageInputRef}
          />
          <small>
            {images.length
              ? `${images.length} image(s) selected`
              : "No images yet"}
          </small>
          {images.length > 0 && (
            <button className="subbtn" onClick={clearImages}>
              Remove Images
            </button>
          )}
        </div>
        <div className="uploader">
          <label className="label" htmlFor="xlsx">
            XLSX file
          </label>
          <input
            id="xlsx"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onXlsxSelected}
            ref={xlsxInputRef}
          />
          <small>
            {xlsxRows.length
              ? `${xlsxRows.length} row(s) loaded`
              : "No XLSX yet"}
          </small>
          {xlsxRows.length > 0 && (
            <button className="subbtn" onClick={clearXlsx}>
              Remove XLSX
            </button>
          )}
        </div>
      </section>

      <section className="actions">
        <button
          onClick={applyMetadata}
          disabled={!images.length || !xlsxRows.length || processing}
        >
          {processing ? "Processing…" : "Apply Metadata"}
        </button>
        <button
          onClick={downloadZip}
          disabled={!images.some((i) => i.status === "updated")}
        >
          Download Updated ZIP
        </button>
        <button
          onClick={clearUploads}
          disabled={!images.length && !xlsxRows.length}
        >
          Remove All Uploads
        </button>
      </section>

      <section className="grid">
        {images.map((img, idx) => (
          <div key={idx} className="card">
            <img src={img.url} alt={img.file.name} />
            <div className="info">
              <div className="name">Source: {img.file.name}</div>
              <div className="name">Output: {img.newName}</div>
              <div className={`status ${img.status}`}>{img.status}</div>
              {img.error && <div className="error">{img.error}</div>}
              {img.status === "updated" && img.updatedBlob && (
                <a
                  className="download"
                  href={URL.createObjectURL(img.updatedBlob)}
                  download={img.newName}
                >
                  Download
                </a>
              )}
            </div>
          </div>
        ))}
      </section>

      {xlsxRows.length > 0 && (
        <section className="table-preview">
          <h2>XLSX Preview (first 5 rows)</h2>
          <div className="table">
            <div className="thead">
              <div>
                {resolvedHeaders["Source file name"] || "Source file name"}
              </div>
              <div>
                {resolvedHeaders["Output file name"] || "Output file name"}
              </div>
              <div>{resolvedHeaders["Title"] || "Title"}</div>
              <div>{resolvedHeaders["Caption"] || "Caption"}</div>
              <div>{resolvedHeaders["Description"] || "Description"}</div>
              <div>{resolvedHeaders["Keywords"] || "Keywords"}</div>
            </div>
            {xlsxRows.slice(0, 5).map((r, i) => (
              <div className="trow" key={i}>
                <div>{r[resolvedHeaders["Source file name"]]}</div>
                <div>{r[resolvedHeaders["Output file name"]]}</div>
                <div>{r[resolvedHeaders["Title"]]}</div>
                <div>{r[resolvedHeaders["Caption"]]}</div>
                <div>{r[resolvedHeaders["Description"]]}</div>
                <div>{r[resolvedHeaders["Keywords"]]}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
