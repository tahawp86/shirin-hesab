// شیرین حساب — استخراج پالت رنگی PDF از لوگوی کاربر (canvas)
// خروجی: {primary, dark, light, accent} به‌صورت hex — در کلید تنظیمی pdf_palette ذخیره می‌شود.
export interface PdfPalette {
  primary: string;
  dark: string;
  light: string;
  accent: string;
}

interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** نرمال‌سازی رنگ اصلی طوری که متن سفید روی آن خوانا بماند */
function normalizePrimary(c: Hsl): Hsl {
  return {
    h: c.h,
    s: clamp(Math.max(c.s, 0.38), 0.38, 0.85),
    l: clamp(c.l, 0.36, 0.54),
  };
}

interface Bucket {
  count: number;
  sumS: number;
  sumL: number;
  sumH: number;
}

export async function extractPdfPalette(dataUrl: string): Promise<PdfPalette> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("بارگذاری تصویر لوگو ناموفق بود"));
    img.src = dataUrl;
  });

  const SIZE = 64;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas در دسترس نیست");
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  // سطل‌های رنگی بر اساس ۳۶ قطاع hue (۱۰درجه‌ای)
  const HUES = 36;
  const buckets: Bucket[] = Array.from({ length: HUES }, () => ({
    count: 0, sumS: 0, sumL: 0, sumH: 0,
  }));
  let grayCount = 0;
  let grayS = 0, grayL = 0;
  let visible = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 180) continue; // پیکسل‌های شفاف/نیمه‌شفاف پس‌زمینه حساب نمی‌شوند
    const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    visible++;
    if (hsl.s < 0.12) {
      grayCount++;
      grayS += hsl.s;
      grayL += hsl.l;
      continue;
    }
    const idx = Math.min(HUES - 1, Math.floor(hsl.h / 10));
    const b = buckets[idx];
    b.count++;
    b.sumS += hsl.s;
    b.sumL += hsl.l;
    b.sumH += hsl.h;
  }

  function bucketColor(b: Bucket): Hsl {
    return { h: b.sumH / b.count, s: b.sumS / b.count, l: b.sumL / b.count };
  }

  // رنگ اصلی: پرتکرارترین قطاعِ به‌اندازه‌ی کافی اشباع‌شده
  let primary: Hsl | null = null;
  let bestScore = -1;
  for (const b of buckets) {
    if (b.count === 0) continue;
    const avgS = b.sumS / b.count;
    if (avgS < 0.22) continue;
    const score = b.count * (0.3 + avgS);
    if (score > bestScore) {
      bestScore = score;
      primary = bucketColor(b);
    }
  }
  if (!primary) {
    // لوگوی تک‌رنگ/خاکستری/بی‌اشباع: پرتکرارترین قطاع یا میانگین خاکستری
    let dom: Bucket | null = null;
    for (const b of buckets) if (!dom || b.count > dom.count) dom = b;
    if (dom && dom.count > 0) primary = bucketColor(dom);
    else if (visible > 0)
      primary = { h: 36, s: grayCount ? grayS / grayCount : 0, l: grayCount ? grayL / grayCount : 0.5 };
    else primary = { h: 36, s: 0.55, l: 0.46 }; // طلایی پیش‌فرض برنامه
  }

  const p = normalizePrimary(primary);

  // رنگ دوم: قطاعی با فاصله‌ی hue کافی از اصلی و وزن مناسب
  let accent: Hsl | null = null;
  let bestAccent = -1;
  for (const b of buckets) {
    if (b.count === 0) continue;
    const c = bucketColor(b);
    const dh = Math.min(Math.abs(c.h - p.h), 360 - Math.abs(c.h - p.h));
    if (dh < 30 || c.s < 0.18) continue;
    const score = b.count * (0.3 + c.s);
    if (score > bestAccent) {
      bestAccent = score;
      accent = c;
    }
  }
  const acc = accent
    ? { h: accent.h, s: clamp(Math.max(accent.s, 0.35), 0.35, 0.85), l: clamp(accent.l, 0.38, 0.56) }
    : { h: p.h + 42, s: p.s, l: p.l }; // مشتق آنالوگ از رنگ اصلی

  return {
    primary: hslToHex(p.h, p.s, p.l),
    dark: hslToHex(p.h, clamp(p.s * 1.05, 0, 0.9), clamp(p.l * 0.52, 0.14, 0.3)),
    light: hslToHex(p.h, clamp(p.s * 0.55, 0.08, 0.5), 0.94),
    accent: hslToHex(acc.h, acc.s, acc.l),
  };
}
