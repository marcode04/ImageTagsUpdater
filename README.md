## Image Tags Updater

This app updates JPEG metadata from the first sheet of an XLSX file and supports flexible column headers.

### Required and Optional Columns

- Required (one of):
  - `Source file name` or `source` — matched to uploaded image filenames (case-insensitive, trimmed)
- Optional:
  - `Output file name` or `ouput` — desired output name; `.jpg` is added if missing
  - `Title` or `title`
  - `Caption` or `caption`
  - `Description` or `description`
  - `Keywords` or `keywords`

Aliases are case-insensitive and whitespace around headers is ignored.

### Matching Logic

- Images are matched to rows by `Source file name` (or `source`) after converting both to lowercase and trimming.
- If no row is found, the image shows `No matching row in XLSX`.

### Metadata Writing

- `Title`, `Caption`, `Keywords`: stored as Unicode in EXIF XP tags (`XPTitle`, `XPComment`, `XPKeywords`).
- `Description`: written to `XPComment` for Unicode; `ImageDescription` is ASCII-only, so non-ASCII text is transliterated (Serbian mappings: Š→S, Đ→DJ, Č→C, Ć→C, Ž→Z, DŽ→DZ; lowercase equivalents too).
- `Keywords`: written as a single string; if you separate by commas/semicolons, they are kept as typed.

### Output Filename

- Uses `Output file name` (or `ouput`) if provided; otherwise original image name.
- Ensures `.jpg`/`.jpeg` extension; adds `.jpg` if missing.
- Applies the same transliteration for Serbian characters to keep ASCII-safe names.

### Example (first rows)

| Source file name | Output file name | Title        | Caption          | Description        | Keywords        |
| ---------------- | ---------------- | ------------ | ---------------- | ------------------ | --------------- |
| image00001.jpg   | apron-001.jpg    | Pregač       | Pregač sa džepom | Pamučni kuhinjski… | kuhinja; pregač |
| image00002.jpg   | apron-002        | Radni Pregač | Bez rukava       | Polyester, plavi   | rad; uniforma   |

You may use aliases as headers, e.g. `source`, `ouput`, `title`, `caption`, `description`, `keywords`.

### Tips

- Keep headers in the first row; content from subsequent rows only.
- Avoid extra spaces in filenames; the app trims and lowercases for matching.
- Only JPEG files are supported.

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
