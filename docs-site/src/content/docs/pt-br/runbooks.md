---
source: 6d79068a24795b48
title: Manuais
description: As orientações escritas que seu imediato e sua tripulação seguem em cada tipo de trabalho, e como ativá-las ou desativá-las, lê-las e criar ou adicionar as suas.
---

Um manual é uma orientação escrita que seu imediato e sua tripulação seguem em um tipo de trabalho, como planejar uma mudança, dar uma aula ou nomear commits.
Ele contém palavras, exemplos e imagens, e não executa nada no seu computador.
O Infinitary vem com manuais próprios, e você pode criar ou adicionar outros.

<img class="picture-dark" src="/pictures/runbooks-dark.webp" alt="Ajustes, seção Manuais: a lista Incluídos com Common workflows, Delivery judgment, Testing rules, Rigor levels, Commit and PR naming, Programs e Casual projects, cada um com uma descrição curta, um botão Ver e um interruptor ligado." width="1168" height="618" />
<img class="picture-light" src="/pictures/runbooks-light.webp" alt="Ajustes, seção Manuais: a lista Incluídos com Common workflows, Delivery judgment, Testing rules, Rigor levels, Commit and PR naming, Programs e Casual projects, cada um com uma descrição curta, um botão Ver e um interruptor ligado." width="1168" height="618" />

## Onde ficam os manuais {#where-runbooks-live}

Abra **Ajustes** e depois **Manuais**.
Você também pode procurar **Abrir Manuais** na busca de comandos.

A seção tem três grupos:

- **Incluídos** lista os manuais que vêm com o Infinitary.
- **Seus** lista os manuais que você adicionou ou criou com seu imediato.
- **Crie os seus** tem **Sua pasta de manuais** e exemplos do que pedir.

Cada linha mostra o nome de um manual, para que ele serve e o interruptor dele.

## Ativar ou desativar um manual {#turn-a-runbook-on-or-off}

Use o interruptor de um manual para ativá-lo ou desativá-lo.
Você também pode pedir ao seu imediato, como “desative Lessons”.

Seu imediato passa a seguir a mudança assim que termina o que está fazendo, e o mesmo vale para cada tripulante que começar depois.
Um tripulante que já está trabalhando mantém a orientação com que começou.

Um manual desativado não orienta ninguém, mas continua na lista, então você pode ativá-lo de novo.

## Os manuais incluídos {#the-built-in-runbooks}

A maioria dos manuais incluídos começa ativada.
Três começam desativados até você ativá-los: **Batched pull requests**, **Pull request comments** e **Advanced architecture**.

