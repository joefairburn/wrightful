/**
 * A tiny, dependency-free, RFC-4180-compliant CSV serializer.
 *
 * Used by the data-export surface (roadmap 2.5) — both the Bearer-authed public
 * `routes/api/v1/*?format=csv` and the session-authed in-dashboard
 * `/api/t/.../export/*`. Kept PURE (no `void/*` imports, no I/O) so it's a
 * cheap, exhaustive unit-test surface and reusable from any handler.
 *
 * ## Format choices (all per RFC 4180, the spreadsheet-interop baseline)
 *
 * - **Row terminator: CRLF (`\r\n`).** RFC 4180 §2.1 specifies CRLF, and Excel
 *   on Windows still expects it; every other consumer (LibreOffice, Numbers,
 *   `csv` libraries, `pandas`) accepts CRLF transparently. Choosing CRLF over a
 *   bare LF is the strictly-safer default for "open it in a spreadsheet".
 * - **Field quoting is minimal:** a field is wrapped in double quotes only when
 *   it contains a quote, comma, CR, or LF (RFC 4180 §2.5/§2.6). Plain fields are
 *   emitted bare so the output stays compact and diff-friendly.
 * - **Quote escaping:** an embedded `"` is doubled to `""` (RFC 4180 §2.7).
 * - **`null` / `undefined` → empty field** (not the literal string "null"), so a
 *   missing branch/commit renders as an empty cell, which spreadsheets read as
 *   blank rather than the word "null".
 * - **Numbers and booleans** are stringified via `String(...)`. We do NOT coerce
 *   number-ish strings (a commit SHA like `0007abc`, a leading-zero build id):
 *   the serializer receives already-typed values and preserves them verbatim, so
 *   a string `"007"` round-trips as the three characters `007` rather than being
 *   reinterpreted as a number. (Spreadsheets may still auto-coerce on import —
 *   that's a consumer concern outside this serializer's contract.)
 * - **Formula injection IS neutralized here.** A STRING field whose first char is
 *   `=` `+` `-` `@` (or a leading TAB/CR) is prefixed with a single quote so a
 *   spreadsheet imports it as literal text instead of evaluating it as a live
 *   formula (the OWASP CSV-injection class — `=HYPERLINK`/`WEBSERVICE`/DDE). This
 *   guard is gated to string inputs, so typed numbers/booleans (e.g. a negative
 *   `durationMs`) keep their value; only attacker-controlled free-text columns
 *   (branch, commit message, actor, repo, test title, file) are ever guarded.
 *   Unlike numeric coercion above, this is an *escaping* concern the serializer
 *   owns — every export surface funnels through it.
 *
 * The serializer does NOT prepend a UTF-8 BOM. Bytes are UTF-8; if a future
 * Excel-on-Windows interop bug needs a BOM, add it at the response boundary, not
 * here, so the pure string output stays canonical.
 */

const CRLF = "\r\n";

/** A value a CSV cell can hold. Everything is stringified at write time. */
export type CsvValue = string | number | boolean | null | undefined;

/**
 * Escape a single field per RFC 4180. Returns the field bare when it needs no
 * quoting, else wrapped in double quotes with embedded quotes doubled.
 *
 * `null` / `undefined` become an empty (unquoted) field.
 */
export function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  // Neutralize spreadsheet formula injection first: prefix a STRING that begins
  // with a formula trigger (= + - @ TAB CR) with a single quote so it imports as
  // literal text. Gated to strings so typed numbers/booleans aren't mangled.
  const guarded =
    typeof value === "string" && /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  // Then quote only when the (guarded) field contains a character that would
  // otherwise break record/field framing: the quote char, delimiter, or break.
  if (/["\r\n,]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

/** Serialize a single row (array of cells) into one CSV record (no terminator). */
export function csvRow(cells: readonly CsvValue[]): string {
  return cells.map(escapeCsvField).join(",");
}

/**
 * Serialize a header row + body rows into a complete CSV document.
 *
 * Every row — header and body — is CRLF-terminated, including the last, so the
 * output is a clean concatenation target: streaming exports can emit the header
 * once and then append `csvRow(...) + CRLF` per page without special-casing the
 * final row.
 */
export function toCsv(
  header: readonly string[],
  rows: Iterable<readonly CsvValue[]>,
): string {
  let out = csvRow(header) + CRLF;
  for (const row of rows) {
    out += csvRow(row) + CRLF;
  }
  return out;
}

/** The CRLF record terminator, exported so streaming callers don't re-spell it. */
export const CSV_ROW_TERMINATOR = CRLF;
