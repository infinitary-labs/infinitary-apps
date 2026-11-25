---
source: c16d193883332656
title: Primeira abertura
description: O que o Infinitary mostra na primeira vez que você o abre, como escolher onde seu imediato mora, como conectar uma assinatura e como adicionar seu primeiro projeto.
---

Antes de começar, confira [do que você precisa](/pt-br/install/).
Esta página mostra a primeira vez que você abre o Infinitary e o que muda depois disso.

## O que a janela mostra {#what-the-window-shows}

Na primeira vez que você abre o Infinitary, seu imediato recebe você no meio da janela.
Abaixo dele aparece **Bem-vindo a bordo do Infinitary, capitão**, com uma fala do seu imediato:

> Sou seu imediato.
> Vou ajudar você a comandar o resto da tripulação.

Depois, seu imediato pergunta onde deve morar:

> Onde devo morar?
> Escolha um computador que fique ligado o máximo possível.

Em seguida vêm três escolhas, cada uma dizendo o que faz:

- **Este computador**: você faz login em uma assinatura aqui, e seu imediato mora e trabalha neste computador.
- **Outro computador**: seu imediato roda em outro computador, e você o controla a partir deste.
- **Um que já está rodando**: você se conecta a um imediato que já roda em outro computador e o controla daqui.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="A primeira abertura: o imediato no meio da janela, as palavras de boas-vindas, a pergunta sobre onde ele deve morar e as três escolhas Este computador, Outro computador e Um que já está rodando acima da caixa de mensagem esmaecida." width="1233" height="694" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="A primeira abertura: o imediato no meio da janela, as palavras de boas-vindas, a pergunta sobre onde ele deve morar e as três escolhas Este computador, Outro computador e Um que já está rodando acima da caixa de mensagem esmaecida." width="1233" height="694" />

Escolha uma opção para abri-la.
Pelo teclado, Tab chega a cada escolha, as setas passam de uma para outra, e Enter ou Espaço abre uma delas.
**‹ Onde eu moro**, acima de uma escolha aberta, leva você de volta às três.
Abaixo das escolhas, seu imediato diz que você pode mudá-lo para outro computador depois, em Ajustes → Dispositivos.

A caixa de mensagem na parte de baixo fica esmaecida e diz “Conecte uma assinatura primeiro”.
Nada mais funciona até que uma assinatura consiga responder ao seu imediato.

## Conectar uma assinatura {#connect-a-subscription}

Escolha **Este computador** para manter seu imediato aqui.
Aparece um botão para cada provedor que seu imediato pode usar: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock e API personalizada.

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

Se uma assinatura estiver conectada mas ainda não conseguir responder, a janela mostra **Configure seu imediato neste computador**, abre em Este computador e diz o que ainda falta.

## Configurar em outro computador {#set-it-up-on-another-computer}

Escolha **Outro computador** para que seu imediato more em um computador que fica ligado, como um desktop ou um servidor, enquanto você o controla a partir deste.
A janela mostra **Me configure em outro computador**.

1. Digite a conta e o computador do jeito que você faz login nele por SSH, como `you@mini.local`, e a porta dele, se não for a 22.
   O Login Remoto precisa estar ativado lá; no Linux, o servidor SSH dele.
   Os computadores da mesma rede aparecem em **Nesta rede**, para você escolher um.
2. Pressione **Continuar**.

Então o Infinitary configura seu imediato lá, um passo de cada vez, abaixo de “Configurando seu imediato em” seguido do nome daquele computador:

1. **Ler a chave SSH dele**: mostra a linha da chave do computador e pede que você a confirme antes de fazer login.
2. **Entrar com sua chave SSH**: se o computador não aceitar sua chave, pede uma vez a senha daquela conta.
3. **Verificar o sistema dele**.
4. **Enviar o Infinitary**.
5. **Iniciar seu imediato lá**, para que ele inicie de novo depois de cada reinicialização.
6. **Conectar daqui**.
7. **Conectar uma assinatura para ele**.

