---
source: e1f49458875e9674
title: Assinaturas e franquia
description: Como adicionar suas assinaturas de IA, ver quanto ainda resta da franquia do seu plano e o que sua tripulação faz quando ela acaba.
---

Seu imediato e sua tripulação trabalham com as assinaturas de IA que você já tem.
Você as gerencia nos Ajustes, em **Inteligência**, na lista **Assinaturas de IA**.

## Adicionar uma assinatura {#add-a-subscription}

1. Abra os Ajustes e escolha **Inteligência**.
2. No pé de **Assinaturas de IA**, em **Adicionar conta**, escolha seu provedor: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter ou Amazon Bedrock.
3. Faça login do jeito que o provedor pedir.
   Alguns abrem seu navegador, alguns mostram um código para digitar no site deles, e alguns pedem uma chave que você cola.
4. Quando o login terminar, a nova conta aparece na lista.

Você pode adicionar mais de uma conta do mesmo provedor.
O botão passa então a dizer **Adicionar outra conta do Codex**, por exemplo.

## Dar nome às suas contas {#name-your-accounts}

Cada conta tem um rótulo, para você distinguir uma conta pessoal de uma de trabalho.
Quando o login não diz o nome da conta, abre-se uma caixa para você digitar um.
Para mudá-lo depois, abra o menu da conta e escolha **Renomear**.

Uma conta do Claude é diferente.
Ela segue o login do Claude Code no seu computador, então a linha dela mostra quem estiver com login feito ali no momento.
Ela não tem **Renomear**, e se você trocar o login do Claude Code, a linha acompanha.

## Ver a franquia do seu plano {#read-your-plans-allowance}

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Duas contas em Assinaturas de IA, Codex e Claude, cada uma com um medidor da sessão e um medidor semanal, e os botões Adicionar conta embaixo delas." width="1064" height="532" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Duas contas em Assinaturas de IA, Codex e Claude, cada uma com um medidor da sessão e um medidor semanal, e os botões Adicionar conta embaixo delas." width="1064" height="532" />

Cada conta mostra um pequeno medidor para cada franquia que o provedor dela tem, como a de uma sessão e a de uma semana.
O número é quanto resta.
Deixe o ponteiro sobre um medidor para ver quando ele renova.

- A barra fica âmbar quando você está à frente do relógio: gastando mais rápido do que um ritmo constante duraria até a renovação.
- O número fica âmbar abaixo da metade e vermelho abaixo de um quinto.
- Ao lado dos medidores, uma palavra resume a conta: **no ritmo**, **esgota em** um certo tempo, ou **esgotada**.
- **há 3 h** quer dizer que a última leitura está desatualizada, então os números dela ficam esmaecidos.
- Um traço quer dizer que aquela franquia não foi lida.

**Atualizar**, no topo da lista, lê todas as franquias de novo.
O Infinitary não lê a franquia do OpenRouter nem de uma API personalizada, e a linha avisa isso.
O Amazon Bedrock é cobrado pelo uso na sua conta da AWS; a linha dele mostra a estimativa deste mês a partir do trabalho que o Infinitary registrou.

## Escolher qual conta faz o quê {#choose-which-account-does-what}

Abra o menu de uma conta, os três pontos na linha dela, para estas opções.
As configurações vêm primeiro, cada uma com um interruptor que mostra se está ligada; escolher uma liga ou desliga e deixa o menu aberto.

- **Preferir para o trabalho da tripulação** faz sua tripulação usar esta conta primeiro.
  Um ✱ a marca.
- **Pausada** para todo o trabalho nesta conta enquanto o interruptor estiver ligado.
- **Desconectar** remove a conta do Infinitary.

Quando você tem duas ou mais contas do provedor que seu imediato usa, os Ajustes deixam você escolher em qual delas seu imediato responde.
Uma etiqueta **imediato** marca essa conta.

## Quando uma franquia acaba {#when-an-allowance-runs-out}

Sua tripulação segue em frente sozinha.
O trabalho novo vai para um modelo que ainda tem franquia.
Se não sobrar nenhum nesse nível, o trabalho da tripulação passa para um modelo mais fraco ou espera até a franquia renovar.

Quando a conta do próprio imediato acaba, ele primeiro passa para outra conta do mesmo provedor que ainda tenha franquia.
Se não houver nenhuma, um cartão diz **Seu imediato esgotou a franquia**.
Suas palavras esperam, e nada se perde.
No cartão, você pode escolher **Verificar a franquia de novo**, passar seu imediato para outro provedor ou **Abrir Ajustes**.
Se a verificação não encontrar mudança, o cartão também oferece tentar seu provedor de novo, como **Try Claude again**, para quando seu imediato chega a ele por outro login; se a franquia ainda estiver esgotada, ele pausa de novo.

Alguns provedores podem continuar respondendo com créditos que você configura com eles.
Em uma conta do Claude ou do Codex, o menu tem **Continuar com créditos**.
Sua tripulação então só gasta créditos depois de usar todas as franquias incluídas.
O Infinitary nunca compra créditos nem define o limite deles; quem faz isso é o próprio site do provedor.

## Fazer login de novo {#sign-in-again}

Um login pode expirar.
Quando isso acontece, a linha da conta diz **faça login de novo** e mostra um botão **Fazer login**.
Escolha-o e faça login do mesmo jeito que da primeira vez.
Isso renova a mesma conta, mantendo o rótulo e as escolhas dela.

## API personalizada {#custom-api}

Se a sua organização tem o próprio servidor de IA, escolha **API personalizada** em **Adicionar conta**.
Dê a ela um nome, o endereço do servidor, uma chave se ele precisar e os modelos a usar.
**Salvar** verifica cada modelo antes que sua tripulação possa usá-lo.
Depois, você escolhe no quadro **Modelos** se sua tripulação usa esses modelos.

## Uso {#usage}

Ajustes → **Uso** mostra quanto seu imediato e sua tripulação já usaram, somando todos os projetos.
Mostre em **Tokens** ou **$ estimados**, para um **Período** e para o tipo de **Trabalho**.
Os dólares estimados são uma referência de valor, não uma fatura.
**Tarefas recentes** lista o que cada tarefa usou.

Em **Inteligência**, **Perguntar antes que uma tarefa gaste mais de** define um valor.
Uma tarefa que passa dele para em um ponto seguro e pergunta a você em um cartão antes de gastar mais.
