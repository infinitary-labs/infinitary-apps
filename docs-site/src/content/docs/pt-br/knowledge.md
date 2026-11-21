---
source: 43a70acb2cfae9b1
title: Conhecimento
description: As diretrizes permanentes que seu imediato guarda, o que você conta a ele sobre você e as fontes que você pede para sua tripulação salvar, e como lê-las, mudá-las ou apagá-las.
---

Conhecimento é o que seu imediato e sua tripulação guardam para que trabalhos futuros possam usar.
Ele guarda três tipos de coisa:

- Diretrizes permanentes: como você quer que seu trabalho seja feito daqui em diante, por exemplo quem mescla ou quais modelos um projeto usa.
- Contexto pessoal: o que você conta ao seu imediato sobre você.
- Fontes salvas: artigos e páginas que você pediu para sua tripulação guardar, com o que eles dizem.

<img class="picture-dark" src="/pictures/knowledge-dark.webp" alt="O cartão de Conhecimento na aba Diretrizes: três diretrizes com as suas próprias palavras, uma para todo lugar e uma para cada um dos projetos harbor e website, com a diretriz de lançamento do Harbor aberta ao lado da lista, mostrando a versão dela, a marca Instrução, o projeto a que se aplica e de onde veio." width="896" height="504" />
<img class="picture-light" src="/pictures/knowledge-light.webp" alt="O cartão de Conhecimento na aba Diretrizes: três diretrizes com as suas próprias palavras, uma para todo lugar e uma para cada um dos projetos harbor e website, com a diretriz de lançamento do Harbor aberta ao lado da lista, mostrando a versão dela, a marca Instrução, o projeto a que se aplica e de onde veio." width="896" height="504" />

## Dar uma diretriz permanente {#give-a-standing-direction}

Diga ao seu imediato, com as suas palavras, como você quer que algo seja feito daqui em diante.
Por exemplo, “daqui em diante, me pergunte antes de mesclar qualquer coisa em website” ou “use o Claude em todas as tarefas do projeto docs”.
Seu imediato decide quando suas palavras são para durar e as guarda como uma diretriz.
Ele também pode guardar uma a partir de uma escolha que você faz em um cartão, quando essa escolha deve valer para trabalhos futuros.

Uma diretriz vale para todo lugar ou para um projeto.

Uma regra sobre como o código do próprio projeto é escrito, testado ou enviado em commit não é guardada como diretriz.
Seu imediato pede a um tripulante que a escreva nos documentos do próprio projeto, para que ela fique junto do código.

## Quem segue uma diretriz {#who-follows-a-direction}

- Seu imediato lê todas as diretrizes ativas, toda vez que trabalha.
- Um tripulante lê as diretrizes do projeto da tarefa dele, e nenhuma outra.
- Uma diretriz para todo lugar fica com seu imediato, e nenhum tripulante a lê.
  O Conhecimento as chama de **Em todo lugar, só o imediato**.

Uma diretriz com as suas próprias palavras é marcada como **Instrução**, e sua tripulação a segue como uma instrução sua.
Uma guardada a partir de qualquer outra origem é marcada como **Conselho**, que sua tripulação leva em conta.
Nenhuma diretriz permite mais do que as próprias palavras dizem.

## Ver, mudar ou desativar uma diretriz {#see-change-or-retire-a-direction}

O painel **Conhecimento** fica embaixo de **Tarefas**, no lado direito da janela, assim que houver algo no Conhecimento.
Ele lista até quatro das suas diretrizes, das mais novas para as mais antigas, com o nome do projeto ao lado de cada uma que é para um projeto só.
Clique em uma diretriz para lê-la, ou no link que as conta, como **Todas as diretrizes (6)**, para ver todas.

Para mudar ou desativar uma diretriz, diga ao seu imediato, como “pare de me perguntar antes de mesclar em website”.
O Conhecimento não tem nenhum botão que mude uma diretriz por si só.
Quando seu imediato descobre que uma diretriz talvez não valha mais, ele pode oferecer desativá-la em um cartão, e você escolhe.

Uma diretriz desativada deixa de orientar seu imediato e sua tripulação.
As palavras anteriores dela ficam no histórico.

## Contar ao seu imediato sobre você {#tell-your-first-mate-about-yourself}

Conte ao seu imediato algo sobre você que trabalhos futuros devam saber, como “sou iniciante em programação” ou “moro em Lisboa”.
Ele guarda suas palavras como contexto pessoal.
Um tripulante também guarda contexto pessoal, mas só a partir das suas próprias palavras, nunca de um palpite.

