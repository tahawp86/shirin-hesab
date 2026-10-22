// خروجی PDF فاکتور و صورتحساب مشتری
// رندر روی <canvas> (متن فارسی را canvas خودش درست شکل می‌دهد)،
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
  paidAmount?: number;        // مبلغ پرداخت‌شده (برای باکس جمع‌بندی)
  discountAmount?: number;    // تخفیف کلی فاکتور (مبلغی)
  dueDateJalali?: string | null; // تاریخ سررسید شمسی نمایشی (اختیاری)
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

// لوگوی اختصاصی کاربر (data URL) — لوگوی پیش‌فرض برنامه در PDF استفاده نمی‌شود.
// اول wrapper ‏getUserLogo (در api.ts) و در صورت نبودنش کلید تنظیمی user_logo.
// نبود لوگو یعنی سربرگ بدون عکس، فقط با نام و تماس قناد.
async function fetchUserLogo(): Promise<string | null> {
  try {
    const withLogo = api as typeof api & { getUserLogo?: () => Promise<string | null> };
    if (typeof withLogo.getUserLogo === "function") {
      const url = await withLogo.getUserLogo();
      if (url) return url;
    }
  } catch {
    /* wrapper یا بک‌اندش در دسترس نیست */
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

/** مسیر مستطیل گوشه‌گرد (بدون اتکا به roundRect مرورگر) */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

// ── چیدمان صفحه (پیکسل canvas؛ صفحه با نسبت A4 ثابت تا خروجی چندصفحه‌ای یکدست بماند) ──
const PAGE_W = 1240;
const PAGE_H = Math.round((PAGE_W * 297) / 210); // 1753
const M = 80; // حاشیه کناری
const HEAD_H = 62;
const ROW_H = 56;
const BOTTOM_PAD = 70;

/** هندسه‌ی سربرگ برند بر اساس تعداد ردیف‌های قاب (شماره/تاریخ/سررسید) */
function brandGeometry(frameCount: number): { boxH: number; dividerY: number; custY: number; tableTop: number } {
  const boxH = frameCount * 48 + 24;
  const bandH = boxH + 4;
  const dividerY = 54 + bandH + 18;
  const custY = dividerY + 44;
  return { boxH, dividerY, custY, tableTop: custY + 32 };
}

/** ارتفاع باکس جمع‌بندی بر اساس تعداد ردیف‌هایش */
function totalsBoxH(rowCount: number): number {
  const divider = 40 + (rowCount - 1) * 52 + 24;
  return divider + 12 + 60 + 12;
}

interface BrandOpts {
  confName?: string;
  confPhone?: string;
  frameRows: Array<[string, string]>;
  title: string;
  customerName: string;
}

/** سربرگ صفحه‌ی اول: لوگو + نام و تماس (راست) و قاب اطلاعات سند (چپ) */
function drawBrandHeader(
  ctx: CanvasRenderingContext2D, palette: PdfPalette, logo: HTMLImageElement | null, o: BrandOpts
): void {
  const x0 = M;
  const x1 = PAGE_W - M;
  const top = 54;
  const geo = brandGeometry(o.frameRows.length);
  const bandH = geo.boxH + 4;

  // قاب اطلاعات سند
  const boxW = 336;
  const boxX = x0;
  const boxY = top + 2;
  ctx.fillStyle = palette.light;
  rr(ctx, boxX, boxY, boxW, geo.boxH, 16);
  ctx.fill();
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  rr(ctx, boxX, boxY, boxW, geo.boxH, 16);
  ctx.stroke();
  o.frameRows.forEach(([label, value], i) => {
    const cy = boxY + 36 + i * 48;
    ctx.font = `400 25px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    const lt = label + ":";
    ctx.fillText(lt, boxX + boxW - 20, cy);
    const lw = ctx.measureText(lt + " ").width;
    ctx.font = `700 29px ${FONT}`;
    ctx.fillStyle = palette.dark;
    ctx.fillText(value, boxX + boxW - 20 - lw - 10, cy);
  });

  // لوگو (راست‌ترین نقطه) و نام/تماس در کنارش
  let textRight = x1;
  if (logo) {
    const s = Math.min(250 / logo.width, 108 / logo.height);
    const w = logo.width * s;
    const h = logo.height * s;
    ctx.drawImage(logo, x1 - w, top + (bandH - h) / 2, w, h);
    textRight = x1 - w - 24;
  }
  ctx.textAlign = "right";
  if (o.confName) {
    ctx.font = `700 44px ${FONT}`;
    ctx.fillStyle = palette.dark;
    ctx.fillText(o.confName, textRight, top + (o.confPhone ? bandH / 2 - 20 : bandH / 2));
    if (o.confPhone) {
      ctx.font = `400 27px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.fillText("تلفن: " + o.confPhone, textRight, top + bandH / 2 + 28);
    }
  }

  // خط جداکننده
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, geo.dividerY);
  ctx.lineTo(x1, geo.dividerY);
  ctx.stroke();

  // سطر مشتری (راست) و عنوان سند (چپ)
  ctx.font = `400 30px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  const cl = "مشتری:";
  ctx.fillText(cl, x1, geo.custY);
  const clw = ctx.measureText(cl + " ").width;
  ctx.font = `700 32px ${FONT}`;
  ctx.fillStyle = palette.dark;
  ctx.fillText(o.customerName, x1 - clw - 12, geo.custY);
  ctx.font = `700 34px ${FONT}`;
  ctx.fillStyle = palette.primary;
  ctx.textAlign = "left";
  ctx.fillText(o.title, x0, geo.custY);
}

/** سربرگ صفحه‌های ادامه */
function drawContinuationHeader(
  ctx: CanvasRenderingContext2D, palette: PdfPalette, confName: string | undefined, contText: string
): void {
  const x0 = M;
  const x1 = PAGE_W - M;
  ctx.textAlign = "right";
  if (confName) {
    ctx.font = `700 29px ${FONT}`;
    ctx.fillStyle = palette.dark;
    ctx.fillText(confName, x1, 88);
    const nw = ctx.measureText(confName + " ").width;
    ctx.font = `400 26px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText("— " + contText, x1 - nw - 8, 88);
  } else {
    ctx.font = `400 26px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(contText, x1, 88);
  }
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, 118);
  ctx.lineTo(x1, 118);
  ctx.stroke();
}

/** باکس جمع‌بندی (ردیف‌های جمع + نوار مانده با رنگ dark) + جای امضا + سطر تشکر */
function drawTotalsBox(
  ctx: CanvasRenderingContext2D, palette: PdfPalette,
  yTop: number, rows: Array<[string, string]>, balanceLabel: string, balanceText: string
): void {
  const x0 = M;
  const x1 = PAGE_W - M;
  const boxW = 500;
  const boxH = totalsBoxH(rows.length);
  ctx.fillStyle = "#ffffff";
  rr(ctx, x0, yTop, boxW, boxH, 16);
  ctx.fill();
  ctx.strokeStyle = palette.dark;
  ctx.lineWidth = 2.5;
  rr(ctx, x0, yTop, boxW, boxH, 16);
  ctx.stroke();

  rows.forEach(([label, value], i) => {
    const cy = yTop + 40 + i * 52;
    ctx.font = `400 28px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(label + ":", x0 + boxW - 22, cy);
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = palette.dark;
    ctx.textAlign = "left";
    ctx.fillText(value, x0 + 22, cy);
  });

  const dividerY = yTop + 40 + (rows.length - 1) * 52 + 24;
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0 + 18, dividerY);
  ctx.lineTo(x0 + boxW - 18, dividerY);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // نوار مانده با رنگ dark و متن سفید
  ctx.fillStyle = palette.dark;
  rr(ctx, x0 + 10, dividerY + 12, boxW - 20, 60, 10);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 28px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(balanceLabel + ":", x0 + boxW - 32, dividerY + 42);
  ctx.font = `700 30px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText(balanceText, x0 + 32, dividerY + 42);

  // جای امضا (سمت راست، هم‌تراز باکس)
  ctx.font = `400 26px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText("امضا و مهر فروشنده:", x1, yTop + 30);
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1 - 360, yTop + 150);
  ctx.lineTo(x1, yTop + 150);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // سطر تشکر
  ctx.font = `400 27px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.fillText("با تشکر از خرید شما", PAGE_W / 2, yTop + boxH + 52);
}

interface ColSpec { w: number; align: "center" | "right" | "left"; title: string }

function colRanges(cols: ColSpec[]): Array<{ x0: number; x1: number; align: ColSpec["align"]; title: string }> {
  const tableW = PAGE_W - M * 2;
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  const widths = cols.map((c) => (c.w === 0 ? tableW - fixed : c.w)); // ستون با عرض صفر = انعطاف‌پذیر
  let xr = PAGE_W - M;
  return cols.map((c, i) => {
    const r = { x0: xr - widths[i], x1: xr, align: c.align, title: c.title };
    xr -= widths[i];
    return r;
  });
}

const cellX = (r: { x0: number; x1: number; align: ColSpec["align"] }): number =>
  r.align === "center" ? (r.x0 + r.x1) / 2 : r.align === "right" ? r.x1 - 18 : r.x0 + 18;

/** سربرگ جدول + قاب دور جدول یک صفحه را می‌کشد و y بعد از سربرگ را برمی‌گرداند */
function drawTableHead(ctx: CanvasRenderingContext2D, palette: PdfPalette, ranges: ReturnType<typeof colRanges>, y: number): number {
  const x0 = M;
  const tableW = PAGE_W - M * 2;
  ctx.fillStyle = palette.primary;
  ctx.fillRect(x0, y, tableW, HEAD_H);
  ctx.font = `700 30px ${FONT}`;
  ctx.fillStyle = HEAD_FG;
  for (const r of ranges) {
    ctx.textAlign = r.align;
    ctx.fillText(r.title, cellX(r), y + HEAD_H / 2);
  }
  return y + HEAD_H;
}

/** خطوط نرم یک ردیف (جداکننده + عمودی‌ها) */
function strokeRowLines(ctx: CanvasRenderingContext2D, palette: PdfPalette, ranges: ReturnType<typeof colRanges>, y: number): void {
  const x0 = M;
  const x1 = PAGE_W - M;
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y + ROW_H);
  ctx.lineTo(x1, y + ROW_H);
  for (const r of ranges) {
    ctx.moveTo(r.x0 + 1, y);
    ctx.lineTo(r.x0 + 1, y + ROW_H);
  }
  ctx.moveTo(x1 - 1, y);
  ctx.lineTo(x1 - 1, y + ROW_H);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function frameTable(ctx: CanvasRenderingContext2D, palette: PdfPalette, top: number, height: number): void {
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 2;
  ctx.strokeRect(M, top, PAGE_W - M * 2, height);
  ctx.globalAlpha = 1;
}

interface PageChunk { start: number; count: number; summaryOnly?: boolean }

/** تقسیم ردیف‌ها بین صفحه‌ها با توجه به ظرفیت هر صفحه و فضای لازم جمع‌بندی در صفحه‌ی آخر */
function paginate(rowCount: number, firstTop: number, summaryNeed: number): PageChunk[] {
  const contTop = 142;
  const capacity = (page: number): number =>
    Math.max(1, Math.floor((PAGE_H - BOTTOM_PAD - (page === 0 ? firstTop : contTop) - HEAD_H) / ROW_H));
  const chunks: PageChunk[] = [];
  let idx = 0;
  let pg = 0;
  if (rowCount === 0) chunks.push({ start: 0, count: 0 });
  while (idx < rowCount) {
    const take = Math.min(capacity(pg), rowCount - idx);
    chunks.push({ start: idx, count: take });
    idx += take;
    pg++;
  }
  const lastChunk = chunks[chunks.length - 1];
  const lastFree = capacity(chunks.length - 1) * ROW_H - lastChunk.count * ROW_H;
  if (lastFree < summaryNeed) chunks.push({ start: rowCount, count: 0, summaryOnly: true });
  return chunks;
}

function newPageCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement("canvas");
  cv.width = PAGE_W;
  cv.height = PAGE_H;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.textBaseline = "middle";
  return [cv, ctx];
}

/** خالص یک ردیف فاکتور بعد از تخفیف درصدی خودش (هماهنگ با ویرایشگر) */
const lineNet = (it: InvoiceItem): number => {
  const pct = Math.min(100, Math.max(0, it.discount_pct ?? 0));
  return Math.round(it.qty * it.unit_price * (1 - pct / 100));
};

/** رندر فاکتور به‌صورت یک یا چند صفحه‌ی canvas؛ در فاکتورهای بلند هدر جدول هر صفحه تکرار می‌شود */
export async function renderInvoicePages(
  data: InvoicePdfData,
  opts?: { logoUrl?: string | null; palette?: PdfPalette }
): Promise<HTMLCanvasElement[]> {
  const palette = opts?.palette ?? DEFAULT_PALETTE;
  const logo = opts?.logoUrl ? await loadImageFromSrc(opts.logoUrl) : null;
  const rows = data.items;
  const x0 = M;
  const tableW = PAGE_W - M * 2;

  const frameRows: Array<[string, string]> = [
    ["شماره فاکتور", data.invoiceNumber],
    ["تاریخ", data.dateJalali],
  ];
  if (data.dueDateJalali) frameRows.push(["سررسید", data.dueDateJalali]);
  const firstTop = brandGeometry(frameRows.length).tableTop;

  const ranges = colRanges([
    { w: 90, align: "center", title: "ردیف" },
    { w: 0, align: "right", title: "شرح کالا" },
    { w: 120, align: "center", title: "تعداد" },
    { w: 235, align: "center", title: "قیمت واحد" },
    { w: 255, align: "center", title: "مبلغ (ریال)" },
  ]);

  // ردیف‌های باکس جمع‌بندی
  const subtotal = rows.reduce((s, it) => s + lineNet(it), 0);
  const invDiscount = Math.max(0, Math.round(data.discountAmount ?? 0));
  const grand = Math.max(0, subtotal - invDiscount);
  const paid = Math.max(0, Math.round(data.paidAmount ?? 0));
  const sumRows: Array<[string, string]> = [];
  if (invDiscount > 0) {
    sumRows.push(["جمع ردیف‌ها", faGrouped(subtotal) + " ریال"]);
    sumRows.push(["تخفیف کلی", "−" + faGrouped(invDiscount) + " ریال"]);
  }
  sumRows.push(["جمع کل", faGrouped(grand) + " ریال"]);
  sumRows.push(["پرداخت‌شده", faGrouped(paid) + " ریال"]);
  const summaryNeed = 34 + totalsBoxH(sumRows.length) + 92;

  const chunks = paginate(rows.length, firstTop, summaryNeed);
  const pages: HTMLCanvasElement[] = [];
  chunks.forEach((chunk, pageIdx) => {
    const [cv, ctx] = newPageCanvas();
    if (pageIdx === 0) {
      drawBrandHeader(ctx, palette, logo, {
        confName: data.confectionerName, confPhone: data.confectionerPhone,
        frameRows, title: "فاکتور فروش", customerName: data.customerName,
      });
    } else {
      drawContinuationHeader(ctx, palette, data.confectionerName, `ادامه‌ی فاکتور شماره‌ی ${data.invoiceNumber}`);
    }

    let y = pageIdx === 0 ? firstTop : 142;
    if (!chunk.summaryOnly) {
      y = drawTableHead(ctx, palette, ranges, y);
      ctx.font = `400 29px ${FONT}`;
      for (let k = 0; k < chunk.count; k++) {
        const gi = chunk.start + k;
        const it = rows[gi];
        ctx.fillStyle = gi % 2 ? palette.light : "#ffffff";
        ctx.fillRect(x0, y, tableW, ROW_H);
        const pct = it.discount_pct ?? 0;
        const nameText = it.name + (pct > 0 ? ` (تخفیف ${faPlain(pct)}٪)` : "");
        const cells = [
          faPlain(gi + 1),
          ellipsize(ctx, nameText, ranges[1].x1 - ranges[1].x0 - 36),
          faPlain(it.qty),
          faGrouped(Math.round(it.unit_price)),
          faGrouped(lineNet(it)),
        ];
        ranges.forEach((r, ci) => {
          ctx.textAlign = r.align;
          ctx.fillStyle = palette.dark;
          ctx.fillText(cells[ci], cellX(r), y + ROW_H / 2);
        });
        strokeRowLines(ctx, palette, ranges, y);
        y += ROW_H;
      }
      frameTable(ctx, palette, pageIdx === 0 ? firstTop : 142, HEAD_H + chunk.count * ROW_H);
    }

    if (pageIdx === chunks.length - 1) {
      drawTotalsBox(ctx, palette, y + (chunk.summaryOnly ? 64 : 34), sumRows, "مانده قابل پرداخت", faGrouped(grand - paid) + " ریال");
    }
    pages.push(cv);
  });
  return pages;
}

/** ساخت jsPDF چندصفحه‌ای از کانوس‌ها و ذخیره (Tauri dialog و در غیر این صورت دانلود مرورگر) */
async function savePagesAsPdf(pages: HTMLCanvasElement[], fileName: string): Promise<void> {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = 210;
  const pageH = 297;
  const margin = 12;
  pages.forEach((cv, i) => {
    if (i > 0) doc.addPage();
    let w = pageW - margin * 2;
    let h = (cv.height / cv.width) * w;
    if (h > pageH - margin * 2) {
      h = pageH - margin * 2;
      w = (cv.width / cv.height) * h;
    }
    doc.addImage(cv.toDataURL("image/png"), "PNG", (pageW - w) / 2, (pageH - h) / 2, w, h);
  });

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

/** ساخت PDF از فاکتور و ذخیره آن */
export async function exportInvoicePdf(data: InvoicePdfData): Promise<void> {
  const [logoUrl, palette] = await Promise.all([fetchUserLogo(), fetchPalette()]);
  const pages = await renderInvoicePages(data, { logoUrl, palette });
  await savePagesAsPdf(pages, `invoice-${data.fileNumber || "new"}.pdf`);
}

// ── صورتحساب مشتری (گردش + مانده) ──
// قرارداد صدا زدن با صفحه‌ی فاکتورهای مشتری (EAgent3) است: داده‌ی آماده‌ی نمایش
// (تاریخ شمسی و شرح هر ردیف) را می‌گیرد و فقط رندر و ذخیره با این تابع است.

export interface StatementPdfRow {
  dateJalali: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface StatementPdfData {
  customerName: string;
  customerPhone?: string;
  generatedJalali: string; // تاریخ صدور صورتحساب (شمسی)
  rows: StatementPdfRow[];
  totalInvoiced: number;
  totalPaid: number;
  debt: number;
  confectionerName?: string;
  confectionerPhone?: string;
}

/** صورتحساب مشتری به‌صورت PDF (گردش زمانی + مانده) با همان لوگو و پالت فاکتور */
export async function generateStatementPdf(data: StatementPdfData): Promise<void> {
  const [logoUrl, palette] = await Promise.all([fetchUserLogo(), fetchPalette()]);
  const logo = logoUrl ? await loadImageFromSrc(logoUrl) : null;
  const rows = data.rows;

  const frameRows: Array<[string, string]> = [
    ["نوع سند", "صورتحساب"],
    ["تاریخ صدور", data.generatedJalali],
  ];
  const firstTop = brandGeometry(frameRows.length).tableTop;

  const ranges = colRanges([
    { w: 70, align: "center", title: "ردیف" },
    { w: 150, align: "center", title: "تاریخ" },
    { w: 0, align: "right", title: "شرح" },
    { w: 200, align: "center", title: "بدهکار (ریال)" },
    { w: 200, align: "center", title: "بستانکار (ریال)" },
    { w: 210, align: "center", title: "مانده (ریال)" },
  ]);

  const sumRows: Array<[string, string]> = [
    ["جمع بدهکار", faGrouped(data.totalInvoiced) + " ریال"],
    ["جمع بستانکار", faGrouped(data.totalPaid) + " ریال"],
  ];
  const summaryNeed = 34 + totalsBoxH(sumRows.length) + 92;

  const chunks = paginate(rows.length, firstTop, summaryNeed);
  const pages: HTMLCanvasElement[] = [];
  chunks.forEach((chunk, pageIdx) => {
    const [cv, ctx] = newPageCanvas();
    if (pageIdx === 0) {
      drawBrandHeader(ctx, palette, logo, {
        confName: data.confectionerName, confPhone: data.confectionerPhone,
        frameRows, title: "صورتحساب مشتری",
        customerName: data.customerName + (data.customerPhone ? ` — تلفن: ${data.customerPhone}` : ""),
      });
    } else {
      drawContinuationHeader(ctx, palette, data.confectionerName, `ادامه‌ی صورتحساب ${data.customerName}`);
    }

    let y = pageIdx === 0 ? firstTop : 142;
    if (!chunk.summaryOnly) {
      y = drawTableHead(ctx, palette, ranges, y);
      ctx.font = `400 28px ${FONT}`;
      for (let k = 0; k < chunk.count; k++) {
        const gi = chunk.start + k;
        const e = rows[gi];
        ctx.fillStyle = gi % 2 ? palette.light : "#ffffff";
        ctx.fillRect(M, y, PAGE_W - M * 2, ROW_H);
        const cells = [
          faPlain(gi + 1),
          e.dateJalali,
          ellipsize(ctx, e.description, ranges[2].x1 - ranges[2].x0 - 36),
          e.debit > 0 ? faGrouped(e.debit) : "—",
          e.credit > 0 ? faGrouped(e.credit) : "—",
          faGrouped(e.balance),
        ];
        ranges.forEach((r, ci) => {
          ctx.textAlign = r.align;
          ctx.fillStyle = palette.dark;
          ctx.fillText(cells[ci], cellX(r), y + ROW_H / 2);
        });
        strokeRowLines(ctx, palette, ranges, y);
        y += ROW_H;
      }
      frameTable(ctx, palette, pageIdx === 0 ? firstTop : 142, HEAD_H + chunk.count * ROW_H);
    }

    if (pageIdx === chunks.length - 1) {
      drawTotalsBox(ctx, palette, y + (chunk.summaryOnly ? 64 : 34), sumRows, "مانده نهایی", faGrouped(data.debt) + " ریال");
    }
    pages.push(cv);
  });

  await savePagesAsPdf(pages, "statement.pdf");
}
