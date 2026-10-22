#!/usr/bin/env python3
"""شیرین حساب — سازنده‌ی بسته‌های آپدیت و فید انتشار (فقط کتابخانه‌ی استاندارد).

مدل جدید انتشار موتور آپدیت: از روی خروجی بیلد + CHANGELOG_FA.md + مانیفست
بیلد قبلی، سه خروجی می‌سازد:
    ShirinHesab-Update-v<version>.zip
        بسته‌ی «کامل»: همه‌ی فایل‌ها + update_info.json و manifest.json در ریشه.
        نام و قالبش دقیقاً همان مدل قبلی است تا نصب‌های فعلی (موتور قدیمی که
        لیست ریلیزها را اسکن می‌کند) هم بتوانند با همین فایل آپدیت شوند.
    ShirinHesab-Update-v<version>-from-<prev>.zip
        بسته‌ی «دلتا» از نسخه‌ی قبلی: همه‌ی فایل‌های بیلد جاری +
        فهرست removed در update_info.json (+ manifest.json کامل بیلد جاری).
        (محتوای کامل است، نه فقط فایل‌های تغییریافته: اعتبارسنج دانلودِ
        برنامه همه‌ی فایل‌های فید را داخل بسته می‌خواهد؛ فهرست removed
        همچنان از روی اختلاف با مانیفست قبلی حساب می‌شود.)
    update-feed.json
        فید ثابت موتور جدید: نسخه، تاریخ انتشار، متن تغییرات فارسی (از مدخل
        همین نسخه در CHANGELOG_FA.md)، آدرس مطلق و هش هر دو بسته و فهرست
        کامل فایل‌های این نسخه.

اگر مانیفست قبلی داده نشود، بسته‌ی دلتا ساخته نمی‌شود و packages.delta در
فید null می‌ماند. min_version به‌صورت پیش‌فرض همان نسخه‌ی قبلی است.

مثال:
    python tools/make_feed.py --build-dir stage --version 0.6.0 \
        --changelog CHANGELOG_FA.md --repo tahawp86/shirin-hesab \
        --prev-manifest prev/manifest.json --out-dir update-dist
"""
from __future__ import annotations

import sys

# خروجی کنسول همیشه UTF-8 (روی ویندوز کنسول پیش‌فرض متن فارسی را خراب/کرش می‌کند)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

