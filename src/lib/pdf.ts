// خروجی PDF فاکتور
// رندر فاکتور روی <canvas> (متن فارسی را canvas خودش درست شکل می‌دهد)،
// قرار دادن تصویر در PDF با jsPDF و ذخیره از طریق کامندهای Tauri
// (در صورت نبودن بک‌اند، fallback به doc.save()).
import { api, type InvoiceItem } from "./api";
import type { jsPDF as JsPdfDoc } from "jspdf";

// jsPDF سنگین است و عمداً وارد باندل اولیه نمی‌شود؛ تایپش فقط type-only است
// و خود کتابخانه (نسخه‌ی UMD در assets) تنبل و فقط موقع «خروجی PDF» لود می‌شود
// تا بالا آمدن برنامه روی سیستم‌های ضعیف سبک و سریع بماند.
type JsPdfCtor = new (options: { unit: "mm"; format: "a4"; orientation: "portrait" }) => JsPdfDoc;

const getJsPdfGlobal = (): { jsPDF: JsPdfCtor } | undefined =>
  (window as unknown as { jspdf?: { jsPDF: JsPdfCtor } }).jspdf;

let jsPdfPromise: Promise<JsPdfCtor> | null = null;

function loadJsPdf(): Promise<JsPdfCtor> {
  const existing = getJsPdfGlobal()?.jsPDF;
  if (existing) return Promise.resolve(existing);
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise<JsPdfCtor>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "assets/jspdf.umd.min.js";
      script.async = true;
      script.onload = () => {
        const ctor = getJsPdfGlobal()?.jsPDF;
        if (ctor) resolve(ctor);
        else reject(new Error("کتابخانه‌ی PDF لود نشد"));
      };
      script.onerror = () => reject(new Error("کتابخانه‌ی PDF لود نشد"));
      document.head.appendChild(script);
    }).catch((e: unknown) => {
      jsPdfPromise = null; // تلاش بعدی بتواند دوباره سعی کند
      throw e;
    });
  }
  return jsPdfPromise;
}

export interface InvoicePdfData {
  invoiceNumber: string; // شماره فاکتور یا «خودکار»
  fileNumber?: string;   // شماره لاتین برای نام فایل PDF
  dateJalali: string;    // تاریخ شمسی نمایشی
  customerName: string;
  items: InvoiceItem[];
  confectionerName?: string;  // نام قناد (صادرکننده)
  confectionerPhone?: string; // تلفن قناد
}

const FONT = '"Vazirmatn","B Nazanin",Tahoma,sans-serif';
const MUTED = "#5b7290";
const HEAD_FG = "#ffffff";

// پالت رنگی PDF — از رنگ‌های لوگوی کاربر استخراج و در تنظیمات (کلید pdf_palette)
// ذخیره می‌شود؛ اگر لوگو/پالتی نباشد، پالت پیش‌فرض آبی/سفید استفاده می‌شود.
export interface PdfPalette { primary: string; dark: string; light: string; accent: string; }
const DEFAULT_PALETTE: PdfPalette = { primary: "#1e5aa8", dark: "#1c2f4a", light: "#eaf3fd", accent: "#1e5aa8" };

const isHexColor = (v: unknown): v is string =>
  typeof v === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);

async function fetchPalette(): Promise<PdfPalette> {
  try {
    const raw = await api.getSetting("pdf_palette");
    if (!raw) return DEFAULT_PALETTE;
    const p = JSON.parse(raw) as Partial<PdfPalette>;
    return {
      primary: isHexColor(p.primary) ? p.primary : DEFAULT_PALETTE.primary,
      dark: isHexColor(p.dark) ? p.dark : DEFAULT_PALETTE.dark,
      light: isHexColor(p.light) ? p.light : DEFAULT_PALETTE.light,
      accent: isHexColor(p.accent) ? p.accent : DEFAULT_PALETTE.accent,
    };
  } catch {
    return DEFAULT_PALETTE;
  }
}

