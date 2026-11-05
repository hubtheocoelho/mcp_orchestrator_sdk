# Análise — Implementações do Dia 3 (2026-11-03)

> Escopo: 12 commits de `da0531e` a `1078bc9` (+4.351 / −53 linhas, 47 arquivos).
> Estado verificado: `npm run typecheck` limpo, **100 testes passando, 0 falhas** (eram 69 no review anterior).

## 1. O que foi entregue

| Área | Entrega | Arquivos principais |
|---|---|---|
| Streaming | `OrchestratorEvent` (união discriminada), `callToolStream`, `executeWorkflowStream` | `core/src/orchestrator-event.ts`, `core/src/orchestrator.ts` |
| Cancelamento | `AbortSignal` ponta a ponta (orchestrator → registry → McpClient → transport), `OrchestratorAbortError`, `notifications/cancelled` no HTTP | `core/src/orchestrator.ts`, `mcp/src/*` |
| Progresso | `onProgress` em `ExecuteOptions`/`ToolExecutionContext`; `notifications/progress` → `step.progress` | `core/src/tool-registry.ts`, `mcp/src/client.ts` |
| Tracing | Interface `Tracer`/`Span` estilo OTel, `NoopTracer`, spans `workflow.execute` e `workflow.step.<id>` | `core/src/tracing.ts`, `workflow/src/executor.ts` |
| Workflow | Passos paralelos (`parallel`), política `continue`, alias `onError`, checkpoint + `resume()` | `workflow/src/executor.ts`, `checkpoint.ts`, `schema.ts` |
| MCP features | Prompts, resources, sampling handler, roots (stub), `HttpTransport` | `mcp/src/client.ts`, `http-transport.ts`, `types.ts` |
| Lifecycle | `dispose()` + `Symbol.asyncDispose` em Orchestrator, McpClient, HttpTransport, StateManager | vários |
| DX | 4 exemplos executáveis, `runHarness`, guias streaming/tracing/mcp-features/migration, quickstart | `examples/`, `docs/` |

**Pontos fortes:** mudanças majoritariamente aditivas (APIs antigas intactas), tracing sem dependência de OTel, `AbortSignal` realmente propagado até o `fetch`, boa cobertura de testes nas features novas.

## 2. Problemas encontrados

