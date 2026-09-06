#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIRMWARE_DIR="$PROJECT_DIR/firmware"
BUILD_DIR="$FIRMWARE_DIR/.pio/build/esp32cam"
RELEASE_DIR="$PROJECT_DIR/releases/firmware"
PIO_BIN="${PIO_BIN:-pio}"
PIO_CORE="${PLATFORMIO_CORE_DIR:-$HOME/.platformio}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
BOOT_APP0="$PIO_CORE/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"

cd "$PROJECT_DIR"
npm run build:web
mkdir -p "$RELEASE_DIR"
cd "$FIRMWARE_DIR"
"$PIO_BIN" run
"$PIO_BIN" run --target buildfs

cp "$BUILD_DIR/firmware.bin" "$RELEASE_DIR/firmware.bin"
cp "$BUILD_DIR/partitions.bin" "$RELEASE_DIR/partitions.bin"
cp "$BUILD_DIR/littlefs.bin" "$RELEASE_DIR/littlefs.bin"
cp "$BUILD_DIR/bootloader.bin" "$RELEASE_DIR/bootloader.bin"
cp "$BOOT_APP0" "$RELEASE_DIR/boot_app0.bin"

ESPTOOL="$PIO_CORE/packages/tool-esptoolpy/esptool.py"
"$PYTHON_BIN" "$ESPTOOL" --chip esp32 merge_bin -o "$RELEASE_DIR/SubmarineRC-v1.0.0-merged.bin" \
  0x1000 "$BUILD_DIR/bootloader.bin" \
  0x8000 "$BUILD_DIR/partitions.bin" \
  0xe000 "$BOOT_APP0" \
  0x10000 "$BUILD_DIR/firmware.bin" \
  0x210000 "$BUILD_DIR/littlefs.bin"

echo "Firmware release created in $RELEASE_DIR"