APP_NAME = "ShirinHesab"
CHANNEL = "stable"


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
    """مانیفست قبلی را می‌خواند؛ اگر خراب/نامعتبر بود None برمی‌گرداند."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("files"), list):
            raise ValueError("ساختار مانیفست نامعتبر است")
        return data
    except Exception as e:  # noqa: BLE001 — هر خطایی یعنی مانیفست قابل استفاده نیست
        print(f"هشدار: مانیفست قبلی خوانده نشد ({e})؛ بسته‌ی دلتا ساخته نمی‌شود.")
        return None


def diff_manifests(
    current: list[dict], prev: dict
) -> tuple[list[dict], list[str]]:
    """فایل‌های تغییریافته/جدید و مسیرهای حذف‌شده نسبت به مانیفست قبلی."""
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


def extract_notes(changelog_text: str, version: str) -> str:
    """متن مدخل یک نسخه از CHANGELOG_FA.md (بولت‌های زیر هدر ## نسخه) را برمی‌گرداند."""
    lines = changelog_text.splitlines()
    header_re = re.compile(r"^##\s+" + re.escape(version) + r"(\s|\(|$)")
    start = None
    for i, line in enumerate(lines):
        if header_re.match(line.strip()):
            start = i + 1
            break
    if start is None:
        return ""
    body: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        body.append(line)
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    return "\n".join(body)


def write_package(
    zip_path: Path,
    build_dir: Path,
    included: list[dict],
    update_info: dict,
    manifest: dict,
) -> None:
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("update_info.json", dump_json(update_info))
        zf.writestr("manifest.json", dump_json(manifest))
        for f in included:
            zf.write(build_dir / f["path"], arcname=f"files/{f['path']}")


def make_update_info(
    app: str, version: str, prev_version: str | None,
    files: list[dict], removed: list[str],
) -> dict:
    return {
        "app": app,
        "version": version,
        "prev_version": prev_version,
        "files": files,
        "removed": removed,
        "total_size": sum(f["size"] for f in files),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="سازنده‌ی بسته‌های آپدیت و فید انتشار شیرین حساب")
    ap.add_argument("--build-dir", required=True, help="پوشه‌ی خروجی بیلد (exe + فایل‌های کنارش)")
    ap.add_argument("--version", required=True, help="نسخه‌ی این بیلد، مثل 0.6.0")
    ap.add_argument("--prev-manifest", default=None, help="مسیر manifest.json بیلد قبلی (اختیاری؛ برای بسته‌ی دلتا)")
    ap.add_argument("--prev-version", default=None, help="نسخه‌ی قبلی (پیش‌فرض: از روی مانیفست قبلی)")
    ap.add_argument("--changelog", default="CHANGELOG_FA.md", help="مسیر CHANGELOG_FA.md (پیش‌فرض: CHANGELOG_FA.md)")
    ap.add_argument("--repo", default="tahawp86/shirin-hesab", help="مخزن گیت‌هاب برای ساخت آدرس‌های مطلق فید")
    ap.add_argument("--min-version", default=None, help="کمترین نسخه‌ای که این آپدیت را می‌گیرد (پیش‌فرض: نسخه‌ی قبلی)")
    ap.add_argument("--published-at", default=None, help="زمان انتشار ISO 8601 (پیش‌فرض: همین حالا، UTC)")
    ap.add_argument("--out-dir", default=".", help="پوشه‌ی خروجی (پیش‌فرض: پوشه‌ی جاری)")
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
    (out_dir / "manifest.json").write_bytes(dump_json(manifest))
    print(f"manifest.json: {len(current_files)} فایل (نسخه {args.version})")

    prev = load_manifest(Path(args.prev_manifest)) if args.prev_manifest else None
    prev_version = args.prev_version or (prev.get("version") if prev else None)

    base_url = f"https://github.com/{args.repo}/releases/download/v{args.version}"

    # بسته‌ی کامل — نام و قالب دقیقاً همان مدل قبلی (پل سازگاری با موتور قدیمی)
    full_name = f"{args.app}-Update-v{args.version}.zip"
    full_path = out_dir / full_name
    write_package(
        full_path,
        build_dir,
        current_files,
        make_update_info(args.app, args.version, None, current_files, []),
        manifest,
    )
    print(f"{full_name}: بسته‌ی کامل — {len(current_files)} فایل، {full_path.stat().st_size} بایت")

    # بسته‌ی دلتا از نسخه‌ی قبلی (اگر مانیفست قبلی هست)
    delta_pkg = None
    if prev is not None and prev_version:
        # فقط فهرست removed از روی اختلاف حساب می‌شود؛ محتوای بسته کامل است
        # (اعتبارسنج دانلودِ برنامه همه‌ی فایل‌های فید را داخل بسته می‌خواهد).
        _changed, removed = diff_manifests(current_files, prev)
        delta_name = f"{args.app}-Update-v{args.version}-from-{prev_version}.zip"
        delta_path = out_dir / delta_name
        write_package(
            delta_path,
            build_dir,
            current_files,
            make_update_info(args.app, args.version, prev_version, current_files, removed),
            manifest,
        )
        delta_pkg = {
            "from": prev_version,
            "url": f"{base_url}/{delta_name}",
            "size": delta_path.stat().st_size,
            "sha256": sha256_of(delta_path),
        }
        print(
            f"{delta_name}: بسته‌ی دلتا از {prev_version} — "
            f"{len(current_files)} فایل (کامل)، {len(removed)} حذف‌شده، {delta_pkg['size']} بایت"
        )
    else:
        print("مانیفست قبلی نیست؛ بسته‌ی دلتا ساخته نشد.")

    # متن تغییرات همین نسخه از CHANGELOG_FA.md
    notes_fa = ""
    changelog_path = Path(args.changelog)
    if changelog_path.is_file():
        notes_fa = extract_notes(
            changelog_path.read_text(encoding="utf-8"), args.version
        )
    if not notes_fa:
        print(
            f"هشدار: مدخل نسخه‌ی {args.version} در {changelog_path} پیدا نشد؛ notes_fa خالی می‌ماند."
        )

    published_at = args.published_at or datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    feed = {
        "app": args.app,
        "channel": CHANNEL,
        "version": args.version,
        "published_at": published_at,
        "notes_fa": notes_fa,
        "mandatory": False,
        "min_version": args.min_version or prev_version or args.version,
        "packages": {
            "full": {
                "url": f"{base_url}/{full_name}",
                "size": full_path.stat().st_size,
                "sha256": sha256_of(full_path),
            },
            "delta": delta_pkg,
        },
        "files": current_files,
    }
    (out_dir / "update-feed.json").write_bytes(dump_json(feed))
    print(f"update-feed.json: فید نسخه‌ی {args.version} ساخته شد (min_version={feed['min_version']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
