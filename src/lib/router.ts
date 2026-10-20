// روتر ساده‌ی شیرین حساب — صفحات خودشان را اینجا ثبت می‌کنند
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PageRenderer = (root: HTMLElement, arg?: any) => void;

const routes: Record<string, PageRenderer> = {};

export function registerRoute(name: string, render: PageRenderer) {
  routes[name] = render;
}

export function navigate(page: string, arg?: unknown) {
  const root = document.getElementById("app");
  if (!root) return;
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.classList.toggle("active", (b as HTMLElement).dataset.page === page)
  );
  const render = routes[page] || routes["customers"];
  if (render) render(root, arg);
  else root.innerHTML = "<p>صفحه پیدا نشد.</p>";
}
