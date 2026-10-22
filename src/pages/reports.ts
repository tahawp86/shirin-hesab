// شیرین حساب — صفحه‌ی گزارش‌ها (0.8.0)
// گزارش فروش دوره‌ای + نمودار روزانه (canvas دستی و سبک)، پرفروش‌ترین محصولات،
// گزارش بدهکاران با دسته‌بندی قدمت بدهی، و خروجی CSV (با BOM برای اکسل).
// بک‌اند: report_sales / report_top_products / report_debtors (EAgent1)
import { api, type DailySale, type Debtor } from "../lib/api";
import { fmtMoney, toJalali, todayIso } from "../lib/jalali";

type RangeKind = "today" | "month" | "custom";

const STYLE = `
<style>
/* پولیش ظاهری صفحه‌ی گزارش‌ها — محدود به همین صفحه (.rep-page) */
.rep-page .btn { transition: background .15s ease, transform .05s ease, opacity .15s ease; }
.rep-page .btn:active { transform: translateY(1px); }
.rep-page .btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
.rep-page .btn.danger:hover { background: #a93226; }
.rep-page .btn.ghost:hover { background: #e7dcc6; }
.rep-page input { transition: border-color .15s ease, box-shadow .15s ease; }
.rep-page input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(201, 138, 46, .15); outline: none; }
.rep-page .card h3 { margin: 0 0 12px; font-size: 16px; }
.rep-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.rep-head h2 { margin: 0; font-size: 20px; font-weight: 700; }
.rep-range { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.rep-range-btn.on { background: var(--accent); color: #fff; }
.rep-custom { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rep-hint { color: var(--muted); font-size: 12.5px; }
.rep-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 14px; }
@media (max-width: 640px) { .rep-stats { grid-template-columns: 1fr; } }
.rep-stat { background: #faf5ec; border: 1px solid #f0e4d2; border-radius: 10px; padding: 12px 14px; }
.rep-stat .lbl { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; }
.rep-stat .val { font-size: 20px; font-weight: 700; line-height: 1.4; }
.rep-buckets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px; }
@media (max-width: 640px) { .rep-buckets { grid-template-columns: 1fr; } }
.rep-page table th { background: #faf5ec; }
.rep-page table td { vertical-align: middle; }
.rep-page tbody tr { transition: background .15s ease; }
.rep-page tbody tr:hover td { background: #faf3e7; }
.rep-page tbody tr:last-child td { border-bottom: none; }
.rep-chart { width: 100%; height: 190px; display: block; }
.rep-chart-cap { color: var(--muted); font-size: 12.5px; text-align: center; margin-top: 6px; min-height: 18px; }
.rep-empty {
  text-align: center; color: var(--muted); padding: 26px 12px; margin: 0;
  border: 1.5px dashed #e8dcc4; border-radius: 10px; background: #fffdf8;
}
.rep-error { color: var(--danger); text-align: center; padding: 16px 0; margin: 0; }
.rep-loading { color: var(--muted); text-align: center; padding: 22px 0; margin: 0; }
.rep-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.rep-card-head h3 { margin: 0; }
.rep-age { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 12.5px; line-height: 1.7; white-space: nowrap; font-weight: 700; }
.rep-age.a1 { background: #fdf6e3; color: #8a6d1a; }
.rep-age.a2 { background: #fdeeda; color: #a3541a; }
.rep-age.a3 { background: #fbeeec; color: var(--danger); }
</style>`;

// ---------- ابزار تاریخ (تکیه بر toJalali خود برنامه برای درستی تبدیل) ----------