// لوگوی اختصاصی کاربر (data URL) — لوگوی پیش‌فرض برنامه دیگر در PDF استفاده نمی‌شود.
// wrapper ‏getUserLogo را ایجنت۵ به api.ts اضافه می‌کند؛ تا آن موقع از کلید
// تنظیمی user_logo خوانده می‌شود. نبود لوگو یعنی سربرگ متنی با نام قناد.
async function fetchUserLogo(): Promise<string | null> {
  try {
    const withLogo = api as typeof api & { getUserLogo?: () => Promise<string | null> };
    if (typeof withLogo.getUserLogo === "function") {
      const url = await withLogo.getUserLogo();
      if (url) return url;
    }
  } catch {
    /* wrapper یا بک‌اندش هنوز آماده نیست */
  }
  try {
    return await api.getSetting("user_logo");
  } catch {
    return null;
  }
}

function loadImageFromSrc(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const faGrouped = (n: number): string => n.toLocaleString("fa-IR");
const faPlain = (n: number): string => n.toLocaleString("fa-IR", { useGrouping: false });

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** رندر فاکتور روی canvas و برگرداندن آن */
export async function renderInvoiceCanvas(
  data: InvoicePdfData,
  opts?: { logoUrl?: string | null; palette?: PdfPalette }
): Promise<HTMLCanvasElement> {
  const W = 1240;
  const M = 80; // حاشیه کناری
  const palette = opts?.palette ?? DEFAULT_PALETTE;
  const logo = opts?.logoUrl ? await loadImageFromSrc(opts.logoUrl) : null;
  const rows = data.items;

  const meta: Array<[string, string]> = [
    ["شماره فاکتور", data.invoiceNumber],
    ["تاریخ", data.dateJalali],
    ["مشتری", data.customerName],
  ];
  if (data.confectionerName) {
    meta.push(["صادرکننده", data.confectionerName + (data.confectionerPhone ? " — تلفن: " + data.confectionerPhone : "")]);
  }
  const headH = 62;
  const rowH = 58;
  const totalRowH = 74;
  const tableH = headH + rows.length * rowH + totalRowH;
  // ارتفاع کل = لوگو + عنوان + مشخصات + جدول + پانوشت + حاشیه‌ها
  const H = 60 + 170 + 30 + 76 + 34 + meta.length * 54 + 44 + tableH + 70 + 56 + 70;

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";

  let y = 60;

  // سربرگ: لوگوی اختصاصی کاربر؛ اگر لوگویی نباشد، تیتر متنی با نام قناد
  if (logo) {
    const s = Math.min(560 / logo.width, 170 / logo.height);
    const w = logo.width * s;
    const h = logo.height * s;
    ctx.drawImage(logo, (W - w) / 2, y + (170 - h) / 2, w, h);
  } else if (data.confectionerName) {
    ctx.fillStyle = palette.dark;
    ctx.font = `700 58px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(data.confectionerName, W / 2, y + 68);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(W / 2 - 90, y + 118, 180, 5);
  }
  y += 170 + 30;

  // عنوان
  ctx.fillStyle = palette.dark;
  ctx.font = `700 48px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("فاکتور فروش", W / 2, y + 34);
  y += 76 + 34;

  // مشخصات فاکتور (راست‌چین)
  ctx.textAlign = "right";
  for (const [label, value] of meta) {
    ctx.font = `400 30px ${FONT}`;
    ctx.fillStyle = MUTED;
    const labelText = label + ":";
    ctx.fillText(labelText, W - M, y + 27);
    const lw = ctx.measureText(labelText + " ").width;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = palette.dark;
    ctx.fillText(value, W - M - lw - 14, y + 27);
    y += 54;
  }
  y += 44;

  // جدول آیتم‌ها — ستون‌ها از راست به چپ
  const x0 = M;
  const x1 = W - M;
  const tableW = x1 - x0;
  const cols = [
    { w: 90, align: "center" as const, title: "ردیف" },
    { w: 0, align: "right" as const, title: "شرح کالا" }, // عرض انعطاف‌پذیر
    { w: 120, align: "center" as const, title: "تعداد" },
    { w: 235, align: "center" as const, title: "قیمت واحد" },
    { w: 255, align: "center" as const, title: "مبلغ (ریال)" },
  ];
  const fixedW = cols.reduce((s, c) => s + c.w, 0);
  cols[1].w = tableW - fixedW;
  let xr = x1;
  const ranges = cols.map((c) => {
    const r = { x0: xr - c.w, x1: xr, align: c.align, title: c.title };
    xr -= c.w;
    return r;
  });

  const cellX = (r: (typeof ranges)[number]): number =>
    r.align === "center" ? (r.x0 + r.x1) / 2 : r.align === "right" ? r.x1 - 18 : r.x0 + 18;

  // سربرگ جدول
  ctx.fillStyle = palette.primary;
  ctx.fillRect(x0, y, tableW, headH);
  ctx.font = `700 30px ${FONT}`;
  ctx.fillStyle = HEAD_FG;
  for (const r of ranges) {
    ctx.textAlign = r.align;
    ctx.fillText(r.title, cellX(r), y + headH / 2);
  }
  // خطوط عمودی سربرگ
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const r of ranges) {
    ctx.moveTo(r.x0 + 1, y);
    ctx.lineTo(r.x0 + 1, y + headH);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  y += headH;

  // ردیف‌های آیتم
  ctx.font = `400 29px ${FONT}`;
  rows.forEach((it, i) => {
    ctx.fillStyle = i % 2 ? palette.light : "#ffffff";
    ctx.fillRect(x0, y, tableW, rowH);
    const sum = Math.round(it.qty * it.unit_price);
    const cells = [
      faPlain(i + 1),
      ellipsize(ctx, it.name, ranges[1].x1 - ranges[1].x0 - 36),
      faPlain(it.qty),
      faGrouped(Math.round(it.unit_price)),
      faGrouped(sum),
    ];
    ranges.forEach((r, ci) => {
      ctx.textAlign = r.align;
      ctx.fillStyle = palette.dark;
      ctx.fillText(cells[ci], cellX(r), y + rowH / 2);
    });
    // جداکننده ردیف + خطوط عمودی
    ctx.strokeStyle = palette.accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y + rowH);
    ctx.lineTo(x1, y + rowH);
    for (const r of ranges) {
      ctx.moveTo(r.x0 + 1, y);
      ctx.lineTo(r.x0 + 1, y + rowH);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    y += rowH;
  });

  // ردیف جمع کل
  const grand = rows.reduce((s, it) => s + Math.round(it.qty * it.unit_price), 0);
  ctx.fillStyle = palette.light;
  ctx.fillRect(x0, y, tableW, totalRowH);
  ctx.font = `700 32px ${FONT}`;
  ctx.fillStyle = palette.dark;
  ctx.textAlign = "right";
  ctx.fillText("جمع کل:", ranges[1].x1 - 18, y + totalRowH / 2);
  ctx.textAlign = "center";
  ctx.fillText(faGrouped(grand) + " ریال", cellX(ranges[4]), y + totalRowH / 2);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.moveTo(x0, y + totalRowH);
  ctx.lineTo(x1, y + totalRowH);
  ctx.stroke();
  y += totalRowH + 70;

  // پانوشت
  ctx.font = `400 27px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.fillText("با تشکر از خرید شما", W / 2, y + 28);

  return cv;
}

/** ساخت PDF از فاکتور و ذخیره آن (Tauri dialog و در غیر این صورت دانلود مرورگر) */
export async function exportInvoicePdf(data: InvoicePdfData): Promise<void> {
  const [logoUrl, palette] = await Promise.all([fetchUserLogo(), fetchPalette()]);
  const canvas = await renderInvoiceCanvas(data, { logoUrl, palette });
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const pageW = 210;
  const pageH = 297;
  const margin = 12;
  let w = pageW - margin * 2;
  let h = (canvas.height / canvas.width) * w;
  if (h > pageH - margin * 2) {
    h = pageH - margin * 2;
    w = (canvas.width / canvas.height) * h;
  }
  doc.addImage(canvas.toDataURL("image/png"), "PNG", (pageW - w) / 2, (pageH - h) / 2, w, h);

  const fileName = `invoice-${data.fileNumber || "new"}.pdf`;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string | null>("save_pdf_dialog", { defaultName: fileName });
    if (!path) return; // کاربر انصراف داد
    const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    await invoke("write_pdf_file", { path, data: btoa(bin) });
  } catch {
    // حالت توسعه یا نبودن کامندهای بک‌اند: دانلود معمولی مرورگر
    doc.save(fileName);
  }
}
