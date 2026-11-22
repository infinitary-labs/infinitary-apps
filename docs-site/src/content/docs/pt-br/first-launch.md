---
source: 714fca51d75af858
title: Primeira abertura
description: O que o Infinitary mostra na primeira vez que você o abre, como conectar uma assinatura e como adicionar seu primeiro projeto.
---

Antes de começar, confira [do que você precisa](/pt-br/install/).
Esta página mostra a primeira vez que você abre o Infinitary e o que muda depois disso.

## O que a janela mostra {#what-the-window-shows}

Na primeira vez que você abre o Infinitary, seu imediato recebe você no meio da janela.
Acima dele aparece **Bem-vindo a bordo do Infinitary, capitão**, com uma fala do seu imediato:

> Sou seu imediato.
> Vou ajudar você a comandar o resto da tripulação.
> Configure-me em um computador que fique ligado o máximo possível.
> Seus outros dispositivos precisam de mim acordado.

Abaixo disso há um botão para cada provedor que seu imediato pode usar: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock e API personalizada.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="A primeira abertura: o imediato no meio da janela, as palavras de boas-vindas e um botão para cada provedor." width="1280" height="652" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="A primeira abertura: o imediato no meio da janela, as palavras de boas-vindas e um botão para cada provedor." width="1280" height="652" />

A caixa de mensagem na parte de baixo fica esmaecida e diz “Conecte uma assinatura primeiro”.
Nada mais funciona até que uma assinatura consiga responder ao seu imediato.

## Conectar uma assinatura {#connect-a-subscription}

1. Escolha o botão do seu provedor.
2. Faça login do jeito que esse provedor pedir.
   Alguns abrem a página de login no seu navegador.
   O Copilot e o Kimi Code mostram um código: pressione **Copiar código** e depois digite-o no site do provedor.
   O OpenRouter pede uma chave de API que você cola.
   Com o Amazon Bedrock, escolha uma região e use um perfil da AWS neste computador ou cole uma chave de API do Bedrock.
   Um provedor que oferece as duas opções pergunta se você quer **Fazer login pelo navegador** ou colar uma **Chave de API**.
3. Aguarde enquanto a janela diz que está conectando.
   Quando a assinatura consegue responder, a tela de boas-vindas desaparece e a caixa de mensagem se abre.

Se você usa o Claude, o Infinitary usa o Claude Code que você instalou neste computador.
Sem ele, o botão do Claude diz para instalar o Claude Code primeiro.

Se uma assinatura estiver conectada mas ainda não conseguir responder, a janela mostra **Configure seu imediato neste computador** e diz o que ainda falta.

## Se seu imediato já mora em outro computador {#if-your-first-mate-already-lives-on-another-computer}

Abaixo dos botões dos provedores, um segundo grupo diz “Seu imediato está em outro computador”.
Em um Mac ou em um computador Linux x64, **Configurar pelo computador do seu imediato** vem primeiro: ele mostra o endereço deste computador para digitar no computador onde seu imediato mora.
Assim que aquele computador adicionar este, esta janela abre seu imediato sozinha, desde que nada tenha sido configurado nela ainda, como um login ou um projeto.
Uma janela em que você já configurou algo mantém o próprio imediato: use **Colar o link dele** ou **Entrar pelo endereço** para controlar esse imediato daqui.
Se o Infinitary estava fechado quando aquele computador adicionou este, ele abre seu imediato na próxima vez que iniciar, seja o que for que tenha sido configurado nele.
Uma janela ao lado de um Infinitary que você mesmo iniciou pelo Terminal mantém o imediato dele e não oferece nenhum dos dois jeitos; encerre esse Infinitary primeiro para usá-los.
Um PC com Windows e um computador Linux Arm mostram só os outros dois jeitos.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

## O aviso de Diagnóstico {#the-diagnostics-notice}

Um aviso abaixo da caixa de mensagem diz o que o Diagnóstico envia e que ele nunca inclui o que você digita.
Escolha **OK** para mantê-lo ligado, ou **Desativar**.
Você pode mudar isso depois em [Ajustes](/pt-br/settings/#general).
Veja [O que sai do seu computador](/pt-br/what-leaves-your-computer/).

## O cartão de boas-vindas {#the-welcome-card}

Assim que seu imediato consegue responder, aparece um cartão chamado **Como trabalhamos**.
Ele é uma pequena imagem da janela que mostra uma parte de cada vez.
Pressione **Avançar** e **Voltar** para ver a caixa de mensagem, um cartão, a Atividade à esquerda e as Tarefas à direita.

Abaixo da imagem há três pontos de partida:

- **Clonar um projeto**
- **Começar um projeto novo**
- **Trabalhar em uma pasta do meu computador**

Pressionar um deles coloca o começo de uma frase na caixa de mensagem, como “Clone o projeto em ”.
Complete a frase e envie.
O ponto de partida não envia nada sozinho.

O cartão de boas-vindas não tem campo de resposta: é na caixa de mensagem abaixo dele que você digita.
Feche-o quando quiser.

## Adicionar seu primeiro projeto {#add-your-first-project}

Seu imediato precisa de um projeto para trabalhar.
O jeito mais fácil é um ponto de partida no cartão de boas-vindas, ou as mesmas palavras na sua própria mensagem.

Quando você pede, seu imediato mostra um cartão que diz o nome do projeto e como ele será configurado.
Confira as escolhas no cartão e pressione **Adicionar projeto**, ou **Agora não** para deixar para depois.
Nada é adicionado até você pressionar **Adicionar projeto**.

Você também pode adicionar um projeto por conta própria em Ajustes → Projetos, com **Adicionar projeto**.
Veja [Projetos](/pt-br/projects/) para as escolhas que aparecem lá.

## Aberturas seguintes {#later-launches}

Quando uma assinatura consegue responder, o Infinitary abre direto na caixa de mensagem.
Seus cartões, tarefas e tripulação estão onde você os deixou.

Depois que o Infinitary se atualiza, um cartão mostra a nova versão e o que mudou.
Você pode lê-lo de novo depois em [Ajustes → Geral](/pt-br/settings/#general), em Versão.
No Mac, a opção **Novidades do Infinitary** do menu Ajuda também o abre.

Se sua última assinatura parar de funcionar, por exemplo porque você saiu da conta, a tela de boas-vindas volta até que uma consiga responder de novo.
Se a franquia do seu plano acabar, seu imediato mostra um cartão avisando isso, e guarda suas mensagens até conseguir responder.
Veja [Assinaturas e franquia](/pt-br/subscriptions-and-quota/).

Para abrir o Infinitary quando você faz login no computador, ative **Abrir ao fazer login** em Ajustes → Geral.
