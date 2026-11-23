---
source: 6298f79a1d1c8bf2
title: Um computador sem tela
description: Inicie o Infinitary por um comando em um servidor Linux ou outro computador em que ninguém se senta, para que seu imediato more lá, e controle-o do seu Mac, computador Linux ou PC com Windows.
---

Seu imediato pode morar em um computador em que ninguém se senta, como um servidor Linux que você aluga ou mantém em casa.
Lá, o Infinitary roda sem janela, iniciado por um comando.
Você controla seu imediato de outro computador: um Mac, um computador Linux ou um PC com Windows.

São quatro passos no computador sem tela e depois dois no seu outro computador:

1. Instalar o Infinitary lá.
2. Iniciá-lo com um comando.
3. Deixar seu outro computador entrar.
4. Criar um link.
5. Colar o link no Infinitary do seu outro computador.
6. Conectar uma assinatura a partir do seu outro computador.

## Do que você precisa {#what-you-need}

- **Um computador Linux com processador x64 e systemd**, como Ubuntu ou Fedora.
  No Ubuntu 24.04 ou 26.04 e no Fedora, o pacote traz todo o resto de que o Infinitary precisa lá.
- **Uma conta comum lá, não o root.**
  Faça login nessa conta por SSH para cada passo abaixo.
- **Uma rede em que os dois computadores estejam.**
  O Infinitary nunca abre um computador para a internet, então coloque os dois computadores na mesma rede privada, como o Tailscale, a menos que eles compartilhem uma rede local.
- **O Infinitary no seu outro computador, ainda não configurado.**
  Você entra no seu imediato a partir da primeira abertura dele.
  Se você já configurou um imediato lá, veja [Se seu outro computador já tem um imediato](#if-your-other-computer-already-has-a-first-mate).
- **Uma assinatura de IA.**
  Você faz login nela a partir do seu outro computador, no final.
  Se você usa o Claude, instale primeiro o Claude Code no computador sem tela.

## 1. Instalar o Infinitary {#1-install-infinitary}

Na [página de downloads](https://getinfinitary.com/downloads/#linux), copie o link do pacote para o sistema daquele computador.
Depois, no computador sem tela, baixe-o e instale-o.
No Ubuntu:

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

No Fedora, instale o .rpm do mesmo jeito, com `sudo dnf install ./infinitary-*.rpm`.
O pacote também instala o git e o Xvfb, de que o Infinitary precisa para rodar lá.

Em outro sistema Linux x64, baixe o AppImage e permita que ele seja executado com `chmod +x`.
Ele precisa do git, do Xvfb e do FUSE 2 instalados, e de bibliotecas que um desktop tem e que muitas vezes faltam em um servidor, como o GTK 3.
Onde esta página diz `infinitary`, digite o caminho do arquivo AppImage no lugar.

## 2. Iniciar {#2-start-it}

Como a conta que deve rodar seu imediato, execute:

```sh
infinitary start-at-boot
```

O Infinitary inicia agora, sem janela, e de novo sempre que essa conta fizer login.
O comando diz onde ler o que ele escreve.

Para que ele continue rodando depois que você sair, e para iniciá-lo sempre que o computador ligar, o comando também pode mostrar uma linha para um administrador executar uma vez:

```sh
sudo loginctl enable-linger <your account>
```

Execute essa linha se ela aparecer.
Para conferir se o Infinitary está rodando, use `infinitary status`.

Se o Infinitary disser que precisa do Xvfb, instale o Xvfb com o instalador de programas do seu sistema e execute o comando de novo.
Se ele disser que o computador não tem systemd para este usuário, `infinitary help run` lista outros jeitos de iniciá-lo.

## 3. Deixar seu outro computador entrar {#3-let-your-other-computer-in}

Seu outro computador alcança o Infinitary pela porta 47623.
Se houver um firewall ativado lá, libere essa porta uma vez.
Com o ufw, como no Ubuntu:

```sh
sudo ufw allow 47623/tcp
```

Com o firewalld, como no Fedora:

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. Criar um link {#4-make-a-link}

```sh
infinitary link
```

Ele mostra um link, com as palavras “Paste this link into Infinitary on your other computer, at its first launch.”
O link funciona uma vez, por dez minutos.
Execute o comando de novo para ter um novo.

## 5. Entrar a partir do seu outro computador {#5-join-from-your-other-computer}

1. Abra o Infinitary no seu outro computador pela primeira vez.
2. Escolha **Colar o link dele**, cole o link e pressione **Continuar**.
3. O Infinitary pergunta uma vez se você quer controlar seu imediato de lá.
   Pressione **Controlar daqui**.

Seu outro computador agora mostra seu imediato.
Os cartões, as tarefas e a conversa dele ficam no computador sem tela.

Em vez de um link, você pode escolher **Entrar pelo endereço** e digitar o endereço que você usa para fazer login naquele computador por SSH, como `you@vps`.
O Infinitary então pede sozinho um link ao Infinitary que roda lá.
A partir de um PC com Windows, aquele computador precisa aceitar sua chave SSH, já que um PC com Windows não pede senha.

## 6. Conectar uma assinatura {#6-connect-a-subscription}

A janela então diz “Conecte uma para o seu imediato em” e o nome daquele computador, e “O login é feito daqui.”
Escolha seu provedor e faça login do jeito que ele pedir, no computador em que você está.
Quando uma assinatura consegue responder, a caixa de mensagem se abre e seu imediato está pronto.
Veja [Primeira abertura](/pt-br/first-launch/#connect-a-subscription).

## Se seu outro computador já tem um imediato {#if-your-other-computer-already-has-a-first-mate}

Depois que uma assinatura responde em um computador, ele não mostra mais a primeira abertura, então não consegue colar um link.
Em vez disso, mantenha esse imediato e mude-o para o computador sem tela:

1. Adicione o computador sem tela a ele, como em [Adicionar um computador](/pt-br/your-other-computers/#add-a-computer).
2. No menu daquele computador, os três pontos na linha dele, escolha [Mudar seu imediato para cá](/pt-br/your-other-computers/#move-your-first-mate).

As tarefas, os cartões e a conversa dele vão junto.
Você faz login de novo nas suas assinaturas lá, e os [Segredos](/pt-br/secrets/) ficam no computador que ele deixa.

## Atualizar {#update-it}

Instale o pacote novo do mesmo jeito que no passo 1.
O Infinitary de lá percebe a nova versão, para e inicia de novo nela sozinho.

## Parar {#stop-it}

```sh
infinitary start-at-boot --off
```

Isso para o Infinitary lá e impede que ele inicie de novo.
O trabalho salvo do seu imediato fica naquele computador.

## Quando algo dá errado {#when-something-goes-wrong}

- **`infinitary link` diz “Infinitary is not running here, as this user.”**
  Inicie-o como no passo 2, com a mesma conta, e depois crie o link de novo.
- **Ele diz “Infinitary here controls your first mate on another computer.”**
  Aquele computador já se conectou a outro imediato; crie o link naquele outro computador.
- **Seu outro computador não consegue alcançar o endereço do link.**
  Confira se os dois computadores estão na mesma rede privada e se a porta 47623 está liberada, como no passo 3.
- **O Infinitary parou e você não sabe por quê.**
  `infinitary status` diz por que ele parou da última vez, e o log indicado por `infinitary start-at-boot` diz o resto.

Veja também [Seus outros computadores](/pt-br/your-other-computers/) e [Solução de problemas](/pt-br/troubleshooting/).
