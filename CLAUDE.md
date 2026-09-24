# Instrucciones para asistentes de IA

Este archivo lo lee automáticamente Claude Code. Aplica a cualquier asistente
que trabaje en este repositorio.

## Bitácora obligatoria

Antes de trabajar, lee [docs/BITACORA.md](docs/BITACORA.md).

Al terminar un cambio, actualiza la bitácora en el mismo cambio si:

- agregaste o modificaste una variable de entorno, especialmente de tiempo
  (actualiza la tabla «Valores de tiempo»);
- tomaste una decisión de diseño que no se deduce del código;
- encontraste un fallo, su causa o un comportamiento sorprendente;
- dejaste algo pendiente o sin confirmar.

Sigue el formato y las reglas descritas en la sección «Protocolo» de la
bitácora. No registres secretos ni datos de pacientes.

## Reglas del proyecto

- Modo observer/dry-run: no agregar código que envíe mensajes reales a
  WhatsApp sin autorización explícita.
- No ejecutar `supabase db push` ni modificar datos reales de Supabase sin
  autorización explícita.
- Conservar takeover humano e idempotencia.
- No crear una tabla paralela `exams`; no fusionar variantes de exámenes por
  nombre; Helicobacter siempre como variantes separadas.

## Verificación

```bash
npm run lint
npm test
npm run build
```
