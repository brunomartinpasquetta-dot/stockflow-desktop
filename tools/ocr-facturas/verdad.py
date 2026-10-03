# Planilla correcta de las 4 fotos de Vital (transcripta a mano y verificada con
# cantidad × UxB × precio = importe). Campos: codigo, cant, uxb, desc, precio, importe.

def L(codigo, cant, desc, precio, importe=None, uxb=None):
    return {"codigo": codigo, "cant": cant, "uxb": uxb, "desc": desc, "precio": precio, "importe": importe}

VERDAD = {
 "vital-12": [
  L("0100695", 13, "Atun S&P desmenuzado en aceite x170gr", 825.62, 10733.06),
  L("0152743", 3, "Atun S&P trozos aceite abre facil x170g", 2128.10, 6384.30),
  L("0100683", 3, "Caballa PUGLISI al agua x380g", 3921.49, 11764.47),
  L("0190207", 6, "Fideos CICA tirabuzon forti x500g", 619.01, 3714.06),
  L("0151288", 9, "Fideos FAVORITA spaghetti x500gr", 665.29, 5987.61),
  L("0101368", 3, "Galletitas CHOCOLINAS x250/262grs", 1900.00, 5700.00),
  L("0121102", 3, "Galletitas KESITAS x75gr", 1073.55, 3220.65),
  L("0121101", 6, "Galletitas REX bolsa x75gr", 1073.55, 6441.30),
  L("0112621", 3, "Galletitas SONRISAS frambuesa x108g", 990.91, 2972.73),
  L("0105805", 2, "Levadura LEVEX sobre 2x10g", 718.18, 1436.36),
  L("0191362", 1, "Magdalena BON MASE c/chips x175g", 1404.13, 1404.13),
  L("0179778", 1, "Mani frito S&P salado s/piel x250gr", 2276.24, 2276.24),
  L("0162080", 1, "Maq afeitar desc SOLEIL x2u", 3308.18, 3308.18),
  L("0147134", 3, "Pimenton ALICANTE x25gr", 751.24, 2253.72),
  L("0127944", 3, "Provenzal ALICANTE x25gr", 1057.02, 3171.06),
  L("0173522", 1, "Rapiditas BIMBO clasicas x275gr", 3197.52, 3197.52),
  L("0115997", 6, "Sal fina DOS ESTRELLAS x500gr", 453.72, 2722.32),
  L("0176159", 1, "Te LA VIRGINIA tilo/manza./cedron x25sq", 2171.70, 2171.70),
  L("0149542", 1, "Te LA VIRGINIA verde x20sq", 1462.68, 1462.68),
  L("0189883", 3, "Yerba LA MERCED campo sur liviana x1kg", 4607.44, 13822.32),
  L("0152821", 4, "Yerba ROSAMONTE PLUS SUAVE 55 ani.x500gr", 1238.84, 4955.36),
  L("00239848", 3, "ALICANTE ESPECIAS D3U15%", -112.69, -338.06),
  L("00239848", 3, "ALICANTE ESPECIAS D3U15%", -158.55, -475.66),
 ],
 "vital-13": [
  L("0189463", 1, "SET BAÑO cortina/alfombra/ganchos", 20247.93, 20247.93),
  L("0172161", 1, "Shampoo PLUSBELLE ESEN saludable x970ml", 3705.28, 3705.28),
  L("0130455", 3, "Shampoo TRESEMME liso efect botox x500ml", 5784.30, 17352.90),
  L("0176850", 1, "Sopa crema KNORR verduras nueva x60gr", 2276.24, 2276.24),
  L("0188730", 1, "TOALLA diseños surtidos 70x140cm", 4958.68, 4958.68),
  L("0188688", 1, "TOP DEPORTIVO SIN COSTURA Talle 3XL", 5785.12, 5785.12),
  L("0148287", 3, "Toa fem NOSOTRAS normal c/a x16u", 2819.21, 8457.63),
  L("0117803", 3, "Toa fem SIEMPRE LIBRE especial c/a x8u", 1528.10, 4584.30),
  L("0185480", 1, "Tostadas arroz MOLINOS ALA veggie x150gr", 2067.15, 2067.15),
  L("0123164", 2, "Trapo de piso MEDIA NARANJA blanco G", 3011.86, 6023.72),
  L("00239767", 3, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -114.46, -343.39),
  L("00239767", 1, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -443.39, -443.39),
  L("00239767", 2, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -301.19, -602.37),
  L("00239767", 5, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -122.73, -613.64),
  L("00239767", 24, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -27.19, -652.56),
  L("00239767", 6, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -112.31, -673.88),
  L("00239767", 20, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -34.30, -685.96),
  L("00239767", 3, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -261.07, -783.22),
  L("00239780", 1, "CERVEZAS Y CUIDADO DEL CABELLO 10%", -416.93, -416.93),
  L("00239799", 1, "CUIDADO DE LA ROPA 15%", -1090.78, -1090.78),
  L("00239799", 2, "CUIDADO DE LA ROPA 15%", -929.63, -1859.26),
  L("00239853", 1, "LA CAMPAGNOLA ESPECIAS D3U15%", -148.98, -148.98),
  L("00239853", 3, "LA CAMPAGNOLA ESPECIAS D3U15%", -165.50, -496.49),
  L("00239855", 3, "NOSOTRAS/CALIPSO 20%", -563.84, -1691.53),
 ],
 "vital-14": [
  L("0183509", 1, "Acond PLUSBELLE ESEN hidrat int x970ml", 4169.28, 4169.28),
  L("0188760", 3, "Antitr DOVE duraz/lech roll-on x50ml", 2147.93, 6443.79),
  L("0179051", 3, "Antitr DOVE original tam.ec x250ml", 5577.69, 16733.07),
  L("0183416", 3, "Arroz largo fino MOLINOS ALA g.sel. x1kg", 1114.88, 3344.64),
  L("0182402", 3, "Bolsa resid VIRUTEX 45x60 plana 10u", 1144.63, 3433.89),
  L("0175191", 1, "Caldo KNORR gallina deshidratado x12u", 2140.58, 2140.58),
  L("0175194", 1, "Caldo KNORR gallina deshidratado x6u", 1230.58, 12305.80, 10),
  L("0175166", 1, "Caldo KNORR verdura deshidratado x12u", 2140.58, 2140.58),
  L("0175151", 1, "Caldo KNORR verdura deshidratado x6u", 1230.58, 12305.80, 10),
  L("0122490", 3, "Capelettini GIACOMO tridicci x500gr", 3718.18, 11154.54),
  L("0161395", 1, "Cepillo dental COLGATE twister med. 3x2", 6148.22, 6148.22),
  L("0183684", 1, "Chimichurri LA CAMPAGNOLA x23gr", 993.19, 993.19),
  L("0187367", 3, "Crema dent SENSODYNE antisarro x90g", 5619.01, 16857.03),
  L("0155551", 3, "Detergente CIF Bioactive lima d/p x450ml", 2610.74, 7832.22),
  L("0103942", 1, "Espirales RAID x12u", 2162.73, 2162.73),
  L("0103822", 6, "Esponja MORTIMER de bronce doble cara", 1123.14, 6738.84),
  L("0103840", 3, "Esponja MORTIMER de fibra cuadriculada", 809.09, 2427.27),
  L("0101154", 2, "Fideos LUCCHETTI coditos x500gr", 1090.00, 2180.00),
  L("0185202", 1, "Fideos LUCCHETTI nido fettuccine x500gr", 1862.73, 1862.73),
  L("0151685", 1, "Jabon liq ALA matic ecolavado d/p x3lt", 7271.90, 7271.90),
  L("0183674", 1, "Jabon liq GRANBY matic limon d/p x3lt", 6197.52, 6197.52),
  L("0183676", 1, "Jabon liq GRANBY matic rosas d/p x3lt", 6197.52, 6197.52),
  L("0171656", 1, "Lampara led PHILIPS ecohome fria 10/12w", 1247.96, 1247.96),
  L("0128894", 6, "Mayonesa CADA DIA doy pack x250gr", 495.04, 2970.24),
  L("0128893", 1, "Mayonesa CADA DIA sachet x125g", 342.98, 6859.60, 20),
  L("0130348", 3, "Mayonesa MAYOLIVA sachet x125gr", 1090.00, 3270.00),
  L("0101741", 1, "Mayonesa NATURA d/p x1kg", 4433.88, 4433.88),
  L("0101737", 3, "Mayonesa NATURA doy pack x250gr", 1073.55, 3220.65),
  L("0175267", 1, "Mostaza DANICA seleccion granos x60g", 271.90, 6525.60, 24),
  L("0184156", 1, "Premezcla LUCCHETTI chipa x400grs", 5121.78, 5121.78),
  L("0173580", 3, "Provenzal LA CAMPAGNOLA x23g", 1103.31, 3309.93),
  L("0132736", 5, "Rejilla MEDIA NARANJA reforzada", 1227.27, 6136.35),
  L("0103878", 3, "Repelente OFF family aerosol x165ml", 4255.37, 12766.11),
 ],
 # Códigos cortados a la izquierda en la foto: se comparan los últimos 6 dígitos.
 "vital-15": [
  L("106988", 3, "Aceite girasol COCINERO x900cc", 2767.77, 8303.31),
  L("183417", 1, "Arroz largo fino MOLINOS ALA g.selx500gr", 566.12, 5661.20, 10),
  L("102847", 3, "Jugo de limon MINERVA pet x250ml", 1371.07, 4113.21),
  L("179398", 3, "Lavandina AYUDIN original x4lt", 3883.47, 11650.41),
  L("176278", 1, "Limpiador POETT suavidad de bebex4lt", 6338.02, 19014.06, 3),
  L("101966", 1, "Pure de tomate NOEL tetrabrik x520gr", 561.16, 6733.92, 12),
  L("124328", 3, "Salsa chimi. TAHITI t/casero pet x275gr", 1486.78, 4460.34),
  L("153115", 3, "Vinagre de alcohol S&P x500cc", 742.98, 2228.94),
  L("239767", 3, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -276.78, -830.33),
  L("239767", 3, "ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%", -633.80, -1901.41),
 ],
}

if __name__ == "__main__":
    malos = 0
    for f, lineas in VERDAD.items():
        for i, l in enumerate(lineas, 1):
            esperado = round(l["cant"] * (l["uxb"] or 1) * l["precio"], 2)
            if abs(esperado - l["importe"]) > 0.05:
                malos += 1
                print(f"{f} renglón {i}: {esperado} ≠ {l['importe']}")
    print(sum(len(v) for v in VERDAD.values()), "renglones;", malos, "no cierran")
