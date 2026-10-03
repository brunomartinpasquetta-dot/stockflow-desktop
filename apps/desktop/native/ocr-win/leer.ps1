# Lector de texto del sistema en Windows (Windows.Media.Ocr, viene con Windows 10/11).
#
# ATENCION: SIN PROBAR EN WINDOWS. Se escribió en la Mac de desarrollo siguiendo la
# documentación de WinRT; hay que ejecutarlo y medirlo en una PC con Windows antes
# de habilitarlo para clientes (ver tools/ocr-facturas/RESULTADOS.md).
#
# Uso (Windows PowerShell 5.1, NO PowerShell 7: el 7 no carga los tipos WinRT):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File leer.ps1 -Ruta C:\ruta\hoja.jpg
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File leer.ps1 -Probar
#
# Salida (stdout): UN JSON, el MISMO formato que native/ocr-mac/vision.swift
#   { "ancho": px, "alto": px, "textos": [ { "t", "x0", "y0", "x1", "y1", "h", "c" } ] }
# Coordenadas normalizadas 0..1, "y" hacia abajo, con la orientacion EXIF aplicada:
#   (x0, y0) = extremo izquierdo de la base del texto   (x1, y1) = extremo derecho de la base
#   h = alto de la letra como fraccion del ALTO de la foto
#   c = confianza: Windows no la informa, va siempre 1
# Con -Probar imprime "disponible" o "no disponible" (hay o no un idioma de lectura instalado).
# Si falla: mensaje por stderr y codigo de salida distinto de 0.
#
# Antes de leer, la foto se pasa a gris "canal mas claro" (max(R,G,B) de cada punto),
# ya girada segun EXIF: eso borra la birome y el resaltador que tapan renglones (el
# texto impreso negro queda igual). En Mac la misma idea recupero renglones tachados
# que la lectura en color perdia. Si el preproceso falla, se lee la foto original.
# Con -SinPreproceso se lee la foto tal cual (para comparar; la app no lo usa).
#
# Windows entrega PALABRAS con su rectangulo, agrupadas en lineas que cruzan toda
# la hoja. Para que las cajas se parezcan a las de Mac (un tramo por columna), cada
# linea se corta donde el hueco entre dos palabras supera 1,2 veces el alto de letra.
param(
  [string]$Ruta = '',
  [switch]$Probar,
  [switch]$SinPreproceso
)

$ErrorActionPreference = 'Stop'

