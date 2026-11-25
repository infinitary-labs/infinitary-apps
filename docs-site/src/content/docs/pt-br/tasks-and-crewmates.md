---
source: d1435fbb25dfd2af
title: Tarefas e tripulantes
description: O que é uma tarefa, como ela vai do backlog até concluída, onde acompanhá-la e como orientar o tripulante que a faz.
---

Uma tarefa é um trabalho que seu imediato está acompanhando, com uma chave como `WEB-12`.
Um tripulante é o ajudante de IA que faz o trabalho de uma tarefa, na própria cópia de trabalho do seu projeto.
Toda tarefa guarda um registro do que você pediu, do que mudou, das evidências e do que você decidiu.

## Onde a tarefa está {#where-a-task-stands}

Tarefas, à direita da janela, lista suas tarefas conforme onde cada uma está:

- **Aguardando você**: um cartão da tarefa precisa da sua decisão.
- **Trabalhando**: um tripulante está nela agora.
- **Na fila**: ela começa sozinha assim que aquilo que ela aguarda estiver concluído, como outra tarefa.
- **Backlog**: ela espera você iniciá-la.
  Pressione **Iniciar** na linha dela quando quiser que ela comece.
- **Concluídas · 7 d**: terminadas nesta semana.

Uma linha pode trazer uma palavra depois do título, como “bloqueada”, “retida”, “verificações” ou “não iniciou”.
Uma tarefa que não iniciou oferece **Tentar de novo**.

Clique em uma linha para abrir a tarefa.
Se um cartão dela estiver esperando por você, esse cartão aparece primeiro.

### A marca ao lado de cada tarefa {#the-mark-beside-each-task}

Cada linha em Tarefas começa com uma pequena marca.
O formato dela diz onde a tarefa está, e a cor reforça isso.

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **Backlog**: ela espera você pressionar **Iniciar**.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **Na fila**: ela começa sozinha quando puder.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **Iniciando**: o Infinitary está preparando o tripulante dela.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Trabalhando**: um tripulante está trabalhando nela agora.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Trabalhando, em trabalho em segundo plano**: algo que o tripulante dela começou, como uma compilação ou uma rodada de testes demorada, ainda está em execução.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Trabalhando, aguardando as verificações**: o tripulante dela espera as verificações da mudança terminarem.
  A linha acrescenta “verificações”.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Trabalhando, aguardando o lote**: a mudança aprovada dela espera as verificações do lote em que entrou.
  A linha acrescenta “lote”.
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Ociosa**: ela começou, mas o tripulante dela não está trabalhando agora, e o trabalho dela fica guardado.
  Quando ela aguarda outra tarefa, a linha acrescenta “aguardando”.
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Interrompida**: a vez do tripulante dela parou antes de terminar.
  Diga a ele o que fazer em seguida.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Aguardando você**: um cartão da tarefa precisa da sua decisão.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **Concluída**: ela está terminada.
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **Abandonada**: ela foi abandonada.
  O trabalho abandonado aparece no quadro de tarefas, não em Tarefas.

