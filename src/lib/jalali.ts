// تبدیل تاریخ میلادی (YYYY-MM-DD) به شمسی — پیاده‌سازی سبک بدون وابستگی
export function toJalali(iso: string): string {
  const [gy, gm, gd] = iso.split("-").map(Number);
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  let gy2 = gy <= 1600 ? gy - 621 : gy - 1600;
  let days =
    365 * gy2 + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = days < 186 ? 1 + (days % 31) : 1 + ((days - 186) % 30);
  const fa = (n: number) => n.toLocaleString("fa-IR", { useGrouping: false });
  return `${fa(jy)}/${fa(jm).padStart(2, "۰")}/${fa(jd).padStart(2, "۰")}`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtMoney(n: number): string {
  return n.toLocaleString("fa-IR") + " تومان";
}
