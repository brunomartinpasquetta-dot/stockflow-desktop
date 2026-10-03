#!/bin/sh
# Compila el lector de texto del sistema para Mac (Apple Vision) → native/ocr-mac/vision-ocr
# Binario universal (Apple Silicon + Intel) si el compilador puede; si no, sólo el de esta Mac.
# Requiere las herramientas de línea de comandos de Xcode (xcode-select --install).
set -e
cd "$(dirname "$0")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if swiftc -O -target arm64-apple-macos11 vision.swift -o "$TMP/arm64" 2>/dev/null \
  && swiftc -O -target x86_64-apple-macos11 vision.swift -o "$TMP/x86_64" 2>/dev/null; then
  lipo -create "$TMP/arm64" "$TMP/x86_64" -output vision-ocr
  echo "vision-ocr: binario universal (arm64 + x86_64)"
else
  swiftc -O vision.swift -o vision-ocr
  echo "vision-ocr: binario sólo para esta Mac ($(uname -m))"
fi
chmod +x vision-ocr
