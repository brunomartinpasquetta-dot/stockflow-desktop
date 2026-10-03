// Lector de texto del sistema (Apple Vision, el mismo de "Texto en vivo").
// Uso: swift vision.swift foto.jpg  → imprime una línea por renglón (agrupando por altura) y el tiempo.
import Foundation
import Vision
import AppKit

let ruta = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: ruta), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("no pude abrir \(ruta)") }
let t0 = Date()
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["es-ES"]
req.usesLanguageCorrection = false
// Respetar la orientación EXIF
var orient = CGImagePropertyOrientation.up
if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: ruta) as CFURL, nil),
   let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
   let o = props[kCGImagePropertyOrientation] as? UInt32, let oo = CGImagePropertyOrientation(rawValue: o) { orient = oo }
let cgReal: CGImage = {
  if let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: ruta) as CFURL, nil), let c = CGImageSourceCreateImageAtIndex(src, 0, nil) { return c }
  return cg
}()
try VNImageRequestHandler(cgImage: cgReal, orientation: orient).perform([req])
var arr: [[String: Any]] = []
for o in req.results ?? [] {
  guard let c = o.topCandidates(1).first else { continue }
  arr.append(["t": c.string, "x0": o.bottomLeft.x, "y0": 1 - o.bottomLeft.y, "x1": o.bottomRight.x, "y1": 1 - o.bottomRight.y, "h": o.boundingBox.height, "c": c.confidence])
}
let ps = arr
print(String(data: try JSONSerialization.data(withJSONObject: ["ancho": cgReal.width, "alto": cgReal.height, "textos": arr]), encoding: .utf8)!)
FileHandle.standardError.write("tiempo: \(String(format: "%.1f", Date().timeIntervalSince(t0)))s · \(ps.count) textos\n".data(using: .utf8)!)
