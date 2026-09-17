# Lab WhatsApp Agent

Agente de WhatsApp para laboratorio clínico.

## Estado

Repositorio inicial. La primera fase implementa únicamente observabilidad del canal:

- recepción segura de webhooks de Kapso;
- persistencia normalizada en Supabase;
- clasificación de mensajes de cliente, recepcionista y API;
- base para human takeover;
- sin respuestas automáticas ni procesamiento de recetas todavía.

La arquitectura toma como referencia los patrones probados de `rochayoan/la-fija-orders`, pero mantiene este proyecto aislado.