Seu imediato e sua tripulação não leem tudo o que você salvou toda vez.
Eles consultam o contexto pessoal e as fontes salvas quando o trabalho pode depender da sua situação ou de algo que você salvou.
Com as diretrizes é diferente: elas são lidas toda vez.

## Salvar uma fonte {#save-a-source}

Peça ao seu imediato para salvar uma página que você quer guardar, como “salve este artigo para depois”, com o link dela.
Um tripulante lê a página e guarda o link, o título, o autor e a data de publicação quando a página os informa, e um trecho curto.
Ele também registra as ideias que a página cita e o que ela diz sobre elas, cada uma ligada a essa fonte.
A página em si não é copiada.

Perguntar o que uma página diz não salva nada; só pedir para salvá-la salva.
Salvar uma fonte não quer dizer que você concorda com ela.

## Conceitos e constatações {#concepts-and-findings}

O conhecimento salvo é feito de dois tipos de registro:

- Um conceito nomeia uma ideia, com os outros nomes que as pessoas usam para ela.
- Uma constatação diz algo sobre um ou mais conceitos, com as fontes que a sustentam.
  Ela é marcada como **Observada** quando alguém a viu, ou **Deduzida** quando alguém chegou a ela raciocinando.

Uma constatação é uma evidência a ser pesada, nunca uma instrução ou uma permissão.
Sua tripulação lê uma constatação e as fontes dela antes de confiar nela.

Cada constatação mostra a situação dela:

- **Ainda não verificada**: ninguém a verificou.
- **Verificada**: uma verificação que cita evidências a sustenta.
- **Evidências divergentes**: uma verificação ou outra constatação a contradiz.
- **Precisa ser verificada de novo**: uma fonte que ela cita mudou, ou sumiu, desde que ela foi guardada.
- **Substituída**: uma constatação mais nova toma o lugar dela.
- **Desativada**: ela não conta mais.

Uma fonte que mudou não torna uma constatação errada; ela só faz valer a pena verificá-la de novo.

## Abrir o Conhecimento {#open-knowledge}

Pressione **Abrir Conhecimento** no topo do painel **Conhecimento**, ou procure **Abrir Conhecimento** na busca de comandos.
O Conhecimento se abre no próprio cartão, com quatro abas:

- **Diretrizes**: todas as diretrizes.
  **Projeto** filtra a lista para um projeto, ou para **Em todo lugar, só o imediato**.
  **Todos os projetos** mostra todas de novo.
- **Grafo**: seus conceitos, desenhados em três dimensões.
  Uma seta contínua é uma afirmação que uma constatação faz de uma ideia para outra, e uma linha tracejada liga duas ideias que vale a pena ler juntas.
  Arraste para girá-lo, ou use as setas do teclado para escolher um conceito e Enter para lê-lo.
- **Conceitos**: todos os conceitos por nome, com quantas constatações cada um tem.
- **Constatações**: todas as constatações, das mais novas para as mais antigas.
  **Mostrar** filtra a lista para **Precisa ser verificada de novo** ou **Evidências divergentes**.

**Buscar** procura na aba em que você está.
Escolha qualquer item para lê-lo ao lado da lista, em **Visão geral**, **Evidências**, **Histórico** e **Usado em**.
Uma diretriz mostra **Visão geral** e **Histórico**, que guarda cada versão anterior das palavras dela.

**Perguntar sobre isto**, embaixo de cada seção, começa sua próxima mensagem ao seu imediato com uma pergunta sobre o que você está lendo.
Nada é enviado até você enviar.
Ler o Conhecimento não muda nada nele.

Quando uma resposta em um cartão se apoia em uma constatação, ela pode citar essa constatação, e o nome a abre no Conhecimento.
O cartão de uma tarefa lista o conhecimento em que o trabalho dela se apoiou em **Conhecimento usado**.

## Onde ele fica guardado {#where-it-is-kept}

O Conhecimento fica guardado no computador em que seu imediato vive.
Seus outros computadores mostram o Conhecimento desse computador, e um tripulante trabalhando em outro computador o lê de lá sem guardar uma cópia.
Quando seu imediato ou um tripulante lê algo no Conhecimento, isso vai para o seu provedor de IA com o resto daquela conversa, como qualquer outra coisa que eles leem.
Veja [O que sai do seu computador](/pt-br/what-leaves-your-computer/).

Fechar uma tarefa mantém tudo o que ela registrou.
Para remover tudo do Conhecimento, inclusive as diretrizes, use **Excluir dados das tarefas** em [Ajustes → Geral](/pt-br/settings/#general).
Isso também remove todas as tarefas.
