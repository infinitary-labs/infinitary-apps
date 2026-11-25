---
source: b09b575fa5a6a2c1
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

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Ajustes, seção Inteligência: duas contas em Assinaturas de IA, Codex e Claude, cada uma com um medidor da sessão e um medidor semanal, e uma redefinição salva na conta do Codex, depois os botões Adicionar conta, a linha Arquivo de conexões e Modelo do imediato." width="1048" height="524" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Ajustes, seção Inteligência: duas contas em Assinaturas de IA, Codex e Claude, cada uma com um medidor da sessão e um medidor semanal, e uma redefinição salva na conta do Codex, depois os botões Adicionar conta, a linha Arquivo de conexões e Modelo do imediato." width="1048" height="524" />

Cada conta mostra um pequeno medidor para cada franquia que o provedor dela tem, como a de uma sessão e a de uma semana.
O número é quanto resta.
Deixe o ponteiro sobre um medidor para ver quando ele renova.

- A barra fica âmbar quando você está à frente do relógio: gastando mais rápido do que um ritmo constante duraria até a renovação.
- O número fica âmbar abaixo da metade e vermelho abaixo de um quinto.
- Ao lado dos medidores, uma palavra resume a conta: **no ritmo**, **esgota em** um certo tempo, ou **esgotada**.
- **há 3 h** quer dizer que a última leitura está desatualizada, então os números dela ficam esmaecidos.
- Um traço quer dizer que aquela franquia não foi lida.
- Uma conta do Codex que tem [redefinições salvas](#saved-codex-resets) diz quantas, abaixo dos medidores dela.

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

### Redefinições salvas do Codex {#saved-codex-resets}

O ChatGPT pode dar redefinições salvas a uma conta do Codex.
Cada uma renova uma franquia antes que ela renove sozinha.
A linha da conta diz quantas ela tem e onde usar uma, como “1 redefinição salva · use em chatgpt.com”.

Enquanto uma puder ser usada agora, o menu da conta tem **Usar uma redefinição salva**.
O cartão que diz que uma franquia se esgotou também avisa isso, com o mesmo botão e um link para a página de uso em chatgpt.com.
O Infinitary então faz o Codex do seu computador usar a redefinição que vence primeiro.
Isso precisa do Codex 0.143 ou mais recente, e na primeira vez o Codex pede que você faça login nessa conta do ChatGPT.
Uma redefinição usada não pode ser recuperada.
A Atividade diz o que aconteceu e quantas restam.

O Infinitary também pode usá-las sem um clique seu.
Ative **Usar redefinições salvas por conta própria** no menu da conta, ou nesse cartão; isso fica desativado até você ativar.
O Infinitary então só usa uma quando há trabalho esperando e nenhuma conta tem franquia, e só quando esperar a franquia renovar levaria muito tempo.
As contas que ainda têm franquia sempre vêm primeiro.
A Atividade avisa cada vez que ele usa uma.

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

### Conexões de um arquivo {#connections-from-a-file}

Se você já guarda suas conexões em um arquivo no formato `models.json` do Pi, o Infinitary pode lê-las dele.
Na linha **Arquivo de conexões**, em **Assinaturas de IA**, pressione **Escolher arquivo** e selecione o arquivo.
O Infinitary só lê o arquivo: nunca o altera e nunca usa uma chave escrita nele.

Cada conexão que o arquivo define aparece marcada com **Do seu arquivo** e **Ainda não aprovada**.
Pressione **Aprovar**, digite a chave própria deste computador e qualquer tamanho de modelo que o arquivo omita, e depois **Salvar**, que verifica cada modelo.

Depois disso, o Infinitary acompanha o arquivo.
Um nome ou preço novo vale na hora, e um limite alterado faz esse modelo ser verificado de novo.
Um endereço, protocolo ou cabeçalho alterado pausa a conexão até você pressionar **Aprovar de novo**.
Uma conexão que sai do arquivo é pausada, nunca excluída.
**Parar de ler** deixa de acompanhar o arquivo, e as conexões que você aprovou ficam.

### Nos seus outros computadores {#on-your-other-computers}

Quando outro computador roda trabalho para você, a linha de uma conexão personalizada oferece **Usar**, com o nome desse computador.
Você digita a chave própria desse computador, e ele verifica cada modelo e guarda a chave ele mesmo; este computador não guarda nenhuma cópia.
Mudanças feitas depois na conexão também chegam lá.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

## Uso {#usage}

Ajustes → **Uso** mostra quanto seu imediato e sua tripulação já usaram, somando todos os projetos.
A seção abre em **$ estimados**; em **Mostrar o uso em**, você pode mudar para **Tokens**.
Escolha um **Período** e o tipo de **Trabalho** a contar.
Os dólares estimados são uma referência de valor, não uma fatura.

**Custo por tarefa** mostra em um gráfico quanto custa uma tarefa concluída, incluindo as revisões dela.
Cada ponto é a mediana das tarefas concluídas nos sete dias anteriores a ele, e a faixa mostra a metade central delas.
Uma linha que sobe indica que as tarefas estão exigindo mais trabalho do que antes.
**Projetos** e **Tipos** restringem o gráfico ao trabalho que você quer comparar.

**Tarefas recentes** lista o que cada tarefa usou.

Em **Inteligência**, **Perguntar antes que uma tarefa gaste mais de** define um valor.
Uma tarefa que passa dele para em um ponto seguro e pergunta a você em um cartão antes de gastar mais.
