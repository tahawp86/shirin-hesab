#!/usr/bin/env python3
"""شیرین حساب — سازنده‌ی بسته‌ی آپدیت تفاضلی (فقط کتابخانه‌ی استاندارد پایتون).

ورودی: پوشه‌ی خروجی بیلد (exe مستقل برنامه + فایل‌هایی که کنار exe نصب
می‌شوند)، نسخه، و — اگر بود — مانیفست بیلد قبلی.
خروجی: ShirinHesab-Update-v<version>.zip با ساختار زیر:
    update_info.json   مشخصات بسته: نسخه، نسخه‌ی قبلی، فایل‌های داخل بسته
                       (مسیر، اندازه، sha256)، فایل‌های حذف‌شده، حجم کل
    manifest.json      مانیفست کامل همین بیلد (مبنای تفاضل بیلد بعدی)
    files/<relpath>    فقط فایل‌های تغییریافته/جدید نسبت به مانیفست قبلی

اگر مانیفست قبلی داده نشود (یا خوانا نباشد)، بسته «کامل» است و همه‌ی
فایل‌ها داخلش می‌آیند. manifest.json همیشه کنار خروجی هم نوشته می‌شود.
حالت --manifest-only فقط manifest.json را می‌سازد (برای CI بیلد).

مثال:
    python tools/make_update.py --build-dir update-staging --version 0.4.0 \
        --prev-manifest prev/manifest.json --out-dir update-dist
    python tools/make_update.py --build-dir update-staging --version 0.4.0 \
        --manifest-only --out-dir build-meta
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

# کنسول ویندوز (cp1252) نمی‌تواند متن فارسی چاپ کند و اسکریپت را در CI
# می‌ترکاند — خروجی‌ها را صریح UTF-8 می‌کنیم.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

APP_NAME = "ShirinHesab"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_build_dir(build_dir: Path) -> list[dict]:
    """همه‌ی فایل‌های پوشه‌ی بیلد: مسیر نسبی (POSIX)، اندازه و هش sha256."""
    files = []
    for p in build_dir.rglob("*"):
        if p.is_file():
            files.append(
                {
                    "path": p.relative_to(build_dir).as_posix(),
                    "size": p.stat().st_size,
                    "sha256": sha256_of(p),
                }
            )
    files.sort(key=lambda f: f["path"])
    return files


def load_manifest(path: Path) -> dict | None:
    """مانیفست قبلی را می‌خواند؛ اگر خراب/نامعتبر بود None برمی‌گرداند (بسته کامل)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("files"), list):
            raise ValueError("ساختار مانیفست نامعتبر است")
        return data
    except Exception as e:  # noqa: BLE001 — هر خطایی یعنی مانیفست قابل استفاده نیست
        print(
            f"هشدار: مانیفست قبلی خوانده نشد ({e})؛ بسته‌ی کامل ساخته می‌شود.",
            file=sys.stderr,
        )
        return None


def diff_manifests(
    current: list[dict], prev: dict | None
) -> tuple[list[dict], list[str]]:
    """فایل‌های تغییریافته/جدید و مسیرهای حذف‌شده نسبت به مانیفست قبلی."""
    if prev is None:
        return list(current), []
    prev_by_path = {f["path"]: f for f in prev["files"]}
    included = [
        f
        for f in current
        if f["path"] not in prev_by_path
        or prev_by_path[f["path"]].get("sha256") != f["sha256"]
    ]
    current_paths = {f["path"] for f in current}
    removed = sorted(p for p in prev_by_path if p not in current_paths)
    return included, removed


def dump_json(obj: object) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="سازنده‌ی بسته‌ی آپدیت تفاضلی شیرین حساب"
    )
    ap.add_argument("--build-dir", required=True, help="پوشه‌ی خروجی بیلد (exe + فایل‌های کنارش)")
    ap.add_argument("--version", required=True, help="نسخه‌ی این بیلد، مثل 0.3.0")
    ap.add_argument("--prev-manifest", default=None, help="مسیر manifest.json بیلد قبلی (اختیاری)")
    ap.add_argument("--out-dir", default=".", help="پوشه‌ی خروجی (پیش‌فرض: پوشه‌ی جاری)")
    ap.add_argument("--manifest-only", action="store_true", help="فقط manifest.json بساز، بدون بسته‌ی zip")
    ap.add_argument("--app", default=APP_NAME, help=f"نام برنامه (پیش‌فرض: {APP_NAME})")
    args = ap.parse_args()

    build_dir = Path(args.build_dir)
    if not build_dir.is_dir():
        print(f"خطا: پوشه‌ی بیلد پیدا نشد: {build_dir}", file=sys.stderr)
        return 1
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    current_files = scan_build_dir(build_dir)
    if not current_files:
        print(f"خطا: پوشه‌ی بیلد خالی است: {build_dir}", file=sys.stderr)
        return 1

    manifest = {"app": args.app, "version": args.version, "files": current_files}
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_bytes(dump_json(manifest))
    print(f"manifest.json: {len(current_files)} فایل (نسخه {args.version})")

    if args.manifest_only:
        return 0

    prev = load_manifest(Path(args.prev_manifest)) if args.prev_manifest else None
    included, removed = diff_manifests(current_files, prev)
    update_info = {
        "app": args.app,
        "version": args.version,
        "prev_version": prev.get("version") if prev else None,
        "files": included,
        "removed": removed,
        "total_size": sum(f["size"] for f in included),
    }

    zip_name = f"{args.app}-Update-v{args.version}.zip"
    zip_path = out_dir / zip_name
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("update_info.json", dump_json(update_info))
        zf.writestr("manifest.json", dump_json(manifest))
        for f in included:
            zf.write(build_dir / f["path"], arcname=f"files/{f['path']}")

    kind = "کامل" if prev is None else f"تفاضلی از نسخه‌ی {update_info['prev_version']}"
    print(
        f"{zip_name}: بسته‌ی {kind} — {len(included)} فایل داخل بسته، "
        f"{len(removed)} فایل حذف‌شده، حجم کل {update_info['total_size']} بایت"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
