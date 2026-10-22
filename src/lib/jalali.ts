// تبدیل تاریخ میلادی (YYYY-MM-DD) به شمسی
// بر پایه‌ی همان هسته‌ی jalaali (پایین‌تر) تا با jalaliToIso کاملاً رفت‌وبرگشتی باشد؛
// پیاده‌سازی قبلی برای اسفندِ بعضی سال‌ها یک روز جابه‌جا بود.
export function toJalali(iso: string): string {
  const [gy, gm, gd] = iso.split("-").map(Number);
  const jdn = g2d(gy, gm, gd);
  const farvardin1Jdn = (y: number): number => {
    const r = jalCalMarch(y);
    return g2d(r.gy, 3, r.march);
  };
  let jy = gy - 621;
  while (jdn < farvardin1Jdn(jy)) jy--;
  while (jdn >= farvardin1Jdn(jy + 1)) jy++;
  const doy = jdn - farvardin1Jdn(jy); // صفرمبنا از اول فروردین
  const jm = doy < 186 ? 1 + Math.floor(doy / 31) : 7 + Math.floor((doy - 186) / 30);
  const jd = doy < 186 ? (doy % 31) + 1 : ((doy - 186) % 30) + 1;
  const fa = (n: number) => n.toLocaleString("fa-IR", { useGrouping: false });
  return `${fa(jy)}/${fa(jm).padStart(2, "۰")}/${fa(jd).padStart(2, "۰")}`;
}

// ── تبدیل معکوس: شمسی → میلادی (الگوریتم jalaali) ──
const JALALI_BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const jdiv = (a: number, b: number): number => Math.trunc(a / b); // الگوریتم jalaali با trunc کار می‌کند، نه floor

function jalCalMarch(jy: number): { gy: number; march: number } {
  const gy = jy + 621;
  let leapJ = -14;
  let jp = JALALI_BREAKS[0];
  let jm = 0;
  let jump = 0;
  for (let i = 1; i < JALALI_BREAKS.length; i++) {
    jm = JALALI_BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += jdiv(jump, 33) * 8 + jdiv(jump % 33, 4);
    jp = jm;
  }
  const n = jy - jp;
  leapJ += jdiv(n, 33) * 8 + jdiv((n % 33) + 3, 4);
  const leapG = jdiv(gy, 4) - jdiv((jdiv(gy, 100) + 1) * 3, 4) - 150;
  return { gy, march: 20 + leapJ - leapG };
}

function g2d(gy: number, gm: number, gd: number): number {
  const a = jdiv(gm - 8, 6);
  let d = jdiv((gy + a + 100100) * 1461, 4) + jdiv(153 * (((gm + 9) % 12)) + 2, 5) + gd - 34840408;
  d = d - jdiv(jdiv(gy + 100100 + a, 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j += jdiv(jdiv(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = jdiv(j % 1461, 4) * 5 + 308;
  return {
    gd: jdiv(i % 153, 5) + 1,
    gm: (jdiv(i, 153) % 12) + 1,
    gy: jdiv(j, 1461) - 100100 + jdiv(8 - (jdiv(i, 153) % 12 + 1), 6),
  };
}

/** تبدیل تاریخ شمسی به ISO میلادی (YYYY-MM-DD) */
export function jalaliToIso(jy: number, jm: number, jd: number): string {
  const r = jalCalMarch(jy);
  const jdn = g2d(r.gy, 3, r.march) + (jm - 1) * 31 - jdiv(jm, 7) * (jm - 7) + jd - 1;
  const g = d2g(jdn);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${g.gy}-${p2(g.gm)}-${p2(g.gd)}`;
}

const FA_D = "۰۱۲۳۴۵۶۷۸۹";
const AR_D = "٠١٢٣٤٥٦٧٨٩";
function latinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(FA_D.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_D.indexOf(d)));
}

/** پارس ورودی متنی شمسی کاربر (مثل «۱۴۰۴/۹/۱») به ISO؛ اگر نامعتبر بود null */
export function parseJalaliInput(text: string): string | null {
  const parts = latinDigits(text.trim()).split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [jy, jm, jd] = parts.map(Number);
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return null;
  if (jy < 1200 || jy > 1600 || jm < 1 || jm > 12) return null;
  const maxDay = jm <= 6 ? 31 : 30;
  if (jd < 1 || jd > maxDay) return null;
  return jalaliToIso(jy, jm, jd);
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtMoney(n: number): string {
  return n.toLocaleString("fa-IR") + " ریال";
}
