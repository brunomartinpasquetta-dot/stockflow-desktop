; Pasos extra del instalador de Windows (electron-builder los incluye vía
; `nsis.include`).
;
; ÍCONO VIEJO EN EL ESCRITORIO TRAS ACTUALIZAR (Denver, 29-sep-2026): Windows
; guarda en su caché la imagen del acceso directo asociada a la RUTA del
; programa, y la ruta no cambia entre versiones. Recrear el acceso directo
; (createDesktopShortcut: always) no alcanza: hay que avisarle a Windows que
; los íconos cambiaron para que vuelva a leerlos. Es lo mismo que hacen los
; instaladores NSIS habituales al terminar.
;
; SHChangeNotify(SHCNE_ASSOCCHANGED = 0x08000000, SHCNF_IDLIST = 0, 0, 0)
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