Quando o computador em que uma tarefa roda está fora de alcance, a marca dela mantém o formato e fica laranja, e a linha termina com “fora de alcance” ([Seus outros computadores](/pt-br/your-other-computers/#a-computer-that-runs-work)).
Por exemplo, uma tarefa do Backlog nesse computador mostra <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>.

Uma tarefa dividida em partes lista as partes embaixo dela.
Assim que uma das partes começa, a tarefa passa a aparecer em Trabalhando, com as partes abertas embaixo dela.
A tarefa mantém a própria marca ali, então uma tarefa cujas partes fazem o trabalho pode mostrar a marca de Backlog ou de Na fila em Trabalhando.

Para ler em palavras o status de uma tarefa e o motivo dele, deixe o ponteiro sobre a linha dela ou vá até a linha com o teclado.

## O quadro de tarefas {#the-task-board}

Para uma visão mais completa, pressione **Abrir o quadro de tarefas** no topo de Tarefas.
O quadro mostra Aguardando você no alto e depois três colunas: Backlog, Na fila e Trabalhando.

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="O quadro de tarefas: uma fileira com as etiquetas do projeto, uma tarefa aguardando você no alto e depois as colunas Backlog, Na fila e Trabalhando." width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="O quadro de tarefas: uma fileira com as etiquetas do projeto, uma tarefa aguardando você no alto e depois as colunas Backlog, Na fila e Trabalhando." width="876" height="493" />

As visualizações dele também listam o backlog inteiro, Concluídas · 7 d e o trabalho abandonado nesta semana.
Digite uma chave ou um título em **Buscar uma tarefa** para filtrar todas as faixas, inclusive trabalhos concluídos mais antigos.
Quando seu projeto tem etiquetas, o quadro mostra uma fileira com elas, e pressionar uma delas deixa no quadro só as tarefas que a levam; veja [Etiquetas](#tags).

Para mover uma tarefa, arraste o bloco dela para outra coluna ou use o menu ⋯ dela:

- Para **Na fila**, ela começa sozinha quando puder.
- Para **Trabalhando**, ela começa agora.
- De volta para **Backlog**, ela espera de novo a sua palavra.
  Uma tarefa que já começou mantém o trabalho dela.
- Para a bandeja **Abandonar tarefa**, ela é abandonada.

Um movimento que iniciaria ou abandonaria um trabalho pergunta uma vez antes.
O quadro nunca mescla nada: uma mesclagem só acontece no cartão de mesclagem da tarefa.

## O cartão da tarefa {#a-tasks-card}

Abra uma tarefa para ver o cartão dela.
Embaixo do título fica uma fileira de abas:

- **Info**: o que você pediu, onde ela está, as etiquetas dela e como ela é entregue.
- **Cartões**: os cartões que a tarefa mostrou a você, com a quantidade.
- **Atividade**: cada linha que a tarefa escreveu, em ordem.
- **Tripulante**: a conversa do próprio tripulante, linha por linha, enquanto ele trabalha.
- **Navegador**: uma página que o tripulante abriu no próprio navegador, quando ele tem uma.
  Veja [O navegador da tripulação](/pt-br/the-crews-browser/).

Uma aba só aparece quando a tarefa tem algo para mostrar nela.

## Etiquetas {#tags}

Uma tarefa pode levar qualquer uma das etiquetas do projeto dela, como bug ou recurso.
Você cria as etiquetas de um projeto em Ajustes → Projetos; veja [Projetos](/pt-br/projects/#tags).

Para etiquetar uma tarefa, abra a aba **Info** dela e pressione **Editar etiquetas** na linha **Etiquetas**.
Um menu lista as etiquetas do projeto, e cada etiqueta que você marca é salva na hora.
A linha **Etiquetas** aparece quando o projeto tem etiquetas.
Você também pode pedir ao seu imediato para etiquetar uma tarefa.

Você pode encontrar tarefas por etiqueta em três lugares:

- **Buscar tarefas**, no topo de Tarefas, mostra uma fileira com as etiquetas do projeto.
  Pressione uma etiqueta para listar só as tarefas que a levam, **Sem etiqueta** para as tarefas que não levam nenhuma ou **Todas as etiquetas** para ver todas as tarefas de novo.
- **Agrupar tarefas**, logo ao lado, lista suas tarefas **Por etiqueta** em vez de **Por status**.
  Cada etiqueta é um grupo, que fica recolhido até você abri-lo.
- O quadro de tarefas tem a própria fileira de etiquetas, e a visualização **Por etiqueta** dele conta as tarefas de cada etiqueta conforme onde cada uma está.

As etiquetas aparecem para um projeto de cada vez: o projeto em foco ou seu único projeto com etiquetas.
Para focar em um projeto, veja [Projetos](/pt-br/projects/#focus-on-one-project).

## Orientar um tripulante {#steering-a-crewmate}

Você pode dizer algo a um tripulante de três jeitos:

1. Digite embaixo de um dos cartões dele e pressione **Chat**.
2. Digite na caixa no pé da aba **Tripulante** dele.
   Um tripulante trabalhando recebe suas palavras enquanto trabalha; um ocioso recomeça a partir delas.
3. Diga ao seu imediato, na caixa de mensagem.

Para parar a vez de um tripulante, pressione **Parar** na aba Tripulante dele.
A tarefa continua aberta, e você pode dizer a ele o que fazer em seguida.

## Cuidado {#rigor}

O cuidado é o quanto o trabalho é verificado antes de chegar até você.
Ele tem três níveis:

- **Rápido**: as verificações passam, e pouco mais.
- **Padrão**: o tripulante mostra a mudança funcionando, com imagens, e roda os testes que importam.
- **Cuidadoso**: o Padrão e, depois, uma revisão independente e a prova de que a mudança funciona, antes do cartão de mesclagem.

Cada projeto tem o próprio Cuidado, em Ajustes → Projetos.
Para uma tarefa só, diga quanto cuidado ter quando pedir, como “tenha cuidado com esta”.
Em um cartão de mesclagem, **Revisar com cuidado** eleva essa tarefa para Cuidadoso.

## Perguntar antes de mesclar {#asking-before-merging}

Cada projeto pergunta antes de mesclar ou mescla por conta própria.
O interruptor **Perguntar antes de mesclar** em Ajustes → Projetos define isso.
Quando ele está ligado, o trabalho terminado espera o seu cartão de mesclagem.
Quando está desligado, o trabalho que passa nas verificações pode ser mesclado sem perguntar a você, e você recebe depois um cartão com a história dele.
Para mudar isso em uma tarefa só, diga ao seu imediato.

## Fechar uma tarefa {#closing-a-task}

A maioria das tarefas se fecha sozinha:

- Mesclar a mudança dela fecha a tarefa.
- **Descartar** no cartão de mesclagem dela abandona o trabalho.
- **Concluído** em uma nota que responde à sua pergunta fecha a tarefa como respondida.

Você também pode fechar uma pelo cartão dela:

- **Abandonar tarefa** a encerra.
  Um tripulante que esteja trabalhando para, e o trabalho inacabado dele fica guardado.
- **Fechar como concluída**, em uma tarefa que já começou, diz que o trabalho está concluído.

Uma tarefa fechada mantém o registro dela.
O trabalho abandonado fica no quadro por uma semana, só para leitura.
