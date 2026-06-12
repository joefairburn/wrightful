/**
 * Pure FormData → schema-input helpers for the monitor create/edit actions —
 * extracted out of the `void`-importing page action so the fiddly coalescing
 * (which silently corrupts a stored config if it's wrong) is unit-testable.
 * No `void/*` imports; the action wires these into `CreateMonitorSchema` /
 * the per-type update schemas.
 */

/** The posted monitor type, defaulted to browser (only the two v1 types). */
export function formType(form: FormData): "browser" | "http" {
  return form.get("type") === "http" ? "http" : "browser";
}

/**
 * Parse the assertion-builder island's hidden JSON field into the raw value the
 * config schema validates. A non-string / blank field is an empty list; a
 * malformed JSON string is returned verbatim so the array schema rejects it with
 * a validation error rather than throwing here.
 */
export function parseAssertionsField(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Assemble the raw http-config object from the flat form fields for the schema
 * to validate. Numeric fields pass `?? undefined` so a missing field falls to
 * the schema default; checkbox fields pass `?? ""` so an unchecked box reads as
 * `false` (NOT the schema's `default(true)` — the form, not the schema, owns the
 * toggle's state once it's been rendered).
 */
export function httpConfigFromForm(form: FormData): Record<string, unknown> {
  return {
    url: form.get("url"),
    followRedirects: form.get("followRedirects") ?? "",
    shouldFail: form.get("shouldFail") ?? "",
    degradedResponseTimeMs: form.get("degradedResponseTimeMs") ?? undefined,
    maxResponseTimeMs: form.get("maxResponseTimeMs") ?? undefined,
    assertions: parseAssertionsField(form.get("assertions")),
  };
}
