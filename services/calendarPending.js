// services/calendarPending.js — konfirmasi tertunda per pengirim (dibagi plugin command & triggered).
// In-memory; hilang bila bot restart (TTL hanya 5 menit sehingga dapat diterima).
const TTL_MS = 5 * 60 * 1000;
const pending = new Map(); // sender -> { kind, ..., expiresAt }

function cleanup() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
}
export function setPending(sender, entry) {
  cleanup();
  pending.set(sender, { ...entry, expiresAt: Date.now() + TTL_MS });
}
/** Ambil lalu hapus konfirmasi tertunda; null bila tidak ada/kedaluwarsa. */
export function takePending(sender) {
  cleanup();
  const v = pending.get(sender) || null;
  pending.delete(sender);
  return v;
}
