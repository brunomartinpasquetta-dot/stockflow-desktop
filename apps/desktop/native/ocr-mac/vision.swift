// Lector de texto del sistema en Mac (Apple Vision, el mismo motor de "Texto en vivo").
//
// Lee en DOS pasadas (ver más abajo): primero la foto sin color (borra birome y
// resaltador: con eso se recuperaron renglones tachados que la lectura en color
// perdía) y después la foto tal cual, sólo para sumar lo que la primera no vio.
//
// Uso:  vision-ocr <ruta de la foto>
//       vision-ocr --probar     → imprime "disponible" y sale con 0 (la app comprueba así
//                                 que el binario corre en esta Mac antes de usarlo)
// Salida (stdout): UN JSON
//   { "ancho": px, "alto": px, "textos": [ { "t", "x0", "y0", "x1", "y1", "h", "c" } ] }
// Cada texto es una caja (un tramo de renglón). Coordenadas normalizadas 0..1 con la
// "y" hacia ABAJO, ya con la orientación EXIF aplicada:
//   (x0, y0) = extremo izquierdo de la base del texto     (x1, y1) = extremo derecho de la base
//   h = alto de la letra (perpendicular a la base), como fracción del ALTO de la foto
//   c = confianza 0..1
// El mismo formato lo emite native/ocr-win/leer.ps1 (Windows.Media.Ocr); lo consume
// electron/facturas/lectorSistema.ts. Si falla: mensaje por stderr y código de salida ≠ 0.
//
// Compilar: ./compilar.sh   (swiftc -O; no lleva dependencias fuera del sistema)
import Foundation
import Vision
import ImageIO
import CoreImage

func morir(_ mensaje: String, _ codigo: Int32) -> Never {
  FileHandle.standardError.write((mensaje + "\n").data(using: .utf8)!)
  exit(codigo)
}

guard CommandLine.arguments.count >= 2 else { morir("uso: vision-ocr <foto> | --probar", 2) }
let ruta = CommandLine.arguments[1]
if ruta == "--probar" {
  FileHandle.standardOutput.write("disponible\n".data(using: .utf8)!)
  exit(0)
}
guard let fuente = CGImageSourceCreateWithURL(URL(fileURLWithPath: ruta) as CFURL, nil),
      let imagen = CGImageSourceCreateImageAtIndex(fuente, 0, nil) else { morir("no se pudo abrir la foto: \(ruta)", 3) }

// Orientación EXIF: las fotos de teléfono vienen "acostadas" con la marca de giro.
var orientacion = CGImagePropertyOrientation.up
if let props = CGImageSourceCopyPropertiesAtIndex(fuente, 0, nil) as? [CFString: Any],
   let o = props[kCGImagePropertyOrientation] as? UInt32,
   let oo = CGImagePropertyOrientation(rawValue: o) { orientacion = oo }
let girada = [CGImagePropertyOrientation.left, .leftMirrored, .right, .rightMirrored].contains(orientacion)
let ancho = Double(girada ? imagen.height : imagen.width)
let alto = Double(girada ? imagen.width : imagen.height)

// Dos pasadas. La principal lee la foto "sin color": para cada punto se toma el canal
// más claro (CIMaximumComponent), lo que borra la tinta de birome y el resaltador que
// tapan los renglones (el texto impreso negro queda igual). La segunda lee la foto tal
// cual y aporta sólo las cajas que la primera no encontró (texto impreso en colores).
func leer(_ cg: CGImage) -> [VNRecognizedTextObservation] {
  let pedido = VNRecognizeTextRequest()
  pedido.recognitionLevel = .accurate
  pedido.recognitionLanguages = ["es-ES"]
  pedido.usesLanguageCorrection = false   // códigos y números: que no "corrija" nada
  do {
    try VNImageRequestHandler(cgImage: cg, orientation: orientacion).perform([pedido])
  } catch {
    morir("falló la lectura: \(error.localizedDescription)", 4)
  }
  return pedido.results ?? []
}

var sinColor: CGImage? = nil
if let filtro = CIFilter(name: "CIMaximumComponent") {
  filtro.setValue(CIImage(cgImage: imagen), forKey: kCIInputImageKey)
  if let salidaCI = filtro.outputImage {
    sinColor = CIContext(options: [.useSoftwareRenderer: false]).createCGImage(salidaCI, from: salidaCI.extent)
  }
}
let principal = leer(sinColor ?? imagen)
let secundaria = sinColor == nil ? [] : leer(imagen)

func rect(_ o: VNRecognizedTextObservation) -> CGRect { o.boundingBox }
func seSolapan(_ a: CGRect, _ b: CGRect) -> Bool {
  let i = a.intersection(b)
  if i.isNull || i.isEmpty { return false }
  let menor = min(a.width * a.height, b.width * b.height)
  return menor > 0 && (i.width * i.height) / menor > 0.10
}
var observaciones = principal
func mismaFila(_ a: CGRect, _ b: CGRect) -> Bool {
  // comparten franja vertical (más de la mitad del alto menor) y se tocan o solapan en horizontal
  let vy = min(a.maxY, b.maxY) - max(a.minY, b.minY)
  if vy <= 0 || vy / min(a.height, b.height) < 0.5 { return false }
  return !(a.maxX < b.minX - 0.005 || b.maxX < a.minX - 0.005)
}
for o in secundaria where !principal.contains(where: { seSolapan(rect($0), rect(o)) || mismaFila(rect($0), rect(o)) }) {
  observaciones.append(o)
}

var textos: [[String: Any]] = []
for o in observaciones {
  guard let c = o.topCandidates(1).first else { continue }
  // Alto de letra real (no el de la caja recta, que crece con la inclinación).
  let dx = Double(o.topLeft.x - o.bottomLeft.x) * ancho
  let dy = Double(o.topLeft.y - o.bottomLeft.y) * alto
  let h = (dx * dx + dy * dy).squareRoot() / alto
  textos.append([
    "t": c.string,
    "x0": Double(o.bottomLeft.x), "y0": 1 - Double(o.bottomLeft.y),
    "x1": Double(o.bottomRight.x), "y1": 1 - Double(o.bottomRight.y),
    "h": h, "c": Double(c.confidence),
  ])
}
let salida: [String: Any] = ["ancho": Int(ancho), "alto": Int(alto), "textos": textos]
guard let json = try? JSONSerialization.data(withJSONObject: salida) else { morir("no se pudo armar el JSON", 5) }
FileHandle.standardOutput.write(json)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
