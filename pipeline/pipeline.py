"""
Pipeline de limpieza y estandarización (basado en Initial_EDA.ipynb, partes A y B).

Recibe el Excel subido desde el front, aplica la limpieza del EDA y guarda la versión
limpia (df_ab) como JSON. Cada carga nueva reemplaza a la anterior.

Uso:
    python pipeline/pipeline.py <archivo.xlsx|.xls|.csv> [--out-dir DIR]

Salida (en --out-dir, por defecto ./data):
    current.json       filas limpias (lista de registros) → backend y dashboards
    current_meta.json  resumen de la carga (archivo, fecha, filas, flags, avisos)

Por stdout imprime un JSON {ok, filas, columnas, avisos} para que Node lo devuelva al front.
Si falla, imprime {ok: false, error} y sale con código 1; la versión anterior no se toca.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone

import janitor  # noqa: F401  (registra DataFrame.clean_names)
import numpy as np
import pandas as pd

# ── Constantes ─────────────────────────────────────────────────────────────────

HEADER_EXCEL = 2                      # los títulos vienen en la 3.ª fila del Excel
ETIQUETA_SIN_DATO = "No disponible"
ETIQUETA_SIN_USUARIO = "No asignado"
FECHA_CORTE_B = None                  # fecha de extracción; None → fin del mes más reciente

# columnas esperadas (ya en snake_case)
COLS_A = ["equipo_id", "sistema_operativo", "version_so", "estado_tpm", "encryption_readiness",
          "estado_de_cifrado", "tecnologia_de_cifrado_state", "estado_de_cumplimiento",
          "fuente_de_datos", "en_mdm", "en_ad", "en_mac_os"]
COLS_B = ["usuario_id", "pais", "region", "categoria_de_equipo", "clase_de_equipo",
          "perfil_de_privilegio", "antiguedad_meses", "banda_antiguedad", "estado_de_cuenta",
          "mes_ultimo_logon", "banda_recencia", "estado_hardware", "tipo_de_red"]

BOOL_COLS = ["en_mdm", "en_ad", "en_mac_os"]
MAPA_SI_NO = {"si": True, "no": False}

CAT_B = ["pais", "region", "categoria_de_equipo", "clase_de_equipo",
         "perfil_de_privilegio", "estado_de_cuenta", "estado_hardware", "tipo_de_red"]

PATRON_SIN_DATO = r"^\s*(no disponible|desconocido|sin dato|sin informacion|n/?a|na|null|none|unknown|-)\s*$"


# ── Funciones auxiliares (EDA) ─────────────────────────────────────────────────

def sin_acentos(texto):
    """Versión → Version, Tecnología → Tecnologia"""
    return "".join(ch for ch in unicodedata.normalize("NFKD", str(texto))
                   if not unicodedata.combining(ch))


def limpiar_nombres(df):
    """snake_case, sin acentos ni caracteres especiales, separa CamelCase (EquipoID → equipo_id)"""
    out = df.rename(columns=sin_acentos)   # quitar acentos ANTES de janitor
    out = out.clean_names(
        case_type="snake",
        remove_special=True,
        strip_underscores=True,
    )
    return out


def es_sin_dato(s):
    """True si el valor es texto tipo 'No disponible', 'N/A', etc."""
    return s.astype("string").map(lambda x: sin_acentos(x).lower() if pd.notna(x) else x) \
            .str.match(PATRON_SIN_DATO, na=False)


def limpiar_espacios(s):
    return s.astype("string").str.strip().str.replace(r"\s+", " ", regex=True)


def clave_txt(s):
    """sin espacios extra, sin mayúsculas, sin acentos"""
    return limpiar_espacios(s).map(lambda x: sin_acentos(x).lower() if pd.notna(x) else x)


def familia_so(v):
    v = str(v)
    if v == ETIQUETA_SIN_DATO or v.lower() in ("nan", "<na>", "unknown", ""):
        return ETIQUETA_SIN_DATO
    if v.startswith("10.0.19") or v == "Windows 10":
        return "Windows 10"
    if v.startswith(("10.0.22", "10.0.26")) or v == "Windows 11":
        return "Windows 11"
    if v.startswith("Windows"):
        return "Windows (sin versión)"
    if v.startswith(("macOS", "26.")):
        return "macOS"
    return "Sin clasificar"          # versión nueva no contemplada → revisar


def conflictos_jerarquia(df, padre, hijo):
    """valores de `padre` que aparecen con más de un `hijo` (sin contar 'No disponible')"""
    con_dato = df[(df[padre] != ETIQUETA_SIN_DATO) & (df[hijo] != ETIQUETA_SIN_DATO)]
    t = pd.crosstab(con_dato[padre], con_dato[hijo])
    return t[(t > 0).sum(axis=1) > 1]


def rango_banda(banda):
    """'0-12 meses' → (0, 12) · '37+ meses' → (37, inf) · '1-2 años' → (12, 24) · no entendible → (nan, nan)"""
    b = sin_acentos(str(banda)).lower()
    if banda is pd.NA or b in ("nan", "<na>", sin_acentos(ETIQUETA_SIN_DATO).lower()):
        return (np.nan, np.nan)
    factor = 12 if "ano" in b else 1
    if m := re.search(r"(\d+)\s*-\s*(\d+)", b):
        return (int(m[1]) * factor, int(m[2]) * factor)
    if m := re.search(r"(?:>|mas de)\s*(\d+)|(\d+)\s*\+", b):
        return (int(m[1] or m[2]) * factor, np.inf)
    if m := re.search(r"(?:<|menos de)\s*(\d+)", b):
        return (0, int(m[1]) * factor)
    return (np.nan, np.nan)


def bandas_no_entendibles(s):
    return sorted({v for v in s.dropna().unique()
                   if v != ETIQUETA_SIN_DATO and np.isnan(rango_banda(v)[0])})


# ── Carga y validación de columnas ─────────────────────────────────────────────

def leer_archivo(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path, header=HEADER_EXCEL)
    if ext == ".csv":
        return pd.read_csv(path)
    raise ValueError(f"extensión no admitida: {ext}")


def validar_columnas(data, avisos):
    """normaliza nombres, quita columnas nuevas y crea vacías las que falten"""
    data = limpiar_nombres(data)
    if not data.columns.is_unique:
        raise ValueError("dos columnas quedaron con el mismo nombre tras normalizarlas")
    if "equipo_id" not in data.columns:
        raise ValueError("falta la columna EquipoID; no se puede procesar el archivo")

    esperadas = COLS_A + COLS_B
    # columnas sin título y vacías (restos del formato del Excel) se quitan sin avisar
    nuevas = [c for c in data.columns if c not in esperadas and data[c].notna().any()]
    if nuevas:
        avisos.append(f"Se eliminaron columnas no reconocidas: {nuevas}")
    faltantes = [c for c in esperadas if c not in data.columns]
    if faltantes:
        avisos.append(f"Faltan columnas; se cargan como '{ETIQUETA_SIN_DATO}': {faltantes}")
        for c in faltantes:
            data[c] = pd.NA

    return data[esperadas]


# ── Parte A ────────────────────────────────────────────────────────────────────

def limpiar_a(data_raw, avisos):
    df_a = data_raw[COLS_A].copy()

    # llave equipo_id
    df_a["equipo_id"] = df_a["equipo_id"].astype("string").str.strip().str.upper()
    df_a["flag_sin_equipo_id"] = df_a["equipo_id"].isna()
    df_a["flag_equipo_id_duplicado"] = df_a["equipo_id"].notna() & df_a.duplicated("equipo_id", keep=False)
    if df_a["flag_sin_equipo_id"].any():
        avisos.append(f"Equipos sin EquipoID: {int(df_a['flag_sin_equipo_id'].sum())}")
    if df_a["flag_equipo_id_duplicado"].any():
        avisos.append(f"Filas con EquipoID repetido: {int(df_a['flag_equipo_id_duplicado'].sum())}")

    cat_cols = [c for c in COLS_A if c != "equipo_id"]

    # binarias Sí/No → _bool (valores no esperados quedan como nulo)
    for c in BOOL_COLS:
        s = df_a[c].map(lambda x: sin_acentos(x).strip().lower() if pd.notna(x) else x)   # "Sí" → "si"
        inesperados = set(s.dropna().unique()) - set(MAPA_SI_NO)
        if inesperados:
            avisos.append(f"{c}: valores no esperados {sorted(inesperados)} → quedan sin dato en {c}_bool")
        df_a[f"{c}_bool"] = s.map(MAPA_SI_NO).astype("boolean")

    # familia de SO (version_so se conserva)
    df_a["familia_so"] = df_a["version_so"].map(familia_so)
    cat_cols.append("familia_so")
    n_sin_clasificar = int((df_a["familia_so"] == "Sin clasificar").sum())
    if n_sin_clasificar:
        avisos.append(f"Versiones de SO sin clasificar: {n_sin_clasificar}")

    # Unknown en cumplimiento = no evaluado (su cifrado sí se conoce)
    df_a["estado_de_cumplimiento"] = df_a["estado_de_cumplimiento"].replace({"Unknown": "No evaluado"})

    # incoherencia: no cifrado pero marcado como compliant
    df_a["flag_compliant_sin_cifrar"] = (
        (df_a["estado_de_cumplimiento"] == "Compliant") &
        (df_a["estado_de_cifrado"] == "Not encrypted")
    )

    # unificar vacíos y etiquetas tipo "No disponible"
    for c in cat_cols:
        mask = df_a[c].isna() | es_sin_dato(df_a[c])
        df_a[c] = df_a[c].astype("object").mask(mask, ETIQUETA_SIN_DATO)

    # flags
    sin_dato = df_a[cat_cols] == ETIQUETA_SIN_DATO
    df_a["n_campos_sin_dato"] = sin_dato.sum(axis=1)
    df_a["flag_sin_estado_cifrado"] = df_a["estado_de_cifrado"] == ETIQUETA_SIN_DATO

    return df_a


# ── Parte B ────────────────────────────────────────────────────────────────────

def limpiar_b(data_raw, avisos):
    df_b = data_raw[["equipo_id"] + COLS_B].copy()
    df_b["equipo_id"] = df_b["equipo_id"].astype("string").str.strip().str.upper()

    # B.3 usuario_id
    u = df_b["usuario_id"].astype("string").str.strip()
    sin_usuario = (u.isna() | es_sin_dato(u)
                   | u.map(lambda x: sin_acentos(x).lower() if pd.notna(x) else x).eq("no asignado"))
    df_b["usuario_id"] = u.mask(sin_usuario, ETIQUETA_SIN_USUARIO)

    df_b["flag_sin_usuario"] = df_b["usuario_id"] == ETIQUETA_SIN_USUARIO
    equipos_por_usuario_b = df_b.loc[~df_b["flag_sin_usuario"], "usuario_id"].value_counts()
    df_b["n_equipos_usuario"] = (df_b["usuario_id"].map(equipos_por_usuario_b)
                                 .fillna(0).astype("Int64"))

    # B.4 categóricas: variantes → forma más frecuente + unificar faltantes
    for c in CAT_B:
        s = limpiar_espacios(df_b[c])
        k = clave_txt(s)
        forma = (pd.DataFrame({"k": k, "v": s}).dropna()
                   .groupby("k")["v"].agg(lambda g: g.value_counts().idxmax()))
        nueva = k.map(forma)
        mask = nueva.isna() | es_sin_dato(nueva)
        df_b[c] = nueva.astype("object").mask(mask, ETIQUETA_SIN_DATO)

    # B.5 país → región: completar región faltante con la del país (solo países sin conflicto)
    conf_pais = conflictos_jerarquia(df_b, "pais", "region")
    if len(conf_pais):
        avisos.append(f"Países con más de una región: {conf_pais.index.tolist()}")
    con_dato = df_b[(df_b["pais"] != ETIQUETA_SIN_DATO) & (df_b["region"] != ETIQUETA_SIN_DATO)]
    region_de_pais = (con_dato.groupby("pais")["region"].agg(lambda g: g.value_counts().idxmax())
                      .drop(conf_pais.index, errors="ignore"))
    completar = (df_b["region"] == ETIQUETA_SIN_DATO) & df_b["pais"].isin(region_de_pais.index)
    df_b["flag_region_imputada"] = completar
    df_b.loc[completar, "region"] = df_b.loc[completar, "pais"].map(region_de_pais)

    # B.6 antigüedad: numérica + validar banda
    s = limpiar_espacios(df_b["banda_antiguedad"])
    df_b["banda_antiguedad"] = s.astype("object").mask(s.isna() | es_sin_dato(s), ETIQUETA_SIN_DATO)

    original = df_b["antiguedad_meses"]
    meses = pd.to_numeric(original.mask(es_sin_dato(original)), errors="coerce")
    absurdos = (meses < 0) | (meses > 600)            # negativos o más de 50 años
    df_b["antiguedad_meses_num"] = meses.mask(absurdos).astype("Float64")

    rangos = df_b["banda_antiguedad"].map(rango_banda)
    lo, hi = rangos.str[0], rangos.str[1]
    meses_f = df_b["antiguedad_meses_num"].astype(float)
    validable = df_b["antiguedad_meses_num"].notna() & lo.notna()
    dentro = (meses_f >= lo) & (meses_f <= hi)
    df_b["flag_banda_antiguedad_incoherente"] = validable & ~dentro
    if no_entendibles := bandas_no_entendibles(df_b["banda_antiguedad"]):
        avisos.append(f"Bandas de antigüedad no entendibles: {no_entendibles}")

    # B.7 último logon: fecha + validar banda de recencia
    original = df_b["mes_ultimo_logon"]
    if pd.api.types.is_datetime64_any_dtype(original):
        fecha = original
    else:
        txt = limpiar_espacios(original)
        txt = txt.mask(es_sin_dato(txt))
        fecha = pd.to_datetime(txt, format="%Y-%m", errors="coerce")
        no_convertidas = int((txt.notna() & fecha.isna()).sum())
        if no_convertidas:
            avisos.append(f"mes_ultimo_logon: {no_convertidas} valores no se pudieron convertir a fecha")
    df_b["mes_ultimo_logon_fecha"] = fecha

    corte = FECHA_CORTE_B if FECHA_CORTE_B is not None else fecha.max() + pd.offsets.MonthEnd(0)

    s = limpiar_espacios(df_b["banda_recencia"])
    df_b["banda_recencia"] = s.astype("object").mask(s.isna() | es_sin_dato(s), ETIQUETA_SIN_DATO)

    # solo se sabe el mes: la fila es incoherente solo si NINGÚN día de ese mes cae dentro de su banda
    dias_min = (corte - (fecha + pd.offsets.MonthEnd(0))).dt.days.clip(lower=0)
    dias_max = (corte - fecha).dt.days
    rangos = df_b["banda_recencia"].map(rango_banda)
    lo, hi = rangos.str[0], rangos.str[1]
    validable = fecha.notna() & lo.notna()
    df_b["flag_banda_recencia_incoherente"] = validable & ~((dias_max >= lo) & (dias_min <= hi))
    if no_entendibles := bandas_no_entendibles(df_b["banda_recencia"]):
        avisos.append(f"Bandas de recencia no entendibles: {no_entendibles}")

    return df_b


# ── Unión A × B ────────────────────────────────────────────────────────────────

def unir(df_a, df_b):
    """A y B salen de las mismas filas del Excel, así que se unen fila a fila.
    Equivale al left join por equipo_id del EDA, pero no falla si hay ids nulos o repetidos."""
    df_ab = pd.concat([df_a, df_b.drop(columns="equipo_id")], axis=1)
    df_ab["flag_sin_datos_b"] = ~df_ab["equipo_id"].isin(df_b["equipo_id"].dropna())
    assert len(df_ab) == len(df_a), "la unión cambió el número de filas de A"
    return df_ab


def limpiar(path):
    """Excel crudo → df_ab limpio + lista de avisos"""
    avisos = []
    data_raw = validar_columnas(leer_archivo(path), avisos)
    if data_raw.empty:
        raise ValueError("el archivo no tiene filas")
    df_ab = unir(limpiar_a(data_raw, avisos), limpiar_b(data_raw, avisos))
    return df_ab, avisos


# ── Guardado ───────────────────────────────────────────────────────────────────

def escribir_atomico(destino, texto):
    """escribe a un temporal y lo renombra: nunca queda un archivo a medias"""
    carpeta = os.path.dirname(destino)
    fd, tmp = tempfile.mkstemp(dir=carpeta, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(texto)
        os.replace(tmp, destino)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def guardar(df_ab, avisos, path_origen, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    flags = [c for c in df_ab.columns if c.startswith("flag_")]
    meta = {
        "archivo_origen": os.path.basename(path_origen),
        "procesado_en": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "filas": len(df_ab),
        "columnas": df_ab.columns.tolist(),
        "flags": {c: int(df_ab[c].sum()) for c in flags},
        "avisos": avisos,
    }
    # primero los datos y después el meta: el meta siempre describe al current.json vigente
    escribir_atomico(os.path.join(out_dir, "current.json"),
                     df_ab.to_json(orient="records", date_format="iso", force_ascii=False))
    escribir_atomico(os.path.join(out_dir, "current_meta.json"),
                     json.dumps(meta, ensure_ascii=False, indent=2))
    return meta


def main():
    parser = argparse.ArgumentParser(description="Limpieza del Excel de cifrado → current.json")
    parser.add_argument("archivo", help="Excel o CSV subido")
    parser.add_argument("--out-dir", default=os.environ.get("CLEAN_DIR", "data"),
                        help="carpeta de salida (por defecto ./data o $CLEAN_DIR)")
    args = parser.parse_args()

    try:
        df_ab, avisos = limpiar(args.archivo)
        meta = guardar(df_ab, avisos, args.archivo, args.out_dir)
    except Exception as err:
        print(json.dumps({"ok": False, "error": str(err)}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps({"ok": True, "filas": meta["filas"], "columnas": len(meta["columnas"]),
                      "avisos": avisos}, ensure_ascii=False))


if __name__ == "__main__":
    main()
