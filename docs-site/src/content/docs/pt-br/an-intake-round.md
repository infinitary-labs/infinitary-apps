---
source: f2e3bc29a54d982b
title: Uma rodada de recepção
description: Faça sua tripulação ler as novas issues e solicitações de pull de um projeto em um horário, rascunhar as respostas e publicar as simples sob uma diretriz nas suas próprias palavras.
---

Uma rodada de recepção é uma tarefa que lê o que outras pessoas escreveram no seu projeto, como novas issues e solicitações de pull, e rascunha o que fazer com cada uma.
Você a monta com peças que o Infinitary já tem: uma automação, um tripulante que só lê e uma diretriz nas suas próprias palavras.
Ela funciona com qualquer projeto que o Infinitary alcança onde ele fica, no GitHub, GitLab ou Bitbucket.

## Iniciar uma rodada em um horário {#start-a-round-on-a-schedule}

1. Abra **Ajustes**, depois **Automação**, e escolha **Nova automação**.
2. Em **Quando**, escolha com que frequência ela roda.
3. Em **Projeto**, escolha o projeto de que ela trata.
4. Em **Diga ao seu imediato**, escreva o seu método: o que ler, como julgar cada item e como é uma resposta simples.
5. Escolha **Ativar…** para verificá-la e ligá-la.

Por exemplo: “Leia, com um tripulante que só lê, as issues e solicitações de pull abertas ou respondidas desde a última rodada. Rascunhe uma resposta para cada uma e inicie uma tarefa que publique cada resposta simples.”

## O tripulante que lê {#the-crewmate-that-reads}

Os textos de issues e solicitações de pull podem vir de qualquer pessoa, por isso a rodada os lê como um tripulante que só lê.
Ele trata tudo o que lê como informação, nunca como instrução.
Tudo o que ele quiser enviar espera por você em um único cartão de aprovação, diga o que disser uma diretriz.
Veja [Um tripulante que lê textos que qualquer pessoa pode escrever](/pt-br/integrations/#a-crewmate-that-reads-words-anyone-can-write).

## Deixar as respostas simples saírem sem o seu clique {#let-plain-replies-go-without-your-click}

Uma resposta pode sair sem cartão quando você disse, nas suas próprias palavras, que ela pode.

1. Diga ao seu imediato uma diretriz para o projeto que diga quais respostas podem sair sem perguntar.
   Por exemplo: “As tarefas de envio da rodada de recepção podem publicar respostas que sigam claramente o nosso método de recepção, e nada mais; tudo o que for estranho ou ambíguo espera o meu clique.”
2. No seu método, peça ao seu imediato que inicie uma tarefa própria para cada resposta rascunhada, que a publique e não leia nenhum texto dos desconhecidos.
3. Quando uma resposta é claramente uma que a sua diretriz cobre, o tripulante dessa tarefa a publica uma vez, sem cartão, citando a sua diretriz.
   Uma resposta que ele ache estranha, ou que a sua diretriz não cubra, espera o seu clique em um cartão.

O Infinitary só verifica se a sua diretriz ainda vale: as palavras atuais dela foram ouvidas de você, e ela não foi desativada.
Se uma resposta é uma que as suas palavras permitem, quem julga é o seu tripulante.
Um sim que você já deu em um cartão para o mesmo trabalho deixa uma resposta sair do mesmo jeito.
Veja [Quem segue uma diretriz](/pt-br/knowledge/#who-follows-a-direction).

## O que ainda espera por você {#what-still-waits-for-you}

- Tudo o que o tripulante que lê enviar por conta própria, diga o que disser uma diretriz.
- Uma mudança por uma integração, que mantém a regra dela em **Ajustes** → **Integrações**.
- Uma mudança em outro projeto.
  Uma tarefa sem projeto no GitHub, no GitLab ou no Bitbucket trabalha pelo seu login do GitHub, e aí um sim seu pode deixar uma mudança sair para qualquer repositório.
- Uma mesclagem, que só acontece pelo cartão de mesclagem dela.

## Ver o que saiu {#see-what-went-out}

Cada resposta publicada sem cartão acrescenta uma linha à **Atividade** da tarefa dela, citando as suas palavras em que ela se apoiou.
Uma resposta cujo resultado é desconhecido nunca é enviada de novo; leia o item onde o seu projeto fica para ver se ela chegou.

## Parar {#stop-it}

Para que as respostas parem de sair sozinhas, diga ao seu imediato que desative ou mude a diretriz.
A partir daí, cada resposta volta a esperar o seu clique.
Para parar a própria rodada, escolha **Pausar** na automação dela, em **Ajustes** → **Automação**.

## Próximos passos {#next}

- [Automação](/pt-br/automation/)
- [Conhecimento](/pt-br/knowledge/)
- [Integrações](/pt-br/integrations/)
