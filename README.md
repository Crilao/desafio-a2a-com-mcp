# A Ponte: um agente A2A com MCP por dentro

*Onde termina a profundidade e começa o alcance*

**Projeto:** MBA Engenharia de Software com IA, curso de MCP e A2A
**Desafio:** A Ponte

---

Dois processos, dois protocolos, e um único estado que precisa atravessar a
fronteira entre eles.

- **`servidor-mcp/`** — servidor MCP em Streamable HTTP na porta `7301`, com as
  três tools, o resource da política e o ciclo completo de MRTR na reserva.
- **`agente/`** — agente A2A na porta `7300`. Por dentro é **host MCP**: fala
  com o servidor acima por HTTP, como um cliente MCP de verdade. Por fora é
  **servidor A2A**: publica o Agent Card, aceita `SendMessage` e `GetTask`, e
  faz a Task passar por `TASK_STATE_INPUT_REQUIRED`.

Nenhum dos dois protocolos tem sessão. O MCP resolve isso com o `requestState`
do MRTR; o A2A resolve com a Task. A costura entre os dois é a ponte — e é ela
que este trabalho constrói.

---

## Como rodar

Requisitos: **Node.js 20 ou superior** (testado no 23.11.1) e **Python 3.10 ou
superior** para o validador.

### 1. Segredo do `requestState`

O `requestState` é assinado com HMAC-SHA256 e a chave **nunca** está no código:
ela vem da variável de ambiente `REQUEST_STATE_SECRET`, com no mínimo 32 bytes
de aleatoriedade. Gere a sua assim:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Guarde o valor que saiu. Ele não vai para o repositório — o repositório é
público, e um segredo versionado deixaria qualquer um forjar um `requestState`.

> A mesma chave precisa valer para todas as instâncias do servidor MCP, porque
> é ela que permite um retry sobreviver a um restart do processo. Trocar a
> chave invalida os `requestState` emitidos antes da troca.

### 2. Subir os dois processos

Cada um no seu terminal. A partir da raiz do repositório:

**Terminal 1 — servidor MCP** (deixe o stderr visível, é ele que o avaliador
inspeciona):

```bash
cd servidor-mcp
npm install
export REQUEST_STATE_SECRET="<o valor que você gerou>"
npm start
```

**Terminal 2 — agente A2A:**

```bash
cd agente
npm install
npm start
```

Os dois processos são independentes: o agente fala com o servidor MCP por HTTP
em `http://127.0.0.1:7301/mcp`. Suba o servidor MCP primeiro.

Portas e caminhos são parametrizáveis, com estes padrões:

| Variável | Padrão | Onde |
|---|---|---|
| `MCP_PORT` | `7301` | servidor MCP |
| `MCP_PATH` | `/mcp` | servidor MCP |
| `MCP_URL` | `http://127.0.0.1:7301/mcp` | agente (para onde ele chama) |
| `AGENTE_PORT` | `7300` | agente |
| `AGENTE_PATH` | `/a2a` | agente |

### 3. Rodar o validador

Com os dois processos recém-iniciados (as reservas criadas por uma execução
mudam o resultado da seguinte):

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

### 4. Conferir o Agent Card

```bash
curl http://localhost:7300/.well-known/agent-card.json
```

Compare com `exemplos/wire/07-a2a-agent-card.json`: a interface JSON-RPC, a
versão de protocolo `1.0` e a skill `reservar-sala`.

---

## Onde a ponte acontece

**O `input_required` do MCP vira `TASK_STATE_INPUT_REQUIRED` em
`agente/src/a2a.js`, na função `aplicarResultado` (por volta da linha 120).** É
ali que o agente olha o resultado que voltou do servidor MCP com
`isInputRequiredResult(...)` e, em vez de responder a elicitation — o que
fecharia o ciclo sozinho e faria a Task nunca pausar — guarda o `requestState`
ligado àquela Task, muda o estado para `TASK_STATE_INPUT_REQUIRED` e devolve a
pergunta ao cliente A2A como a linha de texto `alternativas: <ids>`. O
`requestState` fica em `tarefa.pausa`, que é estado interno: a serialização da
Task usa lista branca explícita justamente para que ele nunca vaze numa resposta
A2A.