Cada passo concluído diz o que encontrou.
Se um passo parar, ele diz o que o fez parar e o que tentar, com **Pedir de novo**, **Configurar com comandos** e **Voltar**.
Se o Infinitary já roda lá, ele oferece **Conectar a ele**.
Quando um computador Linux faz você entrar como root, o Infinitary oferece uma conta comum chamada `infinitary` para o seu imediato, já que ele não roda como root.
**Cancelar** para no próximo passo; se seu imediato ainda não tiver iniciado lá, a cópia do Infinitary que foi enviada é apagada.

Assim que ele se conecta, esta janela mostra o imediato daquele computador.
Ela diz **Conecte uma assinatura para começar**: escolha um provedor e faça login daqui, como em [Conectar uma assinatura](#connect-a-subscription).

### Com comandos {#with-commands}

**Configurar com comandos** mostra a mesma configuração como comandos para rodar no outro computador:

1. Instale o Infinitary lá.
2. Inicie seu imediato lá:

   ```sh
   infinitary start-at-boot
   ```

3. Crie lá um link para este computador:

   ```sh
   infinitary link
   ```

4. Cole aqui o link que aparecer: pressione **Colar o link dele**.

Cada comando tem seu próprio **Copiar**.
Em um Mac, digite `/Applications/Infinitary.app/Contents/MacOS/Infinitary` no lugar de `infinitary`.
Veja [Um computador sem tela](/pt-br/a-computer-with-no-screen/) para um servidor que você só alcança por SSH.

## Se seu imediato já mora em outro computador {#if-your-first-mate-already-lives-on-another-computer}

Escolha **Um que já está rodando**.
Um grupo diz “Seu imediato está em outro computador” e oferece estes jeitos de entrar:

- **Configurar pelo computador do seu imediato**, em um Mac ou em um computador Linux x64, vem primeiro.
  Ele mostra o endereço deste computador para digitar no computador onde seu imediato mora.
  Assim que aquele computador adicionar este, esta janela abre seu imediato sozinha, desde que nada tenha sido configurado nela ainda, como um login ou um projeto.
- **Colar o link dele**: cole um link criado no computador onde seu imediato mora, em Ajustes → Dispositivos ou pedindo ao seu imediato, e depois pressione **Continuar**.
- **Entrar pelo endereço**: digite o endereço que você usa para fazer login naquele computador por SSH.
  Se o Infinitary não estiver aberto lá, **Configurar daqui** configura seu imediato nele, como em [Configurar em outro computador](#set-it-up-on-another-computer).

O Infinitary pergunta uma vez se você quer controlar seu imediato de lá; pressione **Controlar daqui**.

Uma janela em que você já configurou algo mantém o próprio imediato: use **Colar o link dele** ou **Entrar pelo endereço** para controlar daqui aquele imediato.
Se o Infinitary estava fechado quando aquele computador adicionou este, ele abre seu imediato na próxima vez que iniciar, seja o que for que tenha sido configurado nele.
Uma janela ao lado de um Infinitary que você mesmo iniciou pelo Terminal mantém o imediato dele e não oferece nenhum dos dois jeitos; encerre esse Infinitary primeiro para usá-los.
Um PC com Windows e um computador Linux Arm mostram só **Colar o link dele** e **Entrar pelo endereço**.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

## O aviso de Diagnóstico {#the-diagnostics-notice}

Um aviso abaixo da caixa de mensagem diz o que o Diagnóstico envia e que ele nunca inclui o que você digita.
Ele aparece com ou sem uma assinatura conectada e fica até você respondê-lo.
Escolha **OK** para mantê-lo ligado, ou **Desativar**.
Você pode mudar isso depois em [Ajustes](/pt-br/settings/#general).
Veja [O que sai do seu computador](/pt-br/what-leaves-your-computer/).

## O cartão de boas-vindas {#the-welcome-card}

Assim que seu imediato consegue responder, aparece um cartão chamado **Como trabalhamos**.

<img class="picture-dark" src="/pictures/first-launch-welcome-dark.webp" alt="O cartão Como trabalhamos: uma pequena imagem da janela com o imediato acima da caixa de mensagem, cinco pontos com Voltar e Avançar abaixo dela, os três pontos de partida e Entendi." width="930" height="523" />
<img class="picture-light" src="/pictures/first-launch-welcome-light.webp" alt="O cartão Como trabalhamos: uma pequena imagem da janela com o imediato acima da caixa de mensagem, cinco pontos com Voltar e Avançar abaixo dela, os três pontos de partida e Entendi." width="930" height="523" />

Ele é uma pequena imagem da janela que mostra uma parte de cada vez.
Pressione **Avançar** e **Voltar** para ver a caixa de mensagem, um cartão, a Atividade à esquerda, onde os tripulantes relatam, e as Tarefas à direita, onde todo pedido ganha um registro.

Abaixo da imagem, ele diz “Para começar, pressione um e complete a frase:”, com três pontos de partida:

- **Clonar um projeto** coloca “Clone o projeto em” na caixa de mensagem.
- **Começar um projeto novo** coloca “Comece um projeto novo chamado” na caixa de mensagem.
- **Trabalhar em uma pasta do meu computador** abre o seletor de pastas do seu computador.
  A pasta que você escolher vira um projeto, e uma linha abaixo do título do cartão diz o nome dela.
  Uma pasta que ainda não é um projeto git ganha o git, com um primeiro commit vazio.

Complete a frase e envie.
O ponto de partida não envia nada sozinho.
Em um computador que controla um imediato em outro computador, **Trabalhar em uma pasta do meu computador** coloca “Trabalhe na pasta” na caixa de mensagem em vez disso, já que o seletor de pastas mostraria as pastas deste computador.

O cartão de boas-vindas não tem campo de resposta: é na caixa de mensagem abaixo dele que você digita.
Pressione **Entendi** para guardá-lo quando quiser.

## Seu primeiro tripulante {#your-first-crewmate}

Na primeira vez que seu imediato passa um pedido para um tripulante, aparece um cartão chamado **Um tripulante está cuidando disso**.

<img class="picture-dark" src="/pictures/first-launch-crewmate-dark.webp" alt="O cartão Um tripulante está cuidando disso: o imediato despachando um tripulante, um painel Agora dizendo que um tripulante trabalha e que não precisa acompanhar, um painel Depois dizendo que um cartão volta aqui com uma resposta ou uma escolha, e Entendi." width="1070" height="602" />
<img class="picture-light" src="/pictures/first-launch-crewmate-light.webp" alt="O cartão Um tripulante está cuidando disso: o imediato despachando um tripulante, um painel Agora dizendo que um tripulante trabalha e que não precisa acompanhar, um painel Depois dizendo que um cartão volta aqui com uma resposta ou uma escolha, e Entendi." width="1070" height="602" />

Ele diz que o tripulante trabalha em segundo plano, o que pode levar um tempo, e que você não precisa acompanhar.
Quando o tripulante tiver uma resposta, ou precisar que você escolha, isso volta como um cartão.
Só os cartões precisam de você.

Se o cartão Como trabalhamos ainda estiver aberto, este cartão toma o lugar dele.
Ele aparece uma vez só.
Pressione **Entendi**; o trabalho continua, e enquanto isso você pode pedir outra coisa.
Veja [Sua primeira tarefa](/pt-br/your-first-task/).

## Adicionar seu primeiro projeto {#add-your-first-project}

Seu imediato precisa de um projeto para trabalhar.
O jeito mais fácil é um ponto de partida no cartão de boas-vindas, ou as mesmas palavras na sua própria mensagem.

**Trabalhar em uma pasta do meu computador** adiciona na hora a pasta que você escolher.
Para os outros pontos de partida, seu imediato mostra um cartão que diz o nome do projeto e como ele será configurado.
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
