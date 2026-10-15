# Decisiones de limpieza — Parte B (cols_B)
_5,563 equipos · ninguna fila eliminada._

## Criterios compartidos con la parte A
- Nombres con `limpiar_nombres()` (snake_case, sin acentos).
- Faltantes de categóricas unificados como `No disponible` (mismo patrón `es_sin_dato`).
- Conversiones de tipo como columnas nuevas; la original se conserva.
- Problemas de calidad marcados con columnas `flag_*`; no se eliminan filas.

## B.2 Renombres
| original | nuevo |
|---|---|
| EquipoID | equipo_id |
| UsuarioID | usuario_id |
| País | pais |
| Región | region |
| Categoría de Equipo | categoria_de_equipo |
| Clase de Equipo | clase_de_equipo |
| Perfil de Privilegio | perfil_de_privilegio |
| Antigüedad Meses | antiguedad_meses |
| Banda Antigüedad | banda_antiguedad |
| Estado de Cuenta | estado_de_cuenta |
| Mes Último Logon | mes_ultimo_logon |
| Banda Recencia | banda_recencia |
| Estado Hardware | estado_hardware |
| Tipo de Red | tipo_de_red |

## B.3 usuario_id
- `No asignado` se conserva como información; se agregan `flag_sin_usuario` y `n_equipos_usuario`.
- equipos sin usuario: 805
- % sin usuario: 14.5
- usuarios distintos: 4496
- usuarios con más de 1 equipo: 200
- máximo de equipos de un usuario: 20

## B.4 Categóricas
- No había variantes de escritura; los valores se conservan como vienen en la fuente.

## B.5 Jerarquías
- países con más de una región: ninguno
- regiones completadas a partir del país: 0
- categorías con más de una clase: ninguna
- clases con más de una categoría: ninguna
- Regiones completadas marcadas con `flag_region_imputada`.

## B.6 Antigüedad
- Nueva columna `antiguedad_meses_num`; flag `flag_banda_antiguedad_incoherente`.
- valores no numéricos: 0
- valores absurdos (<0 o >600) → NaN: 0
- bandas no entendibles: ninguna
- filas validables (meses y banda): 13
- banda incoherente con los meses: 0
- con meses pero sin banda: 0
- con banda pero sin meses: 0
- outliers (Tukey): 0

## B.7 Último logon
- Nueva columna `mes_ultimo_logon_fecha`; flag `flag_banda_recencia_incoherente`.
- fecha de corte usada: 2025-11-30
- texto que no se pudo convertir: 0
- rango de fechas: 2023-01-01 a 2025-11-01
- fechas posteriores al corte: 0
- bandas no entendibles: ninguna
- filas validables (fecha y banda): 5163
- banda incoherente con la fecha: 25

## B.10 Antes vs. después
|  | unicos_antes | unicos_despues | %_sin_dato_antes | %_sin_dato_despues |
|---|---|---|---|---|
| usuario_id | 4497.0 | 4497.0 | 0.0 | 14.5 |
| pais | 11.0 | 11.0 | 7.0 | 7.0 |
| region | 4.0 | 4.0 | 7.0 | 7.0 |
| categoria_de_equipo | 2.0 | 2.0 | 99.8 | 99.8 |
| clase_de_equipo | 1.0 | 1.0 | 0.0 | 0.0 |
| perfil_de_privilegio | 4.0 | 3.0 | 99.8 | 99.8 |
| antiguedad_meses | 5.0 | 5.0 | 99.8 | 99.8 |
| banda_antiguedad | 4.0 | 4.0 | 99.8 | 99.8 |
| estado_de_cuenta | 3.0 | 3.0 | 7.0 | 7.0 |
| mes_ultimo_logon | 22.0 | 22.0 | 7.2 | 7.2 |
| banda_recencia | 5.0 | 5.0 | 7.0 | 7.0 |
| estado_hardware | 3.0 | 3.0 | 99.8 | 99.8 |
| tipo_de_red | 3.0 | 3.0 | 99.8 | 99.8 |

## Pendientes para decidir en equipo
- Columnas con más de 90% sin dato (candidatas a eliminar): ['categoria_de_equipo', 'perfil_de_privilegio', 'antiguedad_meses', 'banda_antiguedad', 'estado_hardware', 'tipo_de_red']
- Filas con banda incoherente: ¿recalcular la banda desde el dato o solo marcar?
- Fecha de corte real de la extracción (para validar la recencia con precisión).

## Hallazgos del EDA
- _completar_
