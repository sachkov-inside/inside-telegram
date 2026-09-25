export async function newId() {
  const { randomUUID } = await import("node:crypto");
  return randomUUID();
}