function Morir([string]$mensaje, [int]$codigo) {
  [Console]::Error.WriteLine($mensaje)
  exit $codigo
}

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  # Las operaciones WinRT son asincronicas: se esperan con AsTask(IAsyncOperation<T>).
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Esperar($operacion, [Type]$tipo) {
    $tarea = $asTask.MakeGenericMethod($tipo).Invoke($null, @($operacion))
    $null = $tarea.Wait(-1)
    return $tarea.Result
  }

  # Motor: castellano si esta instalado; si no, el idioma del usuario.
  $motor = $null
  foreach ($etiqueta in @('es-AR', 'es-ES', 'es-MX', 'es')) {
    $idioma = New-Object Windows.Globalization.Language($etiqueta)
    if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($idioma)) {
      $motor = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($idioma)
      if ($motor) { break }
    }
  }
  if (-not $motor) { $motor = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }

  if ($Probar) {
    if ($motor) { [Console]::Out.WriteLine('disponible') } else { [Console]::Out.WriteLine('no disponible') }
    exit 0
  }
  if (-not $motor) { Morir 'Windows no tiene instalado ningun idioma para leer texto (Configuracion > Hora e idioma > Idioma).' 6 }
  if (-not $Ruta) { Morir 'uso: leer.ps1 -Ruta <foto>' 2 }
  $rutaCompleta = (Resolve-Path -LiteralPath $Ruta).Path

  # Preproceso en C# (Add-Type compila en el momento; un bucle en PowerShell puro tardaria minutos).
  $rutaLeer = $rutaCompleta
  $temporal = $null
  if (-not $SinPreproceso) {
    try {
      Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class PreprocesoFactura {
  public static void SinColor(string origen, string destino) {
    using (var foto = new Bitmap(origen)) {
      try {
        if (Array.IndexOf(foto.PropertyIdList, 0x0112) >= 0) {
          int o = foto.GetPropertyItem(0x0112).Value[0];
          switch (o) {
            case 2: foto.RotateFlip(RotateFlipType.RotateNoneFlipX); break;
            case 3: foto.RotateFlip(RotateFlipType.Rotate180FlipNone); break;
            case 4: foto.RotateFlip(RotateFlipType.RotateNoneFlipY); break;
            case 5: foto.RotateFlip(RotateFlipType.Rotate90FlipX); break;
            case 6: foto.RotateFlip(RotateFlipType.Rotate90FlipNone); break;
            case 7: foto.RotateFlip(RotateFlipType.Rotate270FlipX); break;
            case 8: foto.RotateFlip(RotateFlipType.Rotate270FlipNone); break;
          }
        }
      } catch { }
      var rect = new Rectangle(0, 0, foto.Width, foto.Height);
      using (var gris = new Bitmap(foto.Width, foto.Height, PixelFormat.Format24bppRgb)) {
        var src = foto.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        var dst = gris.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
        int n = Math.Abs(src.Stride) * foto.Height;
        var buf = new byte[n];
        Marshal.Copy(src.Scan0, buf, 0, n);
        for (int y = 0; y < foto.Height; y++) {
          int fila = y * Math.Abs(src.Stride);
          for (int x = 0; x < foto.Width; x++) {
            int i = fila + x * 3;
            byte m = Math.Max(buf[i], Math.Max(buf[i + 1], buf[i + 2]));
            buf[i] = m; buf[i + 1] = m; buf[i + 2] = m;
          }
        }
        Marshal.Copy(buf, 0, dst.Scan0, n);
        foto.UnlockBits(src);
        gris.UnlockBits(dst);
        gris.Save(destino, ImageFormat.Png);
      }
    }
  }
}
"@
      $temporal = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'stockflow-ocr-' + [guid]::NewGuid().ToString('N') + '.png')
      [PreprocesoFactura]::SinColor($rutaCompleta, $temporal)
      $rutaLeer = $temporal
    } catch {
      # Aviso por stderr (la app solo mira stderr si la lectura falla): se sigue con la foto tal cual.
      [Console]::Error.WriteLine('preproceso sin color no disponible: ' + $_.Exception.Message)
      $rutaLeer = $rutaCompleta   # sin preproceso: se lee la foto tal cual
      $temporal = $null
    }
  }

  $archivo = Esperar ([Windows.Storage.StorageFile]::GetFileFromPathAsync($rutaLeer)) ([Windows.Storage.StorageFile])
  $flujo = Esperar ($archivo.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decodificador = Esperar ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($flujo)) ([Windows.Graphics.Imaging.BitmapDecoder])

  # Tamano ya girado segun EXIF. El motor tiene un maximo por lado: si la foto lo supera, se reduce.
  $ancho = [double]$decodificador.OrientedPixelWidth
  $alto = [double]$decodificador.OrientedPixelHeight
  $maximo = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $escala = 1.0
  if ($ancho -gt $maximo -or $alto -gt $maximo) { $escala = $maximo / [Math]::Max($ancho, $alto) }
  $transformacion = New-Object Windows.Graphics.Imaging.BitmapTransform
  if ($escala -lt 1.0) {
    # ScaledWidth/Height van en el tamano SIN girar.
    $transformacion.ScaledWidth = [uint32][Math]::Floor($decodificador.PixelWidth * $escala)
    $transformacion.ScaledHeight = [uint32][Math]::Floor($decodificador.PixelHeight * $escala)
    $ancho = [Math]::Floor($ancho * $escala)
    $alto = [Math]::Floor($alto * $escala)
  }
  $mapa = Esperar ($decodificador.GetSoftwareBitmapAsync(
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
      $transformacion,
      [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
      [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  # El tamano real del mapa manda (por si el giro o la reduccion redondearon distinto).
  $ancho = [double]$mapa.PixelWidth
  $alto = [double]$mapa.PixelHeight

  $resultado = Esperar ($motor.RecognizeAsync($mapa)) ([Windows.Media.Ocr.OcrResult])

  $textos = New-Object System.Collections.ArrayList
  function Agregar-Caja($palabras) {
    if ($palabras.Count -eq 0) { return }
    $primera = $palabras[0].BoundingRect
    $ultima = $palabras[$palabras.Count - 1].BoundingRect
    $altos = @($palabras | ForEach-Object { [double]$_.BoundingRect.Height } | Sort-Object)
    $altoLetra = $altos[[int][Math]::Floor($altos.Count / 2)]
    $texto = (@($palabras | ForEach-Object { $_.Text }) -join ' ')
    $null = $textos.Add([ordered]@{
        t  = $texto
        x0 = [Math]::Round(([double]$primera.X) / $ancho, 5)
        y0 = [Math]::Round(([double]$primera.Y + [double]$primera.Height) / $alto, 5)
        x1 = [Math]::Round(([double]$ultima.X + [double]$ultima.Width) / $ancho, 5)
        y1 = [Math]::Round(([double]$ultima.Y + [double]$ultima.Height) / $alto, 5)
        h  = [Math]::Round($altoLetra / $alto, 5)
        c  = 1
      })
  }

  foreach ($linea in $resultado.Lines) {
    $palabras = @($linea.Words | Sort-Object { [double]$_.BoundingRect.X })
    if ($palabras.Count -eq 0) { continue }
    $altos = @($palabras | ForEach-Object { [double]$_.BoundingRect.Height } | Sort-Object)
    $altoLinea = $altos[[int][Math]::Floor($altos.Count / 2)]
    $tramo = New-Object System.Collections.ArrayList
    $finAnterior = $null
    foreach ($palabra in $palabras) {
      $r = $palabra.BoundingRect
      if ($null -ne $finAnterior -and ([double]$r.X - $finAnterior) -gt ($altoLinea * 1.2)) {
        Agregar-Caja $tramo
        $tramo = New-Object System.Collections.ArrayList
      }
      $null = $tramo.Add($palabra)
      $finAnterior = [double]$r.X + [double]$r.Width
    }
    Agregar-Caja $tramo
  }

  $salida = [ordered]@{ ancho = [int]$ancho; alto = [int]$alto; textos = @($textos.ToArray()) }
  # -Compress: una sola linea. ConvertTo-Json escribe los decimales con punto en cualquier region.
  [Console]::Out.WriteLine(($salida | ConvertTo-Json -Depth 4 -Compress))
  if ($temporal -and (Test-Path -LiteralPath $temporal)) { Remove-Item -LiteralPath $temporal -Force -ErrorAction SilentlyContinue }
  exit 0
}
catch {
  if ($temporal -and (Test-Path -LiteralPath $temporal)) { Remove-Item -LiteralPath $temporal -Force -ErrorAction SilentlyContinue }
  Morir ("fallo la lectura: " + $_.Exception.Message) 4
}
