import type { TemplateContent } from "./communications-contract.js";
// Missing row preserves the v1 layout: one button per row.
export function buttonRows(buttons: TemplateContent["buttons"]) {
  const rows = new Map<number, { text: string; url: string }[]>();
  buttons.forEach((b, index) => {
    const key = b.row ?? index;
    const row = rows.get(key) ?? [];
    row.push({ text: b.text, url: b.url });
    rows.set(key, row);
  });
  return [...rows].sort(([a], [b]) => a - b).map(([, row]) => row);
}
