'use client';

// Photo-based barcode decoding (iOS Safari has no native BarcodeDetector). The zxing wasm is
// self-hosted (/zxing_reader.wasm) and the library is loaded lazily on first use.
export async function decodeBarcodeFromFile(file: File): Promise<string | null> {
  const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill');
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? '/zxing_reader.wasm' : prefix + path) } });
  const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
  const bitmap = await createImageBitmap(file);
  const found = await detector.detect(bitmap);
  return found.find((b) => /^\d{8,14}$/.test(b.rawValue))?.rawValue ?? null;
}