function jalaliParts(iso: string): { jy: number; jm: number; jd: number } {
  const latin = toJalali(iso).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  const [jy, jm, jd] = latin.split("/").map(Number);
  return { jy, jm, jd };
}

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function diffDays(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

function faNum(n: number): string {
  return n.toLocaleString("fa-IR");
}

// ---------- خروجی CSV با BOM (قابل باز شدن مستقیم در اکسل) ----------

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]): void {
  const cell = (v: string | number): string => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv =
    "\ufeff" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function esc(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

// ---------- دسته‌بندی قدمت بدهی ----------

function ageBucket(ageDays: number): { label: string; cls: string } {
  if (ageDays <= 30) return { label: "۰ تا ۳۰ روز", cls: "a1" };
  if (ageDays <= 60) return { label: "۳۱ تا ۶۰ روز", cls: "a2" };
  return { label: "بالای ۶۰ روز", cls: "a3" };
}

export function renderReports(root: HTMLElement): void {
  const today = todayIso();
  const monthStart = addDaysIso(today, -(jalaliParts(today).jd - 1));

  root.innerHTML = `
${STYLE}
<div dir="rtl" class="rep-page">
  <div class="rep-head"><h2>گزارش‌ها</h2></div>

  <div class="card">
    <h3>گزارش فروش</h3>
    <div class="rep-range">
      <button class="btn ghost rep-range-btn" data-range="today">امروز</button>
      <button class="btn ghost rep-range-btn on" data-range="month">این ماه</button>
      <button class="btn ghost rep-range-btn" data-range="custom">بازه‌ی دلخواه</button>
      <span class="rep-custom" id="rep-custom" style="display:none">
        از <input type="date" id="rep-from" value="${monthStart}" />
        تا <input type="date" id="rep-to" value="${today}" />
      </span>
      <button class="btn" id="rep-load">تهیه‌ی گزارش</button>
      <span class="rep-hint" id="rep-range-fa"></span>
    </div>
    <div id="rep-sales-body"><p class="rep-loading">در حال بارگذاری…</p></div>
  </div>

  <div class="card">
    <div class="rep-card-head">
      <h3>پرفروش‌ترین محصولات</h3>
      <button class="btn ghost" id="rep-top-csv" disabled>خروجی اکسل</button>
    </div>
    <div id="rep-top-body"><p class="rep-loading">در حال بارگذاری…</p></div>
  </div>

  <div class="card">
    <div class="rep-card-head">
      <h3>گزارش بدهکاران</h3>
      <button class="btn ghost" id="rep-debt-csv" disabled>خروجی اکسل</button>
    </div>
    <div id="rep-debt-body"><p class="rep-loading">در حال بارگذاری…</p></div>
  </div>
</div>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    root.querySelector<T>(`#${id}`);

  let kind: RangeKind = "month";
  let chartDays: DailySale[] = [];
  let chartGeom: { step: number; plotW: number; right: number } | null = null;
  let topRows: { name: string; qty: number; amount: number; profit: number }[] = [];
  let debtRows: (Debtor & { age: number })[] = [];

  function currentRange(): { from: string; to: string } {
    if (kind === "today") return { from: today, to: today };
    if (kind === "month") return { from: monthStart, to: today };
    let from = $<HTMLInputElement>("rep-from")?.value || monthStart;
    let to = $<HTMLInputElement>("rep-to")?.value || today;
    if (from > to) [from, to] = [to, from];
    return { from, to };
  }

  function updateRangeHint(): void {
    const { from, to } = currentRange();
    const el = $("rep-range-fa");
    if (el) el.textContent = `از ${toJalali(from)} تا ${toJalali(to)}`;
  }

  root.querySelectorAll<HTMLButtonElement>(".rep-range-btn").forEach((b) => {
    b.addEventListener("click", () => {
      kind = (b.dataset.range as RangeKind) || "month";
      root
        .querySelectorAll(".rep-range-btn")
        .forEach((x) => x.classList.toggle("on", x === b));
      const custom = $("rep-custom");
      if (custom) custom.style.display = kind === "custom" ? "" : "none";
      updateRangeHint();
      if (kind !== "custom") void loadSales();
    });
  });
  $("rep-from")?.addEventListener("change", updateRangeHint);
  $("rep-to")?.addEventListener("change", updateRangeHint);
  $("rep-load")?.addEventListener("click", () => void loadSales());

  // ----- گزارش فروش + نمودار + پرفروش‌ترین‌ها -----

  async function loadSales(): Promise<void> {
    const { from, to } = currentRange();
    updateRangeHint();
    const salesBody = $("rep-sales-body");
    const topBody = $("rep-top-body");
    if (salesBody) salesBody.innerHTML = `<p class="rep-loading">در حال بارگذاری…</p>`;
    if (topBody) topBody.innerHTML = `<p class="rep-loading">در حال بارگذاری…</p>`;
    try {
      const [sales, tops] = await Promise.all([
        api.reportSales(from, to),
        api.reportTopProducts(from, to),
      ]);
      drawSales(sales, from, to);
      drawTop(tops);
    } catch (e) {
      const msg = `<p class="rep-error">خطا در بارگذاری گزارش: ${errMsg(e)}</p>`;
      if (salesBody) salesBody.innerHTML = msg;
      if (topBody) topBody.innerHTML = msg;
    }
  }

  function drawSales(
    sales: { total_sales: number; invoice_count: number; daily: DailySale[] },
    from: string,
    to: string
  ): void {
    const body = $("rep-sales-body");
    if (!body) return;
    // صفرپر کردن روزهای بدون فروش تا نمودار پیوسته باشد
    const byDate = new Map(sales.daily.map((d) => [d.date, d]));
    const days: DailySale[] = [];
    const span = Math.min(diffDays(from, to), 366);
    for (let i = 0; i <= span; i++) {
      const date = addDaysIso(from, i);
      days.push(byDate.get(date) ?? { date, total: 0, count: 0 });
    }
    chartDays = days;
    body.innerHTML = `
      <div class="rep-stats">
        <div class="rep-stat"><span class="lbl">جمع فروش</span><span class="val">${fmtMoney(sales.total_sales)}</span></div>
        <div class="rep-stat"><span class="lbl">تعداد فاکتور</span><span class="val">${faNum(sales.invoice_count)}</span></div>
      </div>
      <canvas class="rep-chart" id="rep-chart"></canvas>
      <div class="rep-chart-cap" id="rep-chart-cap">فروش روزانه — نشانگر را روی ستون‌ها ببرید</div>
      <div style="text-align:center; margin-top:8px">
        <button class="btn ghost" id="rep-sales-csv">خروجی اکسل</button>
      </div>`;
    const canvas = $("rep-chart") as HTMLCanvasElement | null;
    if (canvas) {
      requestAnimationFrame(() => drawChart(canvas));
      canvas.addEventListener("mousemove", (ev) => onChartHover(canvas, ev));
      canvas.addEventListener("mouseleave", () => {
        const cap = $("rep-chart-cap");
        if (cap) cap.textContent = "فروش روزانه — نشانگر را روی ستون‌ها ببرید";
      });
    }
    $("rep-sales-csv")?.addEventListener("click", () => {
      downloadCsv(
        "sales-report.csv",
        ["تاریخ (میلادی)", "تاریخ (شمسی)", "مبلغ فروش (ریال)", "تعداد فاکتور"],
        days.map((d) => [d.date, toJalali(d.date), d.total, d.count])
      );
    });
  }

  function drawChart(canvas: HTMLCanvasElement): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = 190;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const padTop = 10;
    const padBottom = 24;
    const padSide = 8;
    const plotW = cssW - padSide * 2;
    const plotH = cssH - padTop - padBottom;
    const baseY = padTop + plotH;
    const max = Math.max(...chartDays.map((d) => d.total), 0);

    // خط پایه
    ctx.strokeStyle = "#e2d5c0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padSide, baseY + 0.5);
    ctx.lineTo(cssW - padSide, baseY + 0.5);
    ctx.stroke();

    const n = chartDays.length;
    if (n === 0) return;
    const step = plotW / n;
    chartGeom = { step, plotW, right: cssW - padSide };
    const barW = Math.max(3, Math.min(40, step * 0.62));

    ctx.textAlign = "center";
    ctx.font = "10px Tahoma, sans-serif";
    const labelEvery = n > 62 ? Math.ceil(n / 31) : 1;
    chartDays.forEach((d, i) => {
      // راست‌به‌چپ: روز اول در سمت راست
      const cx = cssW - padSide - (i + 0.5) * step;
      const h = max > 0 ? (d.total / max) * (plotH - 6) : 0;
      if (d.total > 0) {
        ctx.fillStyle = "#c98a2e";
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(cx - barW / 2, baseY - h, barW, h, [3, 3, 0, 0]);
          ctx.fill();
        } else {
          ctx.fillRect(cx - barW / 2, baseY - h, barW, h);
        }
      } else {
        ctx.fillStyle = "#e8dcc4";
        ctx.fillRect(cx - barW / 2, baseY - 2, barW, 2);
      }
      if (i % labelEvery === 0 || i === n - 1) {
        ctx.fillStyle = "#8a7a68";
        ctx.fillText(String(jalaliParts(d.date).jd), cx, baseY + 16);
      }
    });
  }

  function onChartHover(canvas: HTMLCanvasElement, ev: MouseEvent): void {
    if (!chartGeom || chartDays.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const fromRight = chartGeom.right - x;
    const idx = Math.floor(fromRight / chartGeom.step);
    const cap = $("rep-chart-cap");
    if (!cap) return;
    if (idx < 0 || idx >= chartDays.length) return;
    const d = chartDays[idx];
    cap.textContent = `${toJalali(d.date)} — فروش: ${fmtMoney(d.total)} (${faNum(d.count)} فاکتور)`;
  }

  function drawTop(tops: { name: string; qty: number; amount: number; profit: number }[]): void {
    topRows = tops;
    const body = $("rep-top-body");
    const csvBtn = $<HTMLButtonElement>("rep-top-csv");
    if (csvBtn) csvBtn.disabled = tops.length === 0;
    if (!body) return;
    if (tops.length === 0) {
      body.innerHTML = `<p class="rep-empty">در این بازه محصولی فروخته نشده است.</p>`;
      return;
    }
    const rows = tops
      .map(
        (t) => `<tr>
          <td>${esc(t.name)}</td>
          <td>${faNum(t.qty)}</td>
          <td>${fmtMoney(t.amount)}</td>
          <td>${fmtMoney(t.profit)}</td>
        </tr>`
      )
      .join("");
    body.innerHTML = `
      <table>
        <thead><tr><th>نام محصول</th><th>تعداد</th><th>مبلغ</th><th>سود</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  $("rep-top-csv")?.addEventListener("click", () => {
    downloadCsv(
      "top-products.csv",
      ["نام محصول", "تعداد", "مبلغ (ریال)", "سود (ریال)"],
      topRows.map((t) => [t.name, t.qty, t.amount, t.profit])
    );
  });

  // ----- گزارش بدهکاران -----

  async function loadDebtors(): Promise<void> {
    const body = $("rep-debt-body");
    if (!body) return;
    try {
      const ds = await api.reportDebtors();
      debtRows = ds
        .map((d) => ({ ...d, age: Math.max(0, diffDays(d.oldest_date, today)) }))
        .sort((a, b) => b.debt - a.debt);
      const csvBtn = $<HTMLButtonElement>("rep-debt-csv");
      if (csvBtn) csvBtn.disabled = debtRows.length === 0;
      if (debtRows.length === 0) {
        body.innerHTML = `<p class="rep-empty">هیچ مشتری‌ای بدهی ندارد. 🎉</p>`;
        return;
      }
      const buckets = [0, 1, 2].map((i) => {
        const inBucket = debtRows.filter(
          (d) => (d.age <= 30 ? 0 : d.age <= 60 ? 1 : 2) === i
        );
        return {
          label: ["۰ تا ۳۰ روز", "۳۱ تا ۶۰ روز", "بالای ۶۰ روز"][i],
          count: inBucket.length,
          sum: inBucket.reduce((s, d) => s + d.debt, 0),
        };
      });
      const totalDebt = debtRows.reduce((s, d) => s + d.debt, 0);
      const rows = debtRows
        .map((d) => {
          const b = ageBucket(d.age);
          return `<tr>
            <td>${esc(d.name)}</td>
            <td>${esc(d.phone)}</td>
            <td>${fmtMoney(d.debt)}</td>
            <td>${toJalali(d.oldest_date)}</td>
            <td>${faNum(d.age)} روز</td>
            <td><span class="rep-age ${b.cls}">${b.label}</span></td>
          </tr>`;
        })
        .join("");
      body.innerHTML = `
        <div class="rep-buckets">
          ${buckets
            .map(
              (b) => `<div class="rep-stat"><span class="lbl">بدهی ${b.label} — ${faNum(b.count)} مشتری</span><span class="val">${fmtMoney(b.sum)}</span></div>`
            )
            .join("")}
        </div>
        <p class="rep-hint" style="margin:0 0 10px">جمع کل بدهی‌ها: <b>${fmtMoney(totalDebt)}</b> از ${faNum(debtRows.length)} مشتری</p>
        <table>
          <thead><tr><th>مشتری</th><th>تلفن</th><th>جمع بدهی</th><th>قدیمی‌ترین بدهی</th><th>قدمت</th><th>دسته‌بندی</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (e) {
      body.innerHTML = `<p class="rep-error">خطا در بارگذاری گزارش بدهکاران: ${errMsg(e)}</p>`;
    }
  }

  $("rep-debt-csv")?.addEventListener("click", () => {
    downloadCsv(
      "debtors.csv",
      ["مشتری", "تلفن", "جمع بدهی (ریال)", "قدیمی‌ترین بدهی (میلادی)", "قدیمی‌ترین بدهی (شمسی)", "قدمت (روز)", "دسته‌بندی"],
      debtRows.map((d) => [
        d.name,
        d.phone,
        d.debt,
        d.oldest_date,
        toJalali(d.oldest_date),
        d.age,
        ageBucket(d.age).label,
      ])
    );
  });

  updateRangeHint();
  void loadSales();
  void loadDebtors();
}