- **Common workflows**: como seu imediato encara o planejamento, a construção, as correções e a pesquisa.
- **Delivery judgment**: como os tripulantes avaliam as verificações, os reparos e quando uma mudança está pronta para ser mesclada, no trabalho que passa por uma solicitação de pull.
- **Testing rules**: o que testar quando um tripulante planeja ou muda um projeto.
- **Rigor levels**: o que cada nível pede de uma mudança: **Rápido**, **Padrão** e **Cuidadoso**.
  Veja [Cuidado](/pt-br/tasks-and-crewmates/#rigor).
- **Commit and PR naming**: como commits, solicitações de pull e branches de trabalho são nomeados.
  Com ele desativado, e sem nenhum manual seu que os nomeie, o Infinitary não verifica nenhum nome.
- **Programs**: em trabalhos que um script consegue dividir, um tripulante escreve um script curto que registra cada parte como uma tarefa própria.
- **Casual projects**: como seu imediato monta projetos pequenos por diversão ou para uso pessoal.
  Veja [O que você pode pedir](/pt-br/what-you-can-ask-for/#a-small-project-for-fun).
- **Lessons**: orientações e partes de cartão para aprender um assunto ao longo de vários dias.
  Veja [O que você pode pedir](/pt-br/what-you-can-ask-for/#a-subject-learned-across-days).
- **Batched pull requests**: mescla suas mudanças aprovadas juntas, como uma única solicitação de pull em lote, para que as verificações delas rodem uma vez só.
  Ative-o para poder escolher solicitações de pull em lote para um projeto em Ajustes → **Projetos**.
  Veja [Projetos](/pt-br/projects/#how-changes-reach-your-project).
- **Pull request comments**: um tripulante responde aos comentários na solicitação de pull dele até ela ser mesclada.
  Ele faz sozinho as correções claras e traz as que não estão claras para você, como uma escolha.
- **Computer cleanup**: uma análise que só lê, depois que você concorda, e um cartão para escolher quais sobras parar.
  Veja [O que você pode pedir](/pt-br/what-you-can-ask-for/#a-look-at-a-computer-under-strain).
- **Moving secrets in**: como um tripulante traz segredos de outra ferramenta para **Segredos** sem que nenhum agente veja um valor.
  Um tripulante só o lê durante uma transferência desse tipo.
  Veja [Segredos](/pt-br/secrets/).
- **Feedback**: digite `/feedback` e algumas palavras em qualquer caixa de mensagem, e um tripulante redige uma issue para o criador do Infinitary que você lê e publica.
  Ela leva fatos sobre o app e o seu sistema, nunca seus nomes, caminhos ou projetos.
- **Advanced architecture**: mapeia as partes de um projeto e como elas se conectam, e mostra o que uma mudança mexe nesse mapa.
  É um experimento.

O Infinitary não deixa você desativar **Batched pull requests** enquanto um projeto usa solicitações de pull em lote, e diz qual é esse projeto.

## Ler um manual {#read-a-runbook}

Pressione **Ver** ao lado de um manual incluído.
Isso abre uma cópia somente leitura da pasta do manual no seu computador.
Para mudar como um manual incluído funciona, peça ao seu imediato para torná-lo seu, como explicado abaixo.

## Crie os seus {#make-your-own}

Peça ao seu imediato, com as suas palavras.
**Crie os seus**, em Ajustes, dá exemplos, como:

- “Dê a cada tripulante uma habilidade para escrever notas de versão em palavras simples.”
- “Crie um manual que diga ao imediato que eu prefiro respostas curtas.”

Um tripulante escreve o novo manual em **Sua pasta de manuais**.
Ele aparece em **Seus** e já fica ativado, a não ser que você tenha pedido para ele começar desativado.

**Abrir pasta** abre **Sua pasta de manuais** no seu computador.
Uma mudança em um manual ali chega ao seu imediato e à sua tripulação do mesmo jeito que um interruptor.

## Tornar seu um manual incluído {#make-a-built-in-runbook-yours}

Peça ao seu imediato para copiar um manual incluído, como “Copie Common workflows e faça com que ele sempre planeje antes de construir.”

1. Seu imediato copia o manual inteiro para **Sua pasta de manuais**, com um nome novo.
2. A cópia aparece em **Seus** e começa desativada, então nada muda ainda.
3. Mude a cópia você mesmo, ou peça ao seu imediato para mudá-la.
4. Ative a cópia.
   O manual incluído é desativado ao mesmo tempo.

O manual incluído continua como estava.
Para voltar atrás, desative sua cópia e ative o incluído.

## Adicionar um manual que alguém compartilhou {#add-a-runbook-someone-shared}

Peça ao seu imediato para adicionar um manual de um endereço da web ou de uma pasta, como “Adicione o manual do endereço da web ou da pasta que alguém compartilhou.”

Nada é adicionado até você responder ao cartão dele, que tem o nome do manual como título, como “Adicionar Release notes?”.
O cartão diz de onde o manual vem, quem o criou, o que ele alcança e qualquer manual incluído que ele desativa.

- **Adicionar** adiciona o manual e o ativa.
- **Não adicionar** recusa e apaga o que foi baixado.

Um cartão que você deixa de lado mantém a oferta esperando.
Uma atualização de um manual adicionado pergunta de novo a você no mesmo tipo de cartão.

Para remover um manual adicionado, peça ao seu imediato para removê-lo pelo nome.
Um manual incluído que ele desativou continua desativado até você ativá-lo de novo.

Um manual em **Seus** que o Infinitary não consegue ler mostra o motivo, sem interruptor, e não orienta ninguém até ser corrigido.

## De outro computador {#from-another-computer}

Em um computador que controla seu imediato de outro lugar, os interruptores mudam os manuais onde seu imediato vive.
**Ver** e **Abrir pasta** só funcionam naquele computador, e a linha da pasta diz qual é ele.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

## Usar o teclado {#use-the-keyboard}

Tab chega a cada botão **Ver** e a cada interruptor.
A busca de comandos tem **Abrir Manuais** e **Abrir a sua pasta de manuais**, e você pode dar uma tecla a qualquer um deles em Ajustes → **Teclado**.
Veja [Teclado](/pt-br/keyboard/).