**O `requestState` volta para o servidor MCP em `agente/src/mcp-host.js`, na
função `retomarReserva` (por volta da linha 101).** Quando chega um
`SendMessage` de continuação referenciando a Task, o agente monta um `tools/call`
novo — com id de JSON-RPC novo, porque são requests independentes — levando
`inputResponses` com a mesma chave que veio no `inputRequests` e o
`requestState` ecoado sem modificação. O agente nunca abre, interpreta nem
reconstrói esse valor: guarda, ecoa, esquece.

Do outro lado, o servidor emite o pedido em `servidor-mcp/src/ferramentas.js`: o
`codec.mint` sela o pedido original (linha ~192) e o `inputRequired({...})` monta
a resposta que termina o request pedindo informação (linha ~197).

O caminho completo de um único `SendMessage` de sala ocupada:

```
cliente A2A ──SendMessage──▶ agente
                              │
                              ├─ tools/list          (descoberta, uma vez)
                              ├─ resources/read      (versão da política)
                              └─ tools/call reservar_sala
                                       │
                              ◀────────┘ input_required + elicitation + requestState
                              │
                              ├─ guarda requestState na Task
                              ├─ Task → TASK_STATE_INPUT_REQUIRED
                              └─ responde "alternativas: sala-fusca, sala-mirante"
                                       │
cliente A2A ──SendMessage escolha=sala-fusca──▶ agente
                              │
                              └─ tools/call (id NOVO) + inputResponses + requestState
                                       │
                              ◀────────┘ complete
                              │
                              └─ Task → TASK_STATE_COMPLETED + artifact reserva
```

---

## Decisões técnicas

### Como o `requestState` é protegido

Com **HMAC-SHA256**, pelo `createRequestStateCodec` do SDK. O formato de fio é
`v1.<b64url(payload)>.<b64url(mac)>`: o payload viaja **legível** (o codec assina,
não cifra) e isso é aceito pela spec — o que não pode é ser **adulterável**.
Trocar um único caractere muda o MAC e a verificação falha.

A verificação é *fail-closed* e em tempo constante, e está ligada em
`ServerOptions.requestState.verify` (`servidor-mcp/src/index.js`). Isso importa:
o seam roda o `verify` **antes** do handler, então um `requestState` adulterado
ou expirado nem chega na lógica de negócio — o request é recusado com `-32602`
e a mensagem `Invalid or expired requestState`.

A chave vem exclusivamente de `REQUEST_STATE_SECRET`, validada na subida do
processo: se faltar ou tiver menos de 32 bytes, o servidor não sobe. Não há
segredo no código.

### Por quanto tempo ele vale

**15 minutos** (`TTL_SEGUNDOS = 900` em `servidor-mcp/src/estado.js`), dentro da
janela de 5 a 30 minutos que o enunciado exige. Passado o prazo, o codec recusa
e o request volta como `-32602`.

### O que ele carrega

O pedido original inteiro — `sala`, `inicio`, `fim`, `responsavel` — mais a lista
de `alternativas` que foi oferecida. O servidor **não guarda nada em memória**
entre o `input_required` e o retry: tudo que ele precisa para reconstruir a
operação viaja dentro do próprio estado.

É por isso que um retry sobrevive a um restart do processo do servidor MCP, e
está verificado: matar o processo, subir de novo com a mesma
`REQUEST_STATE_SECRET` e apresentar o mesmo `requestState` conclui a reserva.

Como o estado é selado, os `arguments` que o cliente reenvia no retry são
tratados como entrada não confiável: quando há `requestState` válido, os valores
que valem são **os selados**. Um retry com argumentos adulterados não produz
reserva com os valores adulterados.

### Onde ficou o estado das Tasks

Em um `Map` em memória, no escopo do módulo `agente/src/a2a.js`. A persistência
de reservas também é em memória (`servidor-mcp/src/dominio.js`), como o enunciado
permite — reservas não precisam sobreviver a um restart, o `requestState` precisa.

O estado de pausa é **por Task**, nunca global: cada Task guarda o seu próprio
`requestState` e a sua própria chave. Dois pedidos em conflito, pausados ao mesmo
tempo, terminam cada um com a sua reserva, sem trocar de estado.

Cada Task guarda `id`, `contextId`, `status`, `history` e `artifacts`, mais dois
campos privados que **nunca** são serializados: `requestState` e a chave do
`inputRequests`. A serialização monta o objeto campo a campo, em vez de espalhar
a Task, para que o `requestState` não tenha por onde vazar.

### Nada de sessão

