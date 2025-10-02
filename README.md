## Image Tags Updater

This app updates JPEG metadata.

### Required and Optional Columns

- Required (one of):
  - `Source file name` or `source` — matched to uploaded image filenames (case-insensitive, trimmed)
- Optional:
  - `Output file name` or `output` — desired output name; `.jpg` is added if missing
  - `Title` or `title`
  - `Caption` or `caption`
  - `Description` or `description`
  - `Keywords` or `keywords`

Aliases are case-insensitive and whitespace around headers is ignored.

### Matching Logic

- Images are matched to rows by `Source file name` (or `source`) after converting both to lowercase and trimming.
- If no row is found, the image shows `No matching row in XLSX`.

### Metadata Writing

- EXIF (broad app compatibility)
  - `XPTitle` ← XLSX Title (Unicode)
  - `XPComment` ← XLSX Caption (Unicode)
  - `XPKeywords` ← XLSX Keywords as a single Unicode string
  - `ImageDescription` ← XLSX Description (ASCII-only; transliterated; falls back to Caption when Description is empty)
    - Transliteration for Serbian: Š→S, Đ→DJ, Č→C, Ć→C, Ž→Z, DŽ→DZ (and lowercase equivalents)

- XMP (Adobe/WordPress Description)
  - `dc:title` (x-default) ← XLSX Title
  - `dc:description` (x-default) ← XLSX Description
  - `dc:subject` (Bag) ← Keywords split by commas/semicolons

- IPTC IIM (WordPress Caption and legacy readers)
  - `2:005` ObjectName ← XLSX Title
  - `2:120` Caption-Abstract ← XLSX Caption
  - `2:025` Keywords ← list of keywords

Implementation note: existing Photoshop APP13 (IPTC) segments are removed before inserting a fresh IPTC block to avoid duplicates and ensure WordPress reads the correct Caption from `2:120`.

### Output Filename

- Uses `Output file name` (or `ouput`) if provided; otherwise original image name.
- Ensures `.jpg`/`.jpeg` extension; adds `.jpg` if missing.
- Applies the same transliteration for Serbian characters to keep ASCII-safe names.

### Example (first rows)

| Source file name | Output file name | Title        | Caption          | Description        | Keywords        |
| ---------------- | ---------------- | ------------ | ---------------- | ------------------ | --------------- |


You may use aliases as headers, e.g. `source`, `ouput`, `title`, `caption`, `description`, `keywords`.

### Tips

- Keep headers in the first row; content from subsequent rows only.
- Avoid extra spaces in filenames; the app trims and lowercases for matching.
- Only JPEG files are supported.
