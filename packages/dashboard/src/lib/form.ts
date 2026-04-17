/** Read a string field from FormData. Files and missing fields return "". */
export function readField(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
