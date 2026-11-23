---
source: 196a49ab4dfdf816
title: Automação
description: Dê ao seu imediato um pedido que roda em um horário marcado ou quando algo acontece, e pause, mude ou releia qualquer um deles em Ajustes.
---

Uma automação é um pedido que o seu imediato recebe em um horário marcado.
Você escreve o que dizer ao seu imediato e escolhe quando.
Quando chega a hora, seu imediato recebe o pedido e age como se você tivesse acabado de enviá-lo.

Você pode criar uma em Ajustes ou dizer ao seu imediato o que executar e quando.

## Onde ficam as automações {#where-automations-live}

Abra **Ajustes** e depois **Automação**.
Você também pode buscar **Abrir Automação** na busca de comandos.

A lista à esquerda mostra cada automação com o estado dela:

- **Em execução** roda no próximo horário.
- **Rascunho** está salva, mas nunca roda até você ativá-la.
- **Pausada** mantém seus ajustes, mas não roda.
- **Concluída** é uma automação de uma vez só que já rodou e está esperando o seu imediato tratá-la.

Escolha uma automação para lê-la ou mudá-la.
**Buscar automações** encontra uma pelo nome, pelo pedido ou por quando ela roda.

## Criar uma automação {#make-an-automation}

1. Abra **Ajustes**, depois **Automação**, e escolha **Nova automação**.
2. Dê a ela um **Nome**, como “Revisão semanal”.
3. Em **Quando**, escolha com que frequência ela roda.
4. Em **Projeto**, escolha o projeto de que ela trata, ou deixe **Sem projeto**.
5. Em **Diga ao seu imediato**, escreva o pedido.
6. Escolha **Salvar rascunho** para guardá-la para depois, ou **Ativar…** para verificá-la e ligá-la.

**Prévia** mostra os próximos três horários em que ela vai rodar, e o pedido do jeito que o seu imediato vai recebê-lo.
Nada é enviado.

## Quando ela roda {#when-it-runs}

- **Repete** roda a cada tantos minutos, no máximo a cada 15 minutos.
- **Todo dia** roda em um horário do dia.
- **Nos dias escolhidos** roda nos dias da semana que você escolher, em um horário do dia.
- **Uma vez** roda em uma data e um horário.
- **Quando algo acontece** roda sempre que algo novo acontece, como **Uma tarefa é encerrada**, ou um evento de algo que você conectou em Ajustes.

Uma automação diária ou semanal mantém o **Fuso horário** que você escolher, então ela roda no mesmo horário onde quer que o seu computador esteja.

Cada botão de **Inserir** abaixo do pedido põe um detalhe nele, como o horário para o qual ele estava previsto.
Cada detalhe é preenchido quando o pedido é enviado.

## Ativar {#turn-it-on}

Uma automação nova criada em Ajustes começa como rascunho.
Um rascunho nunca roda.

Quando você escolhe **Ativar…**, a página mostra o que vai acontecer antes que qualquer coisa rode:

- quando ela roda e em qual fuso horário,
- o projeto e o pedido exatamente como o seu imediato o recebe,
- os próximos horários em que ela roda,
- o que ela envia: o pedido e os detalhes do agendamento vão para a sua assinatura de IA e ficam na conversa do seu imediato, e nada mais ganha novo acesso,
- o que acontece com um horário perdido.

Escolha **Ativar** para iniciá-la, ou **Voltar** para retornar sem mudar nada.

Seu imediato também pode criar automações.
Uma automação que se repete e que o seu imediato cria por conta própria espera como rascunho até você ativá-la.

## Pausar, mudar ou excluir {#pause-change-or-delete}

- **Pausar** para uma automação em execução.
  Um pedido que ela ainda não tinha entregado é retirado.
- **Retomar** a inicia de novo a partir do próximo horário.
  Ela não recupera o tempo em que ficou pausada.
- **Pausar todas** pausa de uma vez todas as automações em execução.
  Ela não mexe nos rascunhos.
  Você também pode buscar **Pausar todas as automações** na busca de comandos.
- **Excluir** e depois **Excluir de vez** a remove junto com o histórico.
  As tarefas e os cartões que ela gerou ficam.

## Quando o Infinitary está fechado {#when-infinitary-is-closed}

As automações só rodam enquanto o Infinitary está aberto e o computador está acordado.
Se um horário passar enquanto ele está fechado, a automação roda uma vez quando o Infinitary abrir de novo, e o pedido diz quantas vezes ela perdeu.

## Histórico {#history}

Na página de uma automação, a aba **Histórico** lista as execuções dela, das mais recentes para as mais antigas.
Cada execução mostra em que pé está:

- **Aguardando**: seu imediato ainda não a tratou.
- **Tentando de novo**: seu imediato ainda não conseguiu recebê-la, e ela está sendo tentada de novo.
- **Tratada**: seu imediato a tratou.
- **Cancelada**: ela foi retirada antes que o seu imediato a lesse, por exemplo porque você pausou a automação.

Uma execução tratada mostra o que o seu imediato encontrou, depois de **Encontrado:**, e, em **Resultou em**, as tarefas e os cartões que ela gerou.
O histórico guarda as execuções por 30 dias.

## Notas {#notes}

Uma automação pode guardar **Notas** que as execuções escrevem para as próximas, para que a execução seguinte comece mais rápido.
Um tripulante que uma automação inicia as edita, e você também pode editá-las.
Elas são conselhos, nunca instruções.
**Versões anteriores** mostra cada versão passada e quem a escreveu.

## Continua rodando {#kept-running}

Embaixo da lista, **Continua rodando** mostra trabalhos que um tripulante configurou a seu pedido e que continuam rodando depois que a tarefa deles foi encerrada.
**Verificar** confere se um trabalho ainda roda, e **Remover** o tira dali.

## O painel Automação {#the-automation-panel}

Quando você tem uma automação, o painel **Automação** aparece na lateral da janela.
Ele lista o estado e a próxima execução de cada automação.
Clique em uma para abri-la em Ajustes.
Veja [Painéis](/pt-br/panels/).
