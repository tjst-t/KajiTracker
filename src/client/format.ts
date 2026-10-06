const fmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(iso: string | null): string {
  return iso ? fmt.format(new Date(iso)) : "まだ使っていません";
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