O servidor MCP cria uma instância nova por request e recusa qualquer request sem
os campos obrigatórios de `_meta` — não infere versão nem capabilities de um
request anterior. O cliente do agente mantém o objeto vivo entre chamadas (o que
é normal e recomendado), mas cada request leva o seu próprio envelope `_meta`.

### Duas armadilhas do SDK, e como foram tratadas

O cliente MCP do SDK **auto-atende o MRTR por padrão**: ele responde a
elicitation sozinho e refaz a chamada internamente, de modo que a Task nunca
pausaria e metade do desafio evaporaria. Por isso o agente é construído com:

```js
inputRequired: { autoFulfill: false }        // o input_required chega cru
```

e cada chamada passa `allowInputRequired: true` com `withInputRequired(z.any())`
no caminho de schema explícito. Sem isso, `callTool()` devolveria sempre um
resultado completo e a pausa seria invisível.

Além disso, a negociação de versão do cliente é **legacy por padrão**. Como o
servidor só fala a revisão `2026-07-28`, o agente fixa a era:

```js
versionNegotiation: { mode: { pin: '2026-07-28' } }
```

### A checagem de capability não é feita à mão

A tentação é ler `clientCapabilities` do `_meta` e lançar o `-32021` na mão. Não
funciona: o handler roda dentro do limite de erro de execução da tool, então o
erro viraria um `isError: true` com HTTP 200 em vez do erro de protocolo. O seam
do SDK já faz a checagem certa quando o handler devolve o `inputRequired` — ele
inspeciona os `inputRequests`, vê que carregam uma elicitation em `form` mode e,
se o cliente não declarou a capability, responde ele mesmo `-32021` com
`data.requiredCapabilities` e HTTP 400. O comentário em
`servidor-mcp/src/ferramentas.js` registra isso.

### Determinismo

Não há LLM em nenhum ponto do caminho de execução, e não há dependência de
provedor de modelo em nenhum `package.json`. O agente interpreta o pedido em
formato fixo (`agente/src/pedido.js`) e decide por regra. O mesmo pedido produz
sempre o mesmo resultado.

---

## Saída do validador

Execução com os dois processos recém-iniciados, terminando com código de saída
**0**:

```
trace-id desta execucao: 757e344ee4b514ef878d90342d4e03b9
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```

### Evidências no stderr do servidor MCP

Com a execução acima, o stderr do servidor MCP mostra, em ordem:

```
[mcp] method=tools/list id="ccc83b5a50ef" traceparent=-
[mcp] method=tools/call id="97c305aee411" traceparent=-
...
[mcp] method=tools/call id="5f13f6ad3ea9" traceparent=00-757e344ee4b514ef878d90342d4e03b9-e4074b14e1bc870f-01
...
[mcp] method=tools/call id=2 traceparent=00-757e344ee4b514ef878d90342d4e03b9-e4074b14e1bc870f-01
[mcp] method=tools/call id=3 traceparent=00-757e344ee4b514ef878d90342d4e03b9-e4074b14e1bc870f-01
```

Três coisas para conferir aí:

1. O `tools/list` acontece **antes** do primeiro `tools/call` — é a descoberta em
   runtime, não uma lista fixa no código.
2. O `trace-id` do validador (`757e344ee4b514ef878d90342d4e03b9`) aparece nos
   requests que o **agente** emitiu, provando que o `traceparent` do header A2A
   foi propagado até o servidor MCP dentro do `_meta`.
3. Os dois últimos são o request inicial e o retry de uma reserva que passou pela
   pausa: ids `2` e `3`, **diferentes**, como a spec exige.

---

## Estrutura

```
.
├── README.md
├── dados/                       (do starter, não alterado)
├── validador/                   (do starter, não alterado)
├── exemplos/                    (do starter, não alterado)
├── servidor-mcp/
│   ├── package.json
│   └── src/
│       ├── index.js             HTTP :7301, createMcpHandler, log no stderr
│       ├── dominio.js           salas, reservas, política, conflito, alternativas
│       ├── ferramentas.js       as três tools, o resource e o ciclo de MRTR
│       └── estado.js            codec HMAC do requestState
└── agente/
    ├── package.json
    └── src/
        ├── index.js             HTTP :7300, Agent Card e JSON-RPC
        ├── a2a.js               Tasks, máquina de estados e a ponte
        ├── mcp-host.js          o agente como cliente MCP
        └── pedido.js            parser do formato fixo
```