> Os 5 itens de alta prioridade foram corrigidos — ver [seção 5](#5-correções-aplicadas).

### Alta prioridade

1. **Artefatos de build commitados em `src/`** — `workflow/src/{expression,schema}.{js,d.ts,map}` (commit `5e42cf9`). O `schema.js` está **desatualizado** (não tem `continue` nem `parallel`). Qualquer resolver que prefira o `.js` existente carrega o schema antigo silenciosamente. → Remover e adicionar ao `.gitignore`.

2. **`executeWorkflowStream` é um segundo executor, divergente do `WorkflowExecutor`** (`core/src/orchestrator.ts`). Ignora `when`/`stop_when` (aceitos na assinatura), não interpola `${...}` nos params (monta `scope` e nunca usa), sem retry/skip/continue, sem paralelo, sem checkpoint, sem spans, e nunca emite `resumed`/`fromStep`. Mesmo workflow tem semânticas diferentes em modo stream vs. não-stream. → Fazer o stream ser um adaptador sobre o `WorkflowExecutor` (eventos via audit sink/callback).

3. **Abort não acorda o loop de streaming.** Em `callToolStream`/`executeWorkflowStream` o loop espera `notify`, que só dispara em progresso ou fim da tool. Se a tool ignorar o signal (ex.: `InMemoryTransport.callTool` não repassa o signal ao handler), o stream fica pendurado; `callToolStream` ainda faz `await callPromise` após o `break` e não emite evento de falha. → Registrar listener `abort` que chama `notify`.

4. **Cálculo de `outputs` com `continue` está errado** (`workflow/src/executor.ts`). `outputs` só é preenchido se **todos** os passos forem `continue`; basta um passo sem `continue` no workflow para zerar os outputs, mesmo quando a falha veio do passo `continue`. → Basear na política do passo que falhou (ex.: flag `hardFailure`).

5. **Abort em passo paralelo lança exceção em vez de retornar `WorkflowResult`.** Quebra o padrão "errors as values"; além disso `workflowSpan` não é finalizado e `run-complete` não é emitido (sem `try/finally`). O teste fixa esse comportamento (`rejects with OrchestratorAbortError`), enquanto o abort sequencial retorna `ok:false` — inconsistente.

### Média prioridade

6. **Checkpoint chaveado só por `workflowId`.** Execuções concorrentes do mesmo workflow sobrescrevem o checkpoint uma da outra; checkpoint não é limpo em sucesso. → Chavear por `runId` (ou `workflowId+runId`) e `delete` ao concluir.
7. **`Orchestrator.tracer` e `Orchestrator.samplingHandler` não são usados.** `callTool` não gera span; o handler de sampling do orchestrator nunca é conectado aos `McpClient`s. API pública que promete algo que não faz.
8. **`HttpTransport` não é MCP.** Fala um REST próprio (`GET /tools`, `POST /tools/:name/call`), não JSON-RPC/Streamable HTTP; não há canal para progress, sampling ou prompts, e não aceita headers de auth. `handleProgress`/`handleSamplingRequest` existem no client mas nenhum transport os invoca. → Renomear (ex.: `RestTransport`) ou documentar claramente; MCP real fica como próximo passo.
9. **Paralelo**: mesmos `params` para todas as tools, ignora `retry`, `durationMs: 0` nos sub-eventos, `tool` continua obrigatório (vira só rótulo). Spans vazam se `runStep` lançar.
10. **Testes de timing frágeis** (`elapsed < 120ms`) — tendem a falhar em CI carregado.

### Baixa prioridade

- `getPrompt`/`readResource` do Orchestrator engolem qualquer erro do provider (não só "não encontrado").
- `Orchestrator.dispose()` é no-op e `disposed` não bloqueia chamadas posteriores; não descarta MCP clients registrados.
- `setRoots` é stub sem efeito.
- Estilo: `import("./tracing.js").Tracer` inline apesar do import já existir; `as any` no `runHarness`.
- `.kiro/settings/lsp.json` (205 linhas) commitado junto com features — config de editor pessoal.

## 3. Itens do REVIEW.md anterior

- **#4 Timeout/cancelamento:** parcialmente endereçado (signal propagado), mas ainda **sem timeout forçado** — tool que ignora o signal continua travando.
- **#1 allowlist fail-open, #2 symlinks, #3 `__proto__`, #5 `tools.execute` público:** não tocados no dia 3.

## 4. Recomendação de próximos passos (ordem)

1. ~~Remover `.js/.d.ts/.map` de `src/` + `.gitignore`.~~ ✅
2. ~~Corrigir lógica de `outputs` com `continue` e unificar comportamento de abort.~~ ✅
3. ~~Reimplementar `executeWorkflowStream` sobre `WorkflowExecutor` e fazer abort acordar o loop.~~ ✅
4. Chavear checkpoints por run; limpar em sucesso.
5. Ligar `tracer` em `callTool` e `samplingHandler` aos clients — ou remover das opções até existir.
6. Decidir o destino do `HttpTransport` (renomear vs. implementar MCP Streamable HTTP).

## 5. Correções aplicadas

| # | Correção | Onde |
|---|---|---|
| 1 | Removidos 8 artefatos compilados de `workflow/src/`; `.gitignore` bloqueia `.js/.d.ts/.map` em `packages/*/src`. | `.gitignore` |
| 2 | `executeWorkflowStream` delega para `WorkflowRunner.executeDefinition` (implementado por `WorkflowEngine` e ligado em `createReferenceOrchestrator`): passos inline ganham interpolação, `when`/`stop_when`, políticas, retry, paralelo e spans. O `WorkflowExecutor` emite os `OrchestratorEvent` via `ExecutionContext.onEvent` (inclui `step.progress`, `step.failed` com `willRetry: true` e `resumed`/`fromStep`). Sem runner, o fallback mínimo **falha rápido** se houver `when`/`stop_when`/`${...}` em vez de executar errado. Novo `Orchestrator.streamWorkflow(id, inputs)` para workflows registrados. | `core/src/orchestrator.ts`, `workflow/src/executor.ts`, `workflow/src/engine.ts`, `reference-impl/src/index.ts` |
| 3 | Novo `pumpEvents` (`core/src/event-pump.ts`) usado por todos os streams: acorda o consumidor também no `abort`, emite um evento de abort e encerra sem esperar a tool; resultado tardio é descartado. | `core/src/event-pump.ts` |
| 4 | Flag `hardFailure`: `outputs` só é zerado quando a execução parou (`fail`, `retry` esgotado, abort). Falha em passo `continue` mantém os outputs. | `workflow/src/executor.ts` |
| 5 | Abort (sequencial ou paralelo) sempre retorna `WorkflowResult` com `ok:false`/`"Workflow aborted"`; erros lançados pelo `ToolCaller` viram resultado (`safeCallTool`); spans têm `try/finally`. O teste que fixava a rejeição foi reescrito. | `workflow/src/executor.ts` |

Também: `step-complete` dos sub-passos paralelos agora tem `durationMs` real; `import("./tracing.js").Tracer` inline foi trocado pelo tipo importado; `docs/streaming.md` atualizado.

**Verificação:** `npm run ci` limpo — **110 testes passando** (10 novos: abort com tool que ignora o signal em `callToolStream`/`executeWorkflowStream`, fallback rejeitando templates, delegação a `executeDefinition`, semântica completa via engine, `streamWorkflow`, `continue` misto, falha dura após `continue`, eventos de resume e de retry). Exemplos `02-streaming` e `03-cancellation` executados com sucesso.

**Mudanças de comportamento para consumidores:**
- `WorkflowExecutor.execute` não rejeita mais em abort de passo paralelo; retorna `ok:false`.
- `executeWorkflowStream` em `new Orchestrator()` sem runner agora emite `workflow.failed` para passos com `when`/`stop_when`/`${...}` (antes executava ignorando-os).
- `callToolStream` abortado emite `tool.chunk` com `{ error: "Operation aborted" }` e encerra imediatamente.
