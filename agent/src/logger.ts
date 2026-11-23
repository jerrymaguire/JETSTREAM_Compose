export type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = `${JSON.stringify(payload)}\n`;
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}
