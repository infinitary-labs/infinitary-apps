---
source: 3e64699c942fc0e5
title: Solução de problemas
description: Problemas comuns no Infinitary, as palavras que o app mostra para cada um e o que fazer.
---

Cada problema abaixo começa com as palavras que o Infinitary mostra para você.

## Uma assinatura precisa que você faça login de novo {#a-subscription-needs-you-to-sign-in-again}

Você pode ver um cartão chamado “Seu imediato precisa que você faça login de novo”, ou uma assinatura em Ajustes → **Inteligência** que diz “Faça login de novo.”
O trabalho nessa assinatura espera: “O trabalho está pausado até você fazer login de novo.”

1. Pressione **Fazer login** no cartão, ou abra Ajustes → **Inteligência**.
2. Faça login nessa assinatura do jeito que seu provedor pedir.
3. O trabalho que estava esperando continua sozinho.

Uma tarefa que roda em outro computador usa o login próprio daquele computador, então faça login de novo para aquele computador, sob o nome dele.

## A franquia do seu plano acabou {#your-plans-allowance-ran-out}

Seu imediato mostra um cartão chamado “Seu imediato usou toda a franquia”.
Uma resposta a um tripulante nessa assinatura diz “Salva, ainda não enviada”, com o momento em que a franquia renova.
O trabalho continua sozinho assim que ela renova.

Para continuar antes:

- Pressione **Verificar a franquia de novo** se você mudou algo do lado do seu provedor.
- Pressione **Mudar para** outro provedor, quando o cartão oferecer um.
- Peça ao seu imediato para passar o trabalho para outro modelo.

Ajustes → **Inteligência** mostra quanto resta da franquia de cada plano, e quando ela renova.
Para o Claude e o Codex, **Continuar com créditos** deixa uma conta seguir usando créditos configurados com seu provedor.

## Seu imediato não está respondendo {#your-first-mate-is-not-answering}

Se uma mensagem não trouxe nada de volta, um cartão diz “Seu imediato não respondeu à sua mensagem”.
Pressione **Perguntar de novo** para enviá-la mais uma vez, ou **Deixar assim**.

Se o próprio provedor não está respondendo, um cartão diz que ele “não está respondendo ao seu imediato agora”.
Pressione **Tentar o Claude de novo**, ou o mesmo botão com o nome do seu provedor, ou **Abrir Ajustes** para escolher outra assinatura.
Quando um provedor tem um problema passageiro, a Atividade avisa, e o app tenta de novo sozinho.

## Um tripulante está esperando {#a-crewmate-is-waiting}

Uma tarefa que diz **Aguardando você** tem um cartão para você.
Abra a tarefa, pressione **Mostrar o cartão** e decida.

Outras palavras em uma tarefa dizem o que a retém:

- “Aguardando as verificações”: o tripulante dela espera as verificações da solicitação de pull dela.
- “Tentando de novo no provedor”: o provedor falhou, e o app tenta de novo sozinho.
- “Travada no provedor”: o provedor recusou o mesmo pedido três vezes, e seu imediato está escolhendo o que fazer.
- “Bloqueada por outra tarefa”: ela começa assim que aquela tarefa terminar.

## As verificações falharam em uma solicitação de pull {#the-checks-failed-on-a-pull-request}

Quando as verificações falham, o tripulante que fez a solicitação de pull as corrige e traz uma nova versão.
Um cartão de mesclagem então oferece **Mesclar depois de corrigir os erros**.
Se você pressioná-lo, sua mesclagem fica guardada: “Sua mesclagem aguarda uma correção: as verificações falharam.”
Ela acontece assim que as verificações da correção passarem, ou o tripulante pergunta de novo em um novo cartão se a correção mudou o trabalho.

## Outro computador está fora de alcance {#another-computer-is-out-of-reach}

Uma janela em outro computador diz “Alterações desativadas até” o outro computador “voltar. Ele pode estar em repouso, ou em outra rede.”
Ou: “O Infinitary está fechado em” aquele computador.

1. Acorde o computador onde seu imediato mora e abra o Infinitary nele.
2. Coloque os dois computadores na mesma rede, ou na mesma rede privada.
3. Em Ajustes → **Dispositivos**, pressione **Tentar de novo** na linha dele.

Se um computador que você adicionou pelo endereço tiver um endereço novo, pressione **Mudar endereço** na linha dele.
No Mac, o macOS pode impedir o Infinitary de usar a rede local até que alguém naquele Mac permita.
A linha dele então oferece **Adicionar pelo endereço** no lugar.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

## A janela para de responder {#the-window-stops-answering}

Espere um momento primeiro.
Se ela continuar travada, encerre o Infinitary e abra-o de novo.
As mensagens que seu imediato ou um tripulante não tinham terminado são retomadas quando ele abre.

## O macOS pergunta sobre dados de outros apps {#macos-asks-about-other-apps-data}

O macOS pode perguntar “O Infinitary gostaria de acessar dados de outros apps.”
Isso acontece quando a busca de um tripulante alcança arquivos que outro app guarda.
O trabalho do Infinitary raramente precisa deles, então **Não Permitir** costuma ser suficiente.
O registro da tarefa diz que ela está “Aguardando o macOS” até você responder, e então a busca continua.

## O Claude Code não está instalado {#claude-code-is-missing}

Para usar uma assinatura do Claude, instale primeiro o Claude Code nesse computador.
Sem ele, o Infinitary diz “O Claude Code não está instalado neste computador. Instale-o para usar o Claude aqui.”
Se o seu for antigo demais, ele diz a versão necessária e pede para rodar `claude update`.
Em outro computador, o Claude Code faz login lá por conta própria: faça login nele lá uma vez, e o Infinitary usa esse login.

## Ainda com problemas {#still-stuck}

Veja [Obter ajuda](/pt-br/get-help/).
Conte o que você fez, o que esperava e o que aconteceu em vez disso.
