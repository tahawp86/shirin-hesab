ShirinHesabUpdater — sidecar helper for the update engine.
CI builds the helper crate and places the binary here as
ShirinHesabUpdater-x86_64-pc-windows-msvc.exe before `tauri build`.
Tauri strips the target-triple suffix and installs it as
ShirinHesabUpdater.exe next to the main executable.
