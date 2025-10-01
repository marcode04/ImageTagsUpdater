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

// XLSX header alias support
const HEADER_ALIASES = {
  "Source file name": ["source"],
  "Output file name": ["ouput"],
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
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    setXlsxRows(rows);
  };

  const clearUploads = () => {
    // Revoke object URLs to free memory
    images.forEach((i) => {
      try {
        URL.revokeObjectURL(i.url);
      } catch {}
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
      } catch {}
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
        const outputName = (getField(row, "Output file name") || img.file.name).toString();
        const safeOutputName = transliterateSerbian(outputName);

        const dataUrl = await fileToDataURL(img.file);
        const exifObj = piexif.load(dataUrl);
        // EXIF ImageDescription is ASCII-only; transliterate Serbian characters when needed
        const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
        const asciiDescription = isAscii(description)
          ? description
          : transliterateSerbian(description);
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
        const newDataUrl = piexif.insert(exifBytes, dataUrl);
        const updatedBlob = dataURLToBlob(newDataUrl);

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
            accept="image/jpeg"
            onChange={onImagesSelected}
            ref={imageInputRef}
          />
          <small>
            {images.length
              ? `${images.length} image(s) selected`
              : "No images yet"}
          </small>
          {images.length > 0 && (
            <button className="subbtn" onClick={clearImages}>Remove Images</button>
          )}
        </div>
        <div className="uploader">
          <label className="label" htmlFor="xlsx">
            XLSX file
          </label>
          <input
            id="xlsx"
            type="file"
            accept=".xlsx"
            onChange={onXlsxSelected}
            ref={xlsxInputRef}
          />
          <small>
            {xlsxRows.length
              ? `${xlsxRows.length} row(s) loaded`
              : "No XLSX yet"}
          </small>
          {xlsxRows.length > 0 && (
            <button className="subbtn" onClick={clearXlsx}>Remove XLSX</button>
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
              <div>{resolvedHeaders["Source file name"] || "Source file name"}</div>
              <div>{resolvedHeaders["Output file name"] || "Output file name"}</div>
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
