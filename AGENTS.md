# Instrucciones para asistentes de IA (Codex y otros)

Las instrucciones del proyecto están en [CLAUDE.md](CLAUDE.md) y aplican a
cualquier asistente: léelo antes de trabajar. Resumen:

- Lee primero [docs/BITACORA.md](docs/BITACORA.md) y actualízala en el mismo
  cambio según su «Protocolo».
- Modo observer/dry-run: nada de envíos reales de WhatsApp sin autorización
  explícita. Nada de `supabase db push` ni cambios en datos reales sin
  autorización explícita.
- El repositorio es **público**: nunca subir recetas, listas de precios,
  conversaciones ni claves. Los datos privados van fuera del repo.
- Para auditar la lectura de recetas, ver en la bitácora «Recetas:
  identificación en el catálogo» → «Auditoría: qué revisar cuando cambie
  esta lógica».
- Verificación: `npm run lint`, `npm test`, `npm run build`.
