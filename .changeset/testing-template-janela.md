---
'@usebridger/testing': minor
---

Janela de atendimento no `FakeTransport` (opção `window: { enabled, ttlMs }`, ADR 0124): o envio
livre sem janela aberta rejeita com `ConversationWindowError` e `window(chatId)` devolve o estado.
Novo matcher `toContainTemplate(name?)`, e `describeSent` mostra template como `<template "nome">`.
